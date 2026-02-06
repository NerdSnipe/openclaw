import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type MigrationManifest,
  buildMemoryStub,
  chunkMemoryMarkdown,
  chunkSessionFile,
  isSessionFile,
  loadManifest,
  runMigration,
  saveManifest,
} from "./migrate.js";

// ============================================================================
// Helpers
// ============================================================================

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mem0-migrate-test-"));
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================================
// chunkMemoryMarkdown
// ============================================================================

describe("chunkMemoryMarkdown", () => {
  test("splits by heading sections", () => {
    const content = `## Preferences

- I prefer dark mode
- I use Vim keybindings

## Decisions

- We chose PostgreSQL for the database`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toBe("- I prefer dark mode");
    expect(chunks[0].category).toBe("Preferences");
    expect(chunks[1].text).toBe("- I use Vim keybindings");
    expect(chunks[2].category).toBe("Decisions");
  });

  test("extracts individual list items within sections", () => {
    const content = `## Tools

- ESLint for linting
- Prettier for formatting
- Vitest for testing`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toBe("- ESLint for linting");
    expect(chunks[1].text).toBe("- Prettier for formatting");
    expect(chunks[2].text).toBe("- Vitest for testing");
  });

  test("keeps code blocks intact with context", () => {
    const content = `## Config Pattern

The standard config looks like this:

\`\`\`json
{
  "apiUrl": "http://localhost:8080",
  "autoCapture": true
}
\`\`\``;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    // Paragraph and code block should be separate chunks
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const codeChunk = chunks.find((c) => c.text.includes("```json"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk?.text).toContain('"apiUrl"');
  });

  test("handles horizontal rule separators", () => {
    const content = `Some text about topic A with enough content to be captured.

---

Some text about topic B with enough content to be captured.`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).toContain("topic A");
    expect(chunks[1].text).toContain("topic B");
  });

  test("discards chunks under 10 chars", () => {
    const content = `## Section

Hi

- This is a real memory item that should be kept`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("real memory item");
  });

  test("splits oversized chunks at paragraph boundaries", () => {
    const long = Array(30)
      .fill("This is a paragraph with enough text to contribute to the overall size of the chunk.")
      .join("\n\n");
    const content = `## Big Section\n\n${long}`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2200); // some tolerance
    }
  });

  test("handles empty file gracefully", () => {
    const chunks = chunkMemoryMarkdown("", "MEMORY.md");
    expect(chunks.length).toBe(0);
  });

  test("handles file with only frontmatter", () => {
    const content = `---
title: Memory
---`;
    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(0);
  });

  test("preserves heading hierarchy as category", () => {
    const content = `# Top Level

## Sub Section

- A preference item that is long enough to keep`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(1);
    expect(chunks[0].category).toBe("Sub Section");
  });

  test("handles list items with continuation lines", () => {
    const content = `## Notes

- First item spans
  multiple lines here
- Second standalone item is here`;

    const chunks = chunkMemoryMarkdown(content, "MEMORY.md");
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).toContain("multiple lines");
  });
});

// ============================================================================
// chunkSessionFile
// ============================================================================

