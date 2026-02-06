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
- An OpenAI API key for LLM fact extraction
- [Ollama](https://ollama.com) with `nomic-embed-text:v1.5` for local embeddings (recommended), or an OpenAI key for cloud embeddings

## Quick Start

```bash
# Pull the embedding model (one-time)
ollama pull nomic-embed-text:v1.5

# Configure the Docker stack
cd extensions/memory-mem0/docker
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (do NOT wrap in quotes)

# Start the stack
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

  // Storage-time quality controls
  capture: {
    maxMemoryChars: 300, // max chars per stored memory (truncated at sentence boundary)
    maxPerConversation: 3, // auto-captures per conversation
    categorize: true, // auto-detect memory category (preference, fact, decision, etc.)
  },

  // Recall/injection controls
  recall: {
    limit: 3, // max memories injected into context
    maxContextChars: 1500, // total char cap on injected memory block
    timeoutMs: 3000, // timeout for search (agent starts without memories on timeout)
    // minScore: 0.3,       // optional minimum relevance score
    includeCategory: true, // show [category] tags in injected memories
  },
}
```

## Docker Environment Variables

| Variable                 | Default                             | Description                             |
| ------------------------ | ----------------------------------- | --------------------------------------- |
| `OPENAI_API_KEY`         | —                                   | Required for OpenAI LLM provider        |
| `MEM0_LLM_PROVIDER`      | `openai`                            | LLM provider: `openai`, `google`        |
| `MEM0_LLM_MODEL`         | `gpt-4o-mini`                       | LLM model for fact extraction           |
| `MEM0_EMBEDDER_PROVIDER` | `ollama`                            | Embedder: `ollama`, `openai`, `google`  |
| `MEM0_EMBEDDER_MODEL`    | `nomic-embed-text:v1.5`             | Embedding model                         |
| `MEM0_EMBEDDING_DIMS`    | `768`                               | Embedding dimensions (must match model) |
| `OLLAMA_BASE_URL`        | `http://host.docker.internal:11434` | Ollama URL (Docker host access)         |
| `GEMINI_API_KEY`         | —                                   | Required for Google/Gemini provider     |

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

When `autoRecall` is enabled, the plugin searches for relevant memories before each agent conversation and injects them as `<relevant-memories>` context. The search is timeout-guarded (`recall.timeoutMs`, default 3s) and capped (`recall.maxContextChars`, default 1500 chars). On timeout or error the agent starts without memories.

When `autoCapture` is enabled, the plugin analyzes conversation messages after each agent run and stores important information (preferences, decisions, contact details). Captures are filtered by pattern matching, truncated to `capture.maxMemoryChars` (default 300) at sentence boundaries, auto-categorized, and capped at `capture.maxPerConversation` (default 3) per conversation.

When `autoPromote` is enabled, memories accessed 3+ times in Redis short-term storage are automatically promoted to Qdrant vector and Neo4j graph long-term storage.

## Memory Quality Controls

The plugin enforces memory quality at multiple levels:

1. **Teaching the agent**: The `memory_store` tool description instructs the agent to keep memories concise (one fact/preference/decision, under 300 chars). This is the primary quality control.
2. **Storage-time truncation**: Memories exceeding `capture.maxMemoryChars` are truncated at the nearest sentence boundary, preserving meaning.
3. **Auto-categorization**: Each stored memory is tagged with a category (`preference`, `fact`, `decision`, `contact`, `skill`, `relationship`, `context`) for smarter recall.
4. **Context size guard**: The total injected memory block is capped at `recall.maxContextChars`. Lower-relevance memories are dropped first if the cap is exceeded.
5. **Timeout protection**: A slow or unresponsive mem0-api never blocks the agent. The search times out and the conversation proceeds without memories.

## Migrating Workspace Memory

See [MIGRATION.md](./MIGRATION.md) for a complete guide on migrating your existing workspace memories (`MEMORY.md`, `memory/*.md`) into mem0 — both via automated CLI and agent-driven approaches.

## Data Storage

All persistent data (Postgres, Redis, Qdrant, Neo4j) is stored at `~/.openclaw/memory/data/`. This location is independent of the plugin source code — your memories persist even if you remove the git repo or switch workspaces.

```
~/.openclaw/memory/data/
  postgres/    # Audit logs, profiles, metadata
  redis/       # Short-term memory cache snapshots
  qdrant/      # Long-term vector embeddings
  neo4j/       # Graph relationships
```

## Notes

- Only one memory plugin can be active at a time (`plugins.slots.memory`). Set to `"memory-mem0"` to use this plugin instead of the default.
- Config values support `${ENV_VAR}` interpolation (e.g., `apiUrl: "${MEM0_API_URL}"`).
- The Docker stack includes 5 services: Postgres, Redis Stack, Qdrant, Neo4j, and mem0-api.

## Acknowledgments

The memory categorization system and quality-first philosophy were influenced by the [openmetaloom/skills continuity skill](https://github.com/openmetaloom/skills/tree/master/continuity). Its core insight resonates with the motivation behind this plugin: an agent's architecture can be restarted and replaced, but the thread of experience — memories, decisions, preferences — is what makes an agent continuous.
