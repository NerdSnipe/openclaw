/**
 * Memory migration pipeline: workspace markdown → mem0 Docker stack.
 *
 * Reads MEMORY.md and memory/*.md files from the workspace,
 * chunks them into discrete memory items, sends each to mem0,
 * backs up originals, and rewrites MEMORY.md to a slim stub.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Mem0ApiClient } from "./client.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryChunkSource = {
  file: string; // relative path from workspace
  heading?: string; // nearest parent heading
  startLine: number;
  endLine: number;
};

export type MemoryChunk = {
  text: string;
  source: MemoryChunkSource;
  category?: string; // derived from heading hierarchy
};

export type MigrationManifestEntry = {
  hash: string; // SHA-256 of file content at migration time
  chunks: number;
  migratedAt: string; // ISO timestamp
};

export type MigrationManifest = {
  version: 1;
  files: Record<string, MigrationManifestEntry>;
};

export type MigrateOptions = {
  workspaceDir: string;
  client: Mem0ApiClient;
  userId: string;
  agentId: string;
  dryRun: boolean;
  skipBackup: boolean;
  archive: boolean;
  keepMemoryMd: boolean;
  batchSize: number;
  delayMs: number;
  verbose: boolean;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export type MigrateResult = {
  filesProcessed: number;
  filesSkipped: number;
  chunksTotal: number;
  chunksSent: number;
  chunksFailed: number;
  errors: string[];
};

// ============================================================================
// Constants
// ============================================================================

const MANIFEST_FILENAME = ".mem0-migrated.json";
const MEMORY_FILENAMES = ["MEMORY.md", "memory.md"];
const MEMORY_DIR = "memory";
const MIN_CHUNK_LENGTH = 10;
const MAX_CHUNK_LENGTH = 2000;

// ============================================================================
// Manifest
// ============================================================================

export async function loadManifest(workspaceDir: string): Promise<MigrationManifest> {
  const manifestPath = path.join(workspaceDir, MEMORY_DIR, MANIFEST_FILENAME);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as MigrationManifest;
  } catch {
    return { version: 1, files: {} };
  }
}

export async function saveManifest(
  workspaceDir: string,
  manifest: MigrationManifest,
): Promise<void> {
  const memoryDir = path.join(workspaceDir, MEMORY_DIR);
  await fs.mkdir(memoryDir, { recursive: true });
  const manifestPath = path.join(memoryDir, MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

// ============================================================================
// Hashing
// ============================================================================

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Chunking — MEMORY.md (heading-aware)
// ============================================================================

/**
 * Strip optional YAML front-matter delimited by --- lines.
 */
function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return content;
  }
  return content.slice(endIdx + 4).trimStart();
}

/**
 * Chunk a curated MEMORY.md file into discrete memory items.
 *
 * Strategy: headings define sections/categories, list items and paragraphs
 * become individual chunks. Code blocks are kept intact with context.
 */
export function chunkMemoryMarkdown(content: string, filePath: string): MemoryChunk[] {
  const stripped = stripFrontMatter(content);
  const lines = stripped.split("\n");
  const chunks: MemoryChunk[] = [];

  let currentHeading = "";
  let currentCategory = "";
  let accum: string[] = [];
  let accumStart = 0;
  let inCodeBlock = false;

  function flushAccum(endLine: number): void {
    const text = accum.join("\n").trim();
    if (text.length >= MIN_CHUNK_LENGTH) {
      pushChunk(text, accumStart, endLine);
    }
    accum = [];
  }

  function pushChunk(text: string, startLine: number, endLine: number): void {
    // Split oversized chunks at paragraph boundaries
    if (text.length > MAX_CHUNK_LENGTH) {
      const paragraphs = text.split(/\n\n+/);
      let buf = "";
      let bufStart = startLine;
      for (const para of paragraphs) {
        if (buf.length + para.length > MAX_CHUNK_LENGTH && buf.length >= MIN_CHUNK_LENGTH) {
          chunks.push({
            text: buf.trim(),
            source: { file: filePath, heading: currentHeading, startLine: bufStart, endLine },
            category: currentCategory,
          });
          buf = "";
          bufStart = endLine; // approximate
        }
        buf += (buf ? "\n\n" : "") + para;
      }
      if (buf.trim().length >= MIN_CHUNK_LENGTH) {
        chunks.push({
          text: buf.trim(),
          source: { file: filePath, heading: currentHeading, startLine: bufStart, endLine },
          category: currentCategory,
        });
      }
      return;
    }

    chunks.push({
      text,
      source: { file: filePath, heading: currentHeading, startLine, endLine },
      category: currentCategory,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks (fenced)
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      accum.push(line);
      if (accum.length === 1) {
        accumStart = i;
      }
      continue;
    }

    if (inCodeBlock) {
      accum.push(line);
      continue;
    }

    // Heading — flush previous section
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushAccum(i - 1);
      currentHeading = headingMatch[2].trim();
      currentCategory = currentHeading;
      accumStart = i + 1;
      continue;
    }

    // Horizontal rule — section separator
    if (/^---+\s*$/.test(line)) {
      flushAccum(i - 1);
      accumStart = i + 1;
      continue;
    }

    // List item — each top-level item becomes a chunk
    if (/^[-*]\s+/.test(line)) {
      // Flush any non-list accumulated text first
      if (accum.length > 0 && !accum[0].match(/^[-*]\s+/)) {
        flushAccum(i - 1);
      }

      // If there's already a list item accumulated, flush it
      if (accum.length > 0 && accum[0].match(/^[-*]\s+/)) {
        flushAccum(i - 1);
      }

      accum = [line];
      accumStart = i;
      continue;
    }

    // Continuation of a list item (indented)
    if (/^\s{2,}/.test(line) && accum.length > 0 && accum[0].match(/^[-*]\s+/)) {
      accum.push(line);
      continue;
    }

    // Empty line — flush if accumulating
    if (line.trim() === "") {
      if (accum.length > 0) {
        flushAccum(i - 1);
      }
      accumStart = i + 1;
      continue;
    }

    // Regular paragraph line
    if (accum.length === 0) {
      accumStart = i;
    }
    accum.push(line);
  }

  // Flush remaining
  if (accum.length > 0) {
    flushAccum(lines.length - 1);
  }

  return chunks;
}