describe("chunkSessionFile", () => {
  test("extracts metadata section as one chunk", () => {
    // Content must exceed 1000 chars to trigger section-based chunking
    const conversationLines: string[] = [];
    for (let i = 0; i < 20; i++) {
      conversationLines.push(
        `User: This is message number ${i} with enough text to make the content large enough`,
      );
      conversationLines.push(
        `Assistant: This is response number ${i} with enough detail to pad the content`,
      );
    }
    const content = `# Session: 2026-02-06 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

## Conversation Summary

${conversationLines.join("\n")}`;

    const chunks = chunkSessionFile(content, "memory/2026-02-06-test.md");
    const metaChunk = chunks.find((c) => c.category === "session-metadata");
    expect(metaChunk).toBeDefined();
    expect(metaChunk?.text).toContain("Session Key");
  });

  test("groups conversation exchanges into chunks", () => {
    const lines = ["# Session: 2026-02-06", "", "## Conversation Summary", ""];
    for (let i = 0; i < 30; i++) {
      lines.push(`User: Message ${i}`);
      lines.push(`Assistant: Response ${i}`);
    }
    const content = lines.join("\n");

    const chunks = chunkSessionFile(content, "memory/2026-02-06-chat.md");
    const convChunks = chunks.filter((c) => c.category === "session-conversation");
    expect(convChunks.length).toBeGreaterThan(1);
  });

  test("handles file without conversation summary", () => {
    const content = `# Session: 2026-02-06

- **Key**: value
- **Another**: important item here that is long enough`;

    const chunks = chunkSessionFile(content, "memory/2026-02-06-meta.md");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("imports small files as single chunk", () => {
    const content = "User prefers dark mode and uses Vim keybindings for all editors.";

    const chunks = chunkSessionFile(content, "memory/2026-02-06-small.md");
    expect(chunks.length).toBe(1);
    expect(chunks[0].category).toBe("session");
  });

  test("returns empty for tiny files", () => {
    const chunks = chunkSessionFile("Hi", "memory/2026-02-06-tiny.md");
    expect(chunks.length).toBe(0);
  });
});

// ============================================================================
// isSessionFile
// ============================================================================

describe("isSessionFile", () => {
  test("identifies YYYY-MM-DD prefixed files", () => {
    expect(isSessionFile("2026-02-06-chat.md")).toBe(true);
    expect(isSessionFile("2025-12-31-review.md")).toBe(true);
  });

  test("rejects MEMORY.md", () => {
    expect(isSessionFile("MEMORY.md")).toBe(false);
    expect(isSessionFile("memory.md")).toBe(false);
    expect(isSessionFile("notes.md")).toBe(false);
  });
});

// ============================================================================
// Manifest
// ============================================================================

describe("loadManifest / saveManifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty manifest for missing file", async () => {
    const manifest = await loadManifest(tmpDir);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.files)).toHaveLength(0);
  });

  test("roundtrips manifest correctly", async () => {
    const original: MigrationManifest = {
      version: 1,
      files: {
        "MEMORY.md": { hash: "abc123", chunks: 5, migratedAt: "2026-02-06T00:00:00Z" },
      },
    };
    await saveManifest(tmpDir, original);
    const loaded = await loadManifest(tmpDir);
    expect(loaded).toEqual(original);
  });
});

// ============================================================================
// buildMemoryStub
// ============================================================================

describe("buildMemoryStub", () => {
  test("includes migration timestamp and backup path", () => {
    const stub = buildMemoryStub("2026-02-06T14:30:00Z", "/path/to/MEMORY.md.bak.123");
    expect(stub).toContain("2026-02-06T14:30:00Z");
    expect(stub).toContain("MEMORY.md.bak.123");
    expect(stub).toContain("## Quick Notes");
  });
});

// ============================================================================
// runMigration
// ============================================================================

