# @openclaw/memory-mem0

Official multi-tier memory plugin for **OpenClaw**.

Memory tiers:

- **Redis** — short-term / working memory (fast, 24h TTL)
- **Qdrant** — long-term vector memory (persistent embeddings)
- **Neo4j** — graph memory (entity relationships)
- **Postgres** — audit logs, profiles, metadata

The TypeScript plugin is a thin HTTP client; all heavy lifting (embeddings, fact extraction, graph updates) runs server-side in the Docker stack.

Docs: `https://docs.openclaw.ai/plugin`

## Install

### Option A: install via OpenClaw (recommended)

```bash
openclaw plugins install @openclaw/memory-mem0
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.openclaw/extensions
cp -R extensions/memory-mem0 ~/.openclaw/extensions/memory-mem0
cd ~/.openclaw/extensions/memory-mem0 && pnpm install
```

## Prerequisites

- Docker and Docker Compose
- An OpenAI API key (default) or alternative provider key (Gemini, Ollama)

## Quick Start

```bash
cd extensions/memory-mem0/docker
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (or alternative provider)
docker compose up -d
```

The mem0-api listens on `http://localhost:8080` by default.

## Config

Put under `plugins.entries.memory-mem0.config`:

```json5
{
  apiUrl: "http://localhost:8080", // mem0-api URL (supports ${MEM0_API_URL})
  userId: "default", // user scope for memories
  agentId: "openclaw", // agent scope for private memories

  autoCapture: true, // store important info from conversations
  autoRecall: true, // inject relevant memories into context
  autoPromote: false, // promote frequently accessed memories to long-term

  searchDefaults: {
    limit: 5, // max results per search
    threshold: 0.3, // minimum relevance score
  },
}
```

## Docker Environment Variables

| Variable                 | Default                  | Description                            |
| ------------------------ | ------------------------ | -------------------------------------- |
| `OPENAI_API_KEY`         | —                        | Required for OpenAI provider           |
| `MEM0_LLM_PROVIDER`      | `openai`                 | LLM provider: `openai`, `google`       |
| `MEM0_LLM_MODEL`         | `gpt-4o-mini`            | LLM model for fact extraction          |
| `MEM0_EMBEDDER_PROVIDER` | `openai`                 | Embedder: `openai`, `ollama`, `google` |
| `MEM0_EMBEDDER_MODEL`    | `text-embedding-3-small` | Embedding model                        |
| `MEM0_EMBEDDING_DIMS`    | `1536`                   | Embedding dimensions                   |
| `GEMINI_API_KEY`         | —                        | Required for Google/Gemini provider    |
| `OLLAMA_BASE_URL`        | —                        | Required for Ollama provider           |

## Tools

| Tool             | Parameters                  | Description                              |
| ---------------- | --------------------------- | ---------------------------------------- |
| `memory_recall`  | `query`, `limit?`, `scope?` | Search short-term and long-term memories |
| `memory_store`   | `text`, `scope?`            | Store information (user or agent scope)  |
| `memory_forget`  | `query?`, `memoryId?`       | Delete memories by ID or search          |
| `memory_promote` | —                           | Promote short-term memories to long-term |

Scope values: `user`, `agent`, `all` (recall only).

## CLI

```bash
openclaw mem0 search <query> [--limit 5] [--scope user]
openclaw mem0 list [--scope user] [--limit 50]
openclaw mem0 stats
openclaw mem0 health
openclaw mem0 promote
openclaw mem0 forget <memoryId>
openclaw mem0 docker-up
openclaw mem0 docker-down
```

## Auto-Recall and Auto-Capture

When `autoRecall` is enabled, the plugin searches for relevant memories before each agent conversation and injects them as `<relevant-memories>` context.

When `autoCapture` is enabled, the plugin analyzes conversation messages after each agent run and stores important information (preferences, decisions, contact details). Captures are filtered by pattern matching and capped at 3 per conversation.

When `autoPromote` is enabled, memories accessed 3+ times in Redis short-term storage are automatically promoted to Qdrant vector and Neo4j graph long-term storage.

## Migrating Workspace Memory

See [MIGRATION.md](./MIGRATION.md) for a complete guide on migrating your existing workspace memories (`MEMORY.md`, `memory/*.md`) into mem0 — both via automated CLI and agent-driven approaches.

## Notes

- Only one memory plugin can be active at a time (`plugins.slots.memory`). Set to `"memory-mem0"` to use this plugin instead of the default.
- Config values support `${ENV_VAR}` interpolation (e.g., `apiUrl: "${MEM0_API_URL}"`).
- The Docker stack includes 5 services: Postgres, Redis Stack, Qdrant, Neo4j, and mem0-api.