// ============================================================================
// Chunking — Session files (memory/YYYY-MM-DD-*.md)
// ============================================================================

/**
 * Check if a filename looks like a dated session file.
 */
export function isSessionFile(filename: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(filename);
}

/**
 * Chunk a session transcript file into memory items.
 *
 * Session files follow the format produced by the session-memory hook:
 * # Session: <date>
 * - **Session Key**: ...
 * - **Session ID**: ...
 * ## Conversation Summary
 * <messages>
 */
export function chunkSessionFile(content: string, filePath: string): MemoryChunk[] {
  const stripped = stripFrontMatter(content);

  // Small files → single chunk
  if (stripped.length < 1000) {
    const text = stripped.trim();
    if (text.length < MIN_CHUNK_LENGTH) {
      return [];
    }
    return [
      {
        text,
        source: { file: filePath, heading: "session", startLine: 0, endLine: 0 },
        category: "session",
      },
    ];
  }

  const chunks: MemoryChunk[] = [];
  const lines = stripped.split("\n");

  // Find the conversation summary section
  let summaryStart = -1;
  const metadataLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Conversation/i.test(lines[i])) {
      summaryStart = i + 1;
      break;
    }
    metadataLines.push(lines[i]);
  }

  // Metadata section as one chunk
  const metaText = metadataLines.join("\n").trim();
  if (metaText.length >= MIN_CHUNK_LENGTH) {
    chunks.push({
      text: metaText,
      source: {
        file: filePath,
        heading: "session metadata",
        startLine: 0,
        endLine: summaryStart - 1,
      },
      category: "session-metadata",
    });
  }

  // No conversation section found — return what we have
  if (summaryStart === -1) {
    return chunks;
  }

  // Group conversation lines into chunks of ~5 exchanges
  const conversationLines = lines.slice(summaryStart);
  const exchangeSize = 10; // ~5 user/assistant pairs = ~10 lines
  for (let i = 0; i < conversationLines.length; i += exchangeSize) {
    const group = conversationLines.slice(i, i + exchangeSize);
    const text = group.join("\n").trim();
    if (text.length >= MIN_CHUNK_LENGTH) {
      chunks.push({
        text,
        source: {
          file: filePath,
          heading: "conversation",
          startLine: summaryStart + i,
          endLine: summaryStart + i + group.length - 1,
        },
        category: "session-conversation",
      });
    }
  }

  return chunks;
}

// ============================================================================
// Backup
// ============================================================================

export async function backupFile(
  absPath: string,
  archive: boolean,
  archiveDir: string,
): Promise<string> {
  const timestamp = Date.now();

  if (archive) {
    await fs.mkdir(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, path.basename(absPath));
    await fs.copyFile(absPath, dest);
    return dest;
  }

  const dest = `${absPath}.bak.${timestamp}`;
  await fs.copyFile(absPath, dest);
  return dest;
}

// ============================================================================
// Post-migration stub
// ============================================================================

export function buildMemoryStub(timestamp: string, backupPath: string): string {
  return `# Memory

> Migrated to mem0 on ${timestamp}. Memories are now in the mem0 Docker stack.
> Search: \`openclaw mem0 search <query>\` | Add: use memory_store tool
> Backup: ${path.basename(backupPath)}

## Quick Notes

_Temporary notes not yet captured by mem0._
`;
}

// ============================================================================
// File discovery
// ============================================================================