describe("runMigration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockClient() {
    return {
      health: vi.fn().mockResolvedValue({ status: "ok" }),
      addMemory: vi.fn().mockResolvedValue({ success: true, short_term: true, long_term: false }),
      addMemoryBatch: vi.fn().mockResolvedValue({ succeeded: 3, failed: 0, errors: [] }),
      search: vi.fn(),
      promote: vi.fn(),
      getUserMemories: vi.fn(),
      getAgentMemories: vi.fn(),
      deleteMemory: vi.fn(),
      getUserProfile: vi.fn(),
      updateUserProfile: vi.fn(),
      getAgentProfile: vi.fn(),
      updateAgentProfile: vi.fn(),
      stats: vi.fn(),
      history: vi.fn(),
    };
  }

  function baseOpts(client: ReturnType<typeof mockClient>) {
    return {
      workspaceDir: tmpDir,
      client: client as unknown as import("./client.js").Mem0ApiClient,
      userId: "test-user",
      agentId: "test-agent",
      dryRun: false,
      skipBackup: false,
      archive: false,
      keepMemoryMd: false,
      batchSize: 5,
      delayMs: 0,
      verbose: false,
      logger: silentLogger,
    };
  }

  test("dry-run does not call addMemoryBatch", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "## Prefs\n\n- I prefer dark mode in all editors",
    );
    const client = mockClient();

    const result = await runMigration({ ...baseOpts(client), dryRun: true });

    expect(client.addMemoryBatch).not.toHaveBeenCalled();
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksTotal).toBe(1);
    expect(result.chunksSent).toBe(0);
  });

  test("skips files in manifest with matching hash", async () => {
    const content = "## Prefs\n\n- I prefer dark mode in all editors";
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), content);

    // Pre-populate manifest with matching hash
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(content).digest("hex");
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "memory", ".mem0-migrated.json"),
      JSON.stringify({
        version: 1,
        files: { "MEMORY.md": { hash, chunks: 1, migratedAt: "2026-02-06T00:00:00Z" } },
      }),
    );

    const client = mockClient();
    const result = await runMigration(baseOpts(client));

    expect(result.filesSkipped).toBe(1);
    expect(result.filesProcessed).toBe(0);
    expect(client.addMemoryBatch).not.toHaveBeenCalled();
  });

  test("re-migrates files with changed hash", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "## Updated\n\n- New preference for light mode now",
    );

    // Pre-populate manifest with old hash
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "memory", ".mem0-migrated.json"),
      JSON.stringify({
        version: 1,
        files: { "MEMORY.md": { hash: "old-hash", chunks: 1, migratedAt: "2026-01-01T00:00:00Z" } },
      }),
    );

    const client = mockClient();
    const result = await runMigration(baseOpts(client));

    expect(result.filesProcessed).toBe(1);
    expect(client.addMemoryBatch).toHaveBeenCalled();
  });

  test("creates backups before sending", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "## Notes\n\n- Important fact to remember here",
    );
    const client = mockClient();

    await runMigration(baseOpts(client));

    // Check that a .bak file was created
    const entries = await fs.readdir(tmpDir);
    const backups = entries.filter((e) => e.startsWith("MEMORY.md.bak."));
    expect(backups.length).toBe(1);
  });

  test("rewrites MEMORY.md to stub", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "## Old Memories\n\n- Something I used to remember here",
    );
    const client = mockClient();

    await runMigration(baseOpts(client));

    const newContent = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(newContent).toContain("Migrated to mem0");
    expect(newContent).toContain("## Quick Notes");
  });

  test("respects --keep-memory-md flag", async () => {
    const original = "## Keep Me\n\n- I should stay exactly as I am right now";
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), original);
    const client = mockClient();

    await runMigration({ ...baseOpts(client), keepMemoryMd: true });

    const content = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(content).toBe(original);
  });

  test("respects --archive flag for session files", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, "2026-02-06-chat.md"),
      "# Session: 2026-02-06\n\n- **Key**: val\n\n## Conversation Summary\n\nUser: Hello there friend\nAssistant: Hi back to you!",
    );
    const client = mockClient();

    await runMigration({ ...baseOpts(client), archive: true, keepMemoryMd: true });

    const archiveEntries = await fs.readdir(path.join(memDir, "archive"));
    expect(archiveEntries).toContain("2026-02-06-chat.md");
  });

  test("handles addMemoryBatch failures gracefully", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "## Error Test\n\n- This will fail during batch send",
    );
    const client = mockClient();
    client.addMemoryBatch.mockResolvedValue({
      succeeded: 0,
      failed: 1,
      errors: ["Connection refused"],
    });

    const result = await runMigration(baseOpts(client));

    expect(result.chunksFailed).toBe(1);
    expect(result.errors).toContain("Connection refused");
    // Should still complete without throwing
    expect(result.filesProcessed).toBe(1);
  });
});
