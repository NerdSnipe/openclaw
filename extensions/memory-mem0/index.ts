/**
 * OpenClaw Memory (mem0) Plugin
 *
 * Multi-tier memory via a Docker-based mem0 stack:
 * - Redis: short-term/working memory (fast, ephemeral)
 * - Qdrant: long-term vector memory (persistent embeddings)
 * - Neo4j: graph memory (entity relationships)
 * - Postgres: audit logs, profiles, metadata
 *
 * The TypeScript plugin is a thin HTTP client; all heavy lifting
 * (embeddings, fact extraction, graph updates) happens server-side.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringEnum } from "openclaw/plugin-sdk";
import type { MemoryCategory } from "./config.js";
import { Mem0ApiClient, type Mem0AddResult } from "./client.js";
import { mem0ConfigSchema } from "./config.js";

// ============================================================================
// Constants
// ============================================================================

const MEMORY_SCOPES = ["user", "agent", "all"] as const;
const STORE_SCOPES = ["user", "agent"] as const;

// ============================================================================
// Rule-based capture filter (same pattern as memory-lancedb)
// ============================================================================

const MEMORY_TRIGGERS = [
  /\b(remember|zapamatuj si|pamatuj)\b/i,
  /\b(i prefer|i'd prefer|radši|nechci|preferuji)\b/i,
  /\b(decided|rozhodli jsme|budeme používat)\b/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my|můj\s+\w+\s+je|je\s+můj/i,
  /\bi (like|prefer|hate|love|want|need)\b/i,
];

/** Phrases at the start of a message that indicate transient/procedural text, not memories. */
const TRANSIENT_PREFIXES = [
  /^(I'll|Let me|Here's|I'm going to|Sure,|OK,|Okay,|I can|I've|I will|Let's)/i,
  /^(Searching|Looking|Reading|Checking|Running|Updating|Creating|Generating)/i,
];

/**
 * Check whether a message fragment should be auto-captured.
 * Accepts an optional `maxChars` ceiling (default 500); input up to
 * 3x that limit is allowed (it will be truncated at storage time).
 * Only user messages should be passed here (assistant messages are filtered upstream).
 */
function shouldCapture(text: string, maxChars = 500): boolean {
  // Too short or too long
  if (text.length < 20 || text.length > maxChars * 3) {
    return false;
  }
  // Questions are not memories
  if (text.trimEnd().endsWith("?")) {
    return false;
  }
  // Skip transient/procedural phrases
  if (TRANSIENT_PREFIXES.some((r) => r.test(text))) {
    return false;
  }
  // Skip XML-like content
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  // Skip formatted/structured content (markdown lists)
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  // Skip emoji-heavy content
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

// ============================================================================
// Category detection
// ============================================================================

const CATEGORY_PATTERNS: ReadonlyArray<{ category: MemoryCategory; patterns: RegExp[] }> = [
  {
    category: "preference",
    patterns: [
      /i (prefer|like|love|hate|want|need)/i,
      /prefer|radši|nechci|preferuji/i,
      /dark mode|light mode|theme|font|editor|layout/i,
      /always|never/i,
    ],
  },
  {
    category: "contact",
    patterns: [/\+\d{10,}/, /[\w.-]+@[\w.-]+\.\w+/, /phone|email|address|contact/i],
  },
  {
    category: "decision",
    patterns: [
      /decided|chose|we.*(will|are going to)|rozhodli|budeme/i,
      /decision|agreed|settled on/i,
    ],
  },
  {
    category: "fact",
    patterns: [/my\s+\w+\s+is|is\s+my|můj\s+\w+\s+je/i, /born|birthday|age|lives? in|works? at/i],
  },
  {
    category: "skill",
    patterns: [
      /can (use|code|write|build|deploy)/i,
      /know(s)? (how to|about)/i,
      /experience with|proficient in/i,
    ],
  },
  {
    category: "relationship",
    patterns: [
      /\b(wife|husband|partner|friend|colleague|boss|manager|team)\b/i,
      /works? with|reports? to/i,
    ],
  },
];

/** Detect the most likely category for a memory text. Falls back to "context". */
export function detectCategory(text: string): MemoryCategory {
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((p) => p.test(text))) {
      return category;
    }
  }
  return "context";
}

