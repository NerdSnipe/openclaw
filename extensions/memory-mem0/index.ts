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
import { Mem0ApiClient } from "./client.js";
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
  /remember|zapamatuj si|pamatuj/i,
  /prefer|radši|nechci|preferuji/i,
  /decided|rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my|můj\s+\w+\s+je|je\s+můj/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) {
    return false;
  }
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

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

          const results = await client.search(searchParams);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.source ?? "unknown"}] ${r.memory} (${r.score != null ? `${(r.score * 100).toFixed(0)}%` : "n/a"})`,
            )
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
          "Save important information in memory. Stores in Redis short-term first; frequently accessed memories are automatically promoted to long-term (Qdrant vector + Neo4j graph) storage.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          scope: Type.Optional(
            stringEnum(STORE_SCOPES, {
              description: "Store as user memory or agent-private memory (default: user)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text, scope = "user" } = params as {
            text: string;
            scope?: (typeof STORE_SCOPES)[number];
          };

          const result = await client.addMemory({
            messages: [{ role: "user", content: text }],
            userId: scope === "user" ? (cfg.userId ?? "default") : undefined,
            agentId: scope === "agent" ? (cfg.agentId ?? "openclaw") : undefined,
          });

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
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "created",
              shortTerm: result.short_term,
              longTerm: result.long_term,
              memoryKey: result.memory_key,
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
            await client.deleteMemory(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const results = await client.search({ query, limit: 5 });

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // Auto-delete if single high-confidence match
            if (results.length === 1 && results[0].score != null && results[0].score > 0.9) {
              await client.deleteMemory(results[0].id);
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
          const result = await client.promote(cfg.userId ?? "default");
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
      ({ program }) => {
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
              execSync(`docker compose -f "${join(dockerDir, "docker-compose.yml")}" up -d`, {
                stdio: "inherit",
              });
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
              execSync(`docker compose -f "${join(dockerDir, "docker-compose.yml")}" down`, {
                stdio: "inherit",
              });
            } catch (err) {
              console.error(`Failed to stop Docker stack: ${String(err)}`);
            }
          });
      },
      { commands: ["mem0"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const results = await client.search({
            query: event.prompt,
            limit: 3,
            userId: cfg.userId ?? "default",
          });

          if (results.length === 0) {
            return;
          }

          const memoryContext = results
            .map((r) => `- [${r.source ?? "memory"}] ${r.memory}`)
            .join("\n");

          api.logger.info?.(`memory-mem0: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-mem0: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: analyze and store important information after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract text content from messages (handling unknown[] type)
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") {
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
          const toCapture = texts.filter((text) => text && shouldCapture(text));
          if (toCapture.length === 0) {
            return;
          }

          // Store each capturable piece (limit to 3 per conversation)
          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            try {
              await client.addMemory({
                messages: [{ role: "user", content: text }],
                userId: cfg.userId ?? "default",
                agentId: cfg.agentId ?? "openclaw",
              });
              stored++;
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
              await client.promote(cfg.userId ?? "default");
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