async function discoverFiles(workspaceDir: string): Promise<string[]> {
  const files: string[] = [];

  // Check MEMORY.md / memory.md
  for (const name of MEMORY_FILENAMES) {
    const p = path.join(workspaceDir, name);
    try {
      await fs.access(p);
      files.push(p);
      break; // only take the first match
    } catch {
      // not found
    }
  }

  // Check memory/*.md
  const memoryDir = path.join(workspaceDir, MEMORY_DIR);
  try {
    const entries = await fs.readdir(memoryDir);
    for (const entry of entries.toSorted()) {
      if (entry.endsWith(".md") && !entry.startsWith(".")) {
        files.push(path.join(memoryDir, entry));
      }
    }
  } catch {
    // memory/ dir may not exist
  }

  return files;
}

// ============================================================================
// Main pipeline
// ============================================================================

export async function runMigration(opts: MigrateOptions): Promise<MigrateResult> {
  const { workspaceDir, client, logger } = opts;
  const result: MigrateResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    chunksTotal: 0,
    chunksSent: 0,
    chunksFailed: 0,
    errors: [],
  };

  // 1. Discover files
  const files = await discoverFiles(workspaceDir);
  if (files.length === 0) {
    logger.info("No memory files found in workspace.");
    return result;
  }

  logger.info(`Found ${files.length} memory file(s) in ${workspaceDir}`);

  // 2. Load manifest for idempotency
  const manifest = await loadManifest(workspaceDir);
  let memoryMdBackupPath = "";

  // 3. Process each file
  for (const absPath of files) {
    const relPath = path.relative(workspaceDir, absPath);
    const content = await fs.readFile(absPath, "utf-8");
    const hash = sha256(content);

    // Check manifest — skip if already migrated with same hash
    const existing = manifest.files[relPath];
    if (existing && existing.hash === hash) {
      if (opts.verbose) {
        logger.info(`  skip: ${relPath} (already migrated, hash unchanged)`);
      }
      result.filesSkipped++;
      continue;
    }

    // Chunk the file
    const filename = path.basename(absPath);
    const isSession = isSessionFile(filename);
    const isMemoryMd = MEMORY_FILENAMES.includes(filename);
    const chunks = isSession
      ? chunkSessionFile(content, relPath)
      : chunkMemoryMarkdown(content, relPath);

    if (chunks.length === 0) {
      if (opts.verbose) {
        logger.info(`  skip: ${relPath} (no chunks extracted)`);
      }
      result.filesSkipped++;
      continue;
    }

    result.chunksTotal += chunks.length;

    if (opts.verbose) {
      logger.info(`  file: ${relPath} → ${chunks.length} chunk(s)`);
    }

    // Dry-run: print chunks and skip
    if (opts.dryRun) {
      for (const chunk of chunks) {
        logger.info(
          `    [${chunk.category ?? ""}] ${chunk.text.slice(0, 80)}${chunk.text.length > 80 ? "..." : ""}`,
        );
      }
      result.filesProcessed++;
      continue;
    }

    // Backup the file
    if (!opts.skipBackup) {
      const archiveDir = path.join(workspaceDir, MEMORY_DIR, "archive");
      const backupDest = await backupFile(absPath, opts.archive && !isMemoryMd, archiveDir);
      if (isMemoryMd) {
        memoryMdBackupPath = backupDest;
      }
      if (opts.verbose) {
        logger.info(`  backup: ${backupDest}`);
      }
    }

    // Send chunks to mem0 with metadata
    const batchChunks = chunks.map((chunk) => ({
      text: chunk.text,
      metadata: {
        source: "workspace-migration",
        sourceFile: chunk.source.file,
        sourceHeading: chunk.source.heading ?? "",
        sourceLines: `${chunk.source.startLine}-${chunk.source.endLine}`,
        migratedAt: new Date().toISOString(),
        category: chunk.category ?? "",
      },
    }));

    const batchResult = await client.addMemoryBatch({
      chunks: batchChunks,
      userId: opts.userId,
      agentId: opts.agentId,
      batchSize: opts.batchSize,
      delayMs: opts.delayMs,
      onProgress: opts.verbose
        ? (done, total) => logger.info(`    progress: ${done}/${total}`)
        : undefined,
    });

    result.chunksSent += batchResult.succeeded;
    result.chunksFailed += batchResult.failed;
    result.errors.push(...batchResult.errors);
    result.filesProcessed++;

    // Update manifest
    manifest.files[relPath] = {
      hash,
      chunks: chunks.length,
      migratedAt: new Date().toISOString(),
    };
  }

  // 4. Rewrite MEMORY.md to stub (unless dry-run or --keep-memory-md)
  if (!opts.dryRun && !opts.keepMemoryMd) {
    for (const name of MEMORY_FILENAMES) {
      const p = path.join(workspaceDir, name);
      try {
        await fs.access(p);
        const stub = buildMemoryStub(new Date().toISOString(), memoryMdBackupPath || `${name}.bak`);
        await fs.writeFile(p, stub, "utf-8");
        logger.info(`Rewrote ${name} to migration stub.`);
        break;
      } catch {
        // not found, try next
      }
    }
  }

  // 5. Save manifest
  if (!opts.dryRun) {
    await saveManifest(workspaceDir, manifest);
  }

  return result;
}