// ============================================================================
// Sentence-aware truncation
// ============================================================================

/** Truncate text at the nearest sentence boundary without exceeding maxChars. */
export function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = text.slice(0, maxChars);
  // Find the last sentence-ending punctuation followed by a space or newline
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf(".\n"),
  );
  // Only use sentence boundary if it preserves >50% of allowed length
  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }
  // Fallback: truncate at word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.5) {
    return truncated.slice(0, lastSpace).trim();
  }
  return truncated.trim();
}

// ============================================================================
// Timeout helper
// ============================================================================

/** Wrap an async operation with an AbortController timeout. Returns `fallback` on timeout. */
async function withToolTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: T,
  logger?: { warn: (msg: string) => void },
  label?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      logger?.warn(`memory-mem0: ${label ?? "operation"} timed out after ${timeoutMs}ms`);
      return fallback;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// System prompt guidance for the agent
// ============================================================================

const MEM0_SYSTEM_PROMPT = `## Memory (mem0)
You have access to a persistent memory system. Use it proactively:

- **memory_recall**: Search memories for context about user preferences, past decisions, or previously discussed topics. Use BEFORE answering questions about prior work, preferences, dates, people, or decisions.
- **memory_store**: Save important information — preferences, decisions, contact details, project context. Keep each memory concise: one fact per memory, under 300 characters. Do NOT store transient information (task progress, current actions, greetings).
- **memory_forget**: Delete specific memories by ID or search query. Use for corrections or GDPR requests.
- **memory_promote**: Promote frequently accessed short-term memories to permanent long-term storage.

When relevant memories are injected in <relevant-memories>, reference them naturally in your response.`;

// Tool-level timeout for memory operations (ms)
const TOOL_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 3_000;

// ============================================================================
// Plugin Definition
// ============================================================================

const mem0Plugin = {
  id: "memory-mem0",
  name: "Memory (mem0)",
  description:
    "Multi-tier memory with Redis short-term + Qdrant vector + Neo4j graph via mem0 Docker stack",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);
    const client = new Mem0ApiClient(
      cfg.apiUrl,
      cfg.userId ?? "default",
      cfg.agentId ?? "openclaw",
    );

    api.logger.info(`memory-mem0: plugin registered (api: ${cfg.apiUrl})`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through memories (both short-term and long-term). Use when you need context about user preferences, past decisions, or previously discussed topics. Returns results from Redis short-term cache and Qdrant/Neo4j long-term storage.",
        parameters: Type.Object({
          query: Type.String({
            description: "Search query - natural language description of what to recall",
          }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
          scope: Type.Optional(
            stringEnum(MEMORY_SCOPES, {
              description:
                "Memory scope: user (user memories), agent (agent private memories), all (both)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit,
            scope = "user",
          } = params as {
            query: string;
            limit?: number;
            scope?: (typeof MEMORY_SCOPES)[number];
          };

          const searchParams: Parameters<typeof client.search>[0] = {
            query,
            limit: limit ?? cfg.searchDefaults.limit,
          };

          if (scope === "user" || scope === "all") {
            searchParams.userId = cfg.userId ?? "default";
          }
          if (scope === "agent" || scope === "all") {
            searchParams.agentId = cfg.agentId ?? "openclaw";
          }

          const results = await withToolTimeout(
            (signal) => client.search({ ...searchParams, signal }),
            TOOL_TIMEOUT_MS,
            [] as Awaited<ReturnType<typeof client.search>>,
            api.logger,
            "memory_recall",
          );

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map((r, i) => {
              const category = r.metadata?.category as string | undefined;
              const tag = category ?? r.source ?? "unknown";
              return `${i + 1}. [${tag}] ${r.memory} (${r.score != null ? `${(r.score * 100).toFixed(0)}%` : "n/a"})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: {
              count: results.length,
              memories: results.map((r) => ({
                id: r.id,
                memory: r.memory,
                score: r.score,
                source: r.source,
              })),
            },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in memory. Keep memories concise: one fact, preference, or decision per memory, ideally under 300 characters. Longer text is truncated at sentence boundary. Stores in Redis short-term first; frequently accessed memories are automatically promoted to long-term (Qdrant vector + Neo4j graph) storage.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          scope: Type.Optional(
            stringEnum(STORE_SCOPES, {
              description: "Store as user memory or agent-private memory (default: user)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text: rawText, scope = "user" } = params as {
            text: string;
            scope?: (typeof STORE_SCOPES)[number];
          };

          // Enforce max memory length (truncate at sentence boundary)
          const text = truncateAtSentence(rawText, cfg.capture.maxMemoryChars);
          // Detect category if enabled
          const category = cfg.capture.categorize ? detectCategory(text) : undefined;

          const result = await withToolTimeout(
            (signal) =>
              client.addMemory({
                messages: [{ role: "user", content: text }],
                userId: scope === "user" ? (cfg.userId ?? "default") : undefined,
                agentId: scope === "agent" ? (cfg.agentId ?? "openclaw") : undefined,
                metadata: {
                  ...(category ? { category } : {}),
                  source: "tool",
                },
                signal,
              }),
            TOOL_TIMEOUT_MS,
            { success: false, short_term: false, long_term: false } as Mem0AddResult,
            api.logger,
            "memory_store",
          );

          if (!result.success) {
            return {
              content: [{ type: "text", text: "Failed to store memory." }],
              details: { action: "error" },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored${category ? ` [${category}]` : ""}: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "created",
              category,
              shortTerm: result.short_term,
              longTerm: result.long_term,
              memoryKey: result.memory_key,
              truncated: rawText.length !== text.length,
            },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description:
          "Delete specific memories by ID, or search and delete. GDPR-compliant memory removal.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({
              description: "Search query to find the memory to forget",
            }),
          ),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            await withToolTimeout(
              (signal) => client.deleteMemory(memoryId, signal),
              TOOL_TIMEOUT_MS,
              { success: false, deleted: "" },
              api.logger,
              "memory_forget",
            );
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const results = await withToolTimeout(
              (signal) => client.search({ query, limit: 5, signal }),
              TOOL_TIMEOUT_MS,
              [] as Awaited<ReturnType<typeof client.search>>,
              api.logger,
              "memory_forget:search",
            );

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // Auto-delete if single high-confidence match
            if (results.length === 1 && results[0].score != null && results[0].score > 0.9) {
              await withToolTimeout(
                (signal) => client.deleteMemory(results[0].id, signal),
                TOOL_TIMEOUT_MS,
                { success: false, deleted: "" },
                api.logger,
                "memory_forget:delete",
              );
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].memory}"`,
                  },
                ],
                details: { action: "deleted", id: results[0].id },
              };
            }

            const list = results
              .map((r) => `- [${r.id.slice(0, 8)}] ${r.memory.slice(0, 60)}...`)
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: results.map((r) => ({
                  id: r.id,
                  memory: r.memory,
                  score: r.score,
                })),
              },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_promote",
        label: "Memory Promote",
        description:
          "Promote frequently accessed short-term memories to long-term storage. Memories accessed 3+ times in Redis are promoted to Qdrant vector + Neo4j graph storage for permanent recall.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          const result = await withToolTimeout(
            () => client.promote(cfg.userId ?? "default"),
            TOOL_TIMEOUT_MS,
            { promoted_count: 0, promoted: [] } as Awaited<ReturnType<typeof client.promote>>,
            api.logger,
            "memory_promote",
          );
          return {
            content: [
              {
                type: "text",
                text: `Promoted ${result.promoted_count} memories to long-term storage.`,
              },
            ],
            details: { promoted: result.promoted_count },
          };
        },
      },
      { name: "memory_promote" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program, workspaceDir: cliWorkspaceDir }) => {
        const mem0 = program.command("mem0").description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .option("--scope <scope>", "Scope: user, agent, all", "user")
          .action(async (query: string, opts: { limit: string; scope: string }) => {
            try {
              const results = await client.search({
                query,
                limit: parseInt(opts.limit),
                userId: opts.scope !== "agent" ? (cfg.userId ?? "default") : undefined,
                agentId: opts.scope !== "user" ? (cfg.agentId ?? "openclaw") : undefined,
              });
              if (results.length === 0) {
                console.log("No memories found.");
                return;
              }
              console.log(
                JSON.stringify(
                  results.map((r) => ({
                    id: r.id,
                    memory: r.memory,
                    score: r.score,
                    source: r.source,
                  })),
                  null,
                  2,
                ),
              );
            } catch (err) {
              console.error(`Search failed: ${String(err)}`);
            }
          });

        mem0
          .command("list")
          .description("List all memories")
          .option("--scope <scope>", "user or agent", "user")
          .option("--limit <n>", "Max results", "50")
          .action(async (opts: { scope: string; limit: string }) => {
            try {
              const memories =
                opts.scope === "agent"
                  ? await client.getAgentMemories(cfg.agentId ?? "openclaw", parseInt(opts.limit))
                  : await client.getUserMemories(cfg.userId ?? "default", parseInt(opts.limit));
              console.log(`Total: ${memories.length}`);
              console.log(JSON.stringify(memories, null, 2));
            } catch (err) {
              console.error(`List failed: ${String(err)}`);
            }
          });

        mem0
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            try {
              const stats = await client.stats();
              console.log(JSON.stringify(stats, null, 2));
            } catch (err) {
              console.error(`Stats failed: ${String(err)}`);
            }
          });

        mem0
          .command("health")
          .description("Check mem0-api health")
          .action(async () => {
            try {
              const health = await client.health();
              console.log(JSON.stringify(health, null, 2));
            } catch (err) {
              console.error(`Health check failed: ${String(err)}`);
            }
          });

        mem0
          .command("promote")
          .description("Promote short-term memories to long-term")
          .action(async () => {
            try {
              const result = await client.promote(cfg.userId ?? "default");
              console.log(`Promoted ${result.promoted_count} memories to long-term storage.`);
            } catch (err) {
              console.error(`Promote failed: ${String(err)}`);
            }
          });

        mem0
          .command("forget")
          .description("Delete a specific memory by ID")
          .argument("<memoryId>", "Memory ID to delete")
          .action(async (memoryId: string) => {
            try {
              await client.deleteMemory(memoryId);
              console.log(`Memory ${memoryId} deleted.`);
            } catch (err) {
              console.error(`Delete failed: ${String(err)}`);
            }
          });

        mem0
          .command("docker-up")
          .description("Start the mem0 Docker stack")
          .action(() => {
            const dockerDir = resolveDockerDir();
            try {
              execSync(
                `docker compose -f "${join(dockerDir, "docker-compose.yml")}" --env-file "${join(dockerDir, ".env")}" up -d`,
                { stdio: "inherit" },
              );
            } catch (err) {
              console.error(`Failed to start Docker stack: ${String(err)}`);
            }
          });

        mem0
          .command("docker-down")
          .description("Stop the mem0 Docker stack")
          .action(() => {
            const dockerDir = resolveDockerDir();
            try {
              execSync(
                `docker compose -f "${join(dockerDir, "docker-compose.yml")}" --env-file "${join(dockerDir, ".env")}" down`,
                { stdio: "inherit" },
              );
            } catch (err) {
              console.error(`Failed to stop Docker stack: ${String(err)}`);
            }
          });

        mem0
          .command("migrate")
          .description("Migrate workspace memory files (MEMORY.md + memory/*.md) into mem0")
          .option("--workspace <dir>", "Workspace directory (default: auto-detect)")
          .option("--dry-run", "Preview without sending", false)
          .option("--skip-backup", "Skip creating backup files", false)
          .option("--archive", "Move daily files to memory/archive/", false)
          .option("--keep-memory-md", "Don't rewrite MEMORY.md after migration", false)
          .option("--batch-size <n>", "Chunks per batch", "5")
          .option("--delay <ms>", "Delay between batches (ms)", "500")
          .option("--scope <scope>", "Memory scope: user or agent", "user")
          .option("--verbose", "Show detailed progress", false)
          .action(
            async (opts: {
              workspace?: string;
              dryRun: boolean;
              skipBackup: boolean;
              archive: boolean;
              keepMemoryMd: boolean;
              batchSize: string;
              delay: string;
              scope: string;
              verbose: boolean;
            }) => {
              const { resolve } = await import("node:path");
              const { runMigration } = await import("./migrate.js");

              const workspaceDir = opts.workspace ? resolve(opts.workspace) : cliWorkspaceDir;
              if (!workspaceDir) {
                console.error("Could not determine workspace directory. Use --workspace <dir>.");
                process.exitCode = 1;
                return;
              }

              // Health check first
              try {
                await client.health();
              } catch {
                console.error(
                  `mem0-api not reachable at ${cfg.apiUrl}. Start with: openclaw mem0 docker-up`,
                );
                process.exitCode = 1;
                return;
              }

              const result = await runMigration({
                workspaceDir,
                client,
                userId: opts.scope === "agent" ? "" : (cfg.userId ?? "default"),
                agentId: opts.scope === "agent" ? (cfg.agentId ?? "openclaw") : "",
                dryRun: opts.dryRun,
                skipBackup: opts.skipBackup,
                archive: opts.archive,
                keepMemoryMd: opts.keepMemoryMd,
                batchSize: parseInt(opts.batchSize),
                delayMs: parseInt(opts.delay),
                verbose: opts.verbose,
                logger: { info: console.log, warn: console.warn, error: console.error },
              });

              console.log(`\nMigration ${opts.dryRun ? "(dry run) " : ""}complete:`);
              console.log(`  Files processed: ${result.filesProcessed}`);
              console.log(`  Files skipped:   ${result.filesSkipped}`);
              console.log(`  Chunks total:    ${result.chunksTotal}`);
              console.log(`  Chunks sent:     ${result.chunksSent}`);
              console.log(`  Chunks failed:   ${result.chunksFailed}`);
              if (result.errors.length > 0) {
                console.error(`  Errors: ${result.errors.length}`);
                if (opts.verbose) {
                  for (const err of result.errors) {
                    console.error(`    - ${err}`);
                  }
                }
              }
            },
          );
      },
      { commands: ["mem0"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Always inject system prompt guidance so the agent knows about memory tools.
    // Conditionally include auto-recall (memory search) when autoRecall is enabled.
    api.on("before_agent_start", async (event) => {
      // Always provide system prompt guidance for memory tools
      const result: { systemPrompt: string; prependContext?: string } = {
        systemPrompt: MEM0_SYSTEM_PROMPT,
      };

      // Auto-recall: search for relevant memories and inject as context
      if (cfg.autoRecall && event.prompt && event.prompt.length >= 5) {
        try {
          const recallResults = await withToolTimeout(
            (signal) =>
              client.search({
                query: event.prompt,
                limit: cfg.recall.limit,
                userId: cfg.userId ?? "default",
                signal,
              }),
            cfg.recall.timeoutMs,
            [] as Awaited<ReturnType<typeof client.search>>,
            api.logger,
            "auto-recall",
          );

          let results = recallResults;

          // Filter by minimum relevance score if configured
          if (results.length > 0 && cfg.recall.minScore != null) {
            results = results.filter((r) => r.score == null || r.score >= cfg.recall.minScore!);
          }

          if (results.length > 0) {
            // Build memory lines with optional category tags
            let memoryLines = results.map((r) => {
              const category = r.metadata?.category as string | undefined;
              const tag =
                cfg.recall.includeCategory && category ? category : (r.source ?? "memory");
              return `- [${tag}] ${r.memory}`;
            });

            // Context size guard: enforce maxContextChars
            let totalChars = memoryLines.reduce((sum, l) => sum + l.length + 1, 0);
            if (totalChars > cfg.recall.maxContextChars) {
              while (memoryLines.length > 1 && totalChars > cfg.recall.maxContextChars) {
                const removed = memoryLines.pop()!;
                totalChars -= removed.length + 1;
              }
              if (totalChars > cfg.recall.maxContextChars && memoryLines.length === 1) {
                memoryLines[0] = memoryLines[0].slice(0, cfg.recall.maxContextChars - 4) + "...";
              }
            }

            const memoryContext = memoryLines.join("\n");

            api.logger.info?.(
              `memory-mem0: injecting ${memoryLines.length} memories (${memoryContext.length} chars) into context`,
            );

            result.prependContext = `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`;
          }
        } catch (err) {
          api.logger.warn(`memory-mem0: recall failed: ${String(err)}`);
        }
      }

      return result;
    });

    // Auto-capture: analyze and store important user messages after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract text content from USER messages only.
          // Assistant messages mostly contain procedural acknowledgments, not preferences.
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user") {
              continue;
            }

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          // Filter for capturable content
          const toCapture = texts.filter(
            (text) => text && shouldCapture(text, cfg.capture.maxMemoryChars),
          );
          if (toCapture.length === 0) {
            return;
          }

          // Store each capturable piece, truncated and categorized (with timeout)
          let stored = 0;
          for (const rawText of toCapture.slice(0, cfg.capture.maxPerConversation)) {
            try {
              const text = truncateAtSentence(rawText, cfg.capture.maxMemoryChars);
              const category = cfg.capture.categorize ? detectCategory(text) : undefined;

              const result = await withToolTimeout(
                (signal) =>
                  client.addMemory({
                    messages: [{ role: "user", content: text }],
                    userId: cfg.userId ?? "default",
                    agentId: cfg.agentId ?? "openclaw",
                    metadata: {
                      ...(category ? { category } : {}),
                      source: "auto-capture",
                    },
                    signal,
                  }),
                CAPTURE_TIMEOUT_MS,
                { success: false, short_term: false, long_term: false } as Mem0AddResult,
                api.logger,
                "auto-capture",
              );
              if (result.success) {
                stored++;
              }
            } catch (err) {
              api.logger.warn(`memory-mem0: failed to store capture: ${String(err)}`);
            }
          }

          if (stored > 0) {
            api.logger.info(`memory-mem0: auto-captured ${stored} memories`);
          }

          // Optionally trigger promotion after capture
          if (cfg.autoPromote) {
            try {
              await withToolTimeout(
                () => client.promote(cfg.userId ?? "default"),
                CAPTURE_TIMEOUT_MS,
                { promoted_count: 0, promoted: [] } as Awaited<ReturnType<typeof client.promote>>,
                api.logger,
                "auto-promote",
              );
            } catch {
              // Promotion failure is non-critical
            }
          }
        } catch (err) {
          api.logger.warn(`memory-mem0: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-mem0",
      start: async () => {
        try {
          const health = await client.health();
          api.logger.info(`memory-mem0: connected to mem0-api (status: ${health.status})`);
        } catch {
          api.logger.warn(
            `memory-mem0: mem0-api not reachable at ${cfg.apiUrl} - start the Docker stack with: openclaw mem0 docker-up`,
          );
        }
      },
      stop: () => {
        api.logger.info("memory-mem0: stopped");
      },
    });
  },
};

// ============================================================================
// Helpers
// ============================================================================

function resolveDockerDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "docker");
}

export default mem0Plugin;
