# Migrating Workspace Memory to mem0

Your workspace memory files (`MEMORY.md`, `memory/*.md`) grow over time and consume context window space. Migrating them into the mem0 Docker stack moves memories into persistent, searchable storage (Redis + Qdrant + Neo4j) while keeping your context lean.

## Before You Start

1. The mem0 Docker stack must be running: `openclaw mem0 docker-up`
2. Verify connectivity: `openclaw mem0 health`
3. Back up your workspace manually if you want an extra safety net (the CLI creates backups automatically)

## Option A: CLI Migration

The `openclaw mem0 migrate` command reads your workspace memory files, splits them into discrete memory chunks, sends each to mem0, and optionally slims down the originals.

### Preview First (Dry Run)

Always start with a dry run to see what will be migrated:

```bash
openclaw mem0 migrate --dry-run --verbose
```

This prints every chunk that would be sent without making any changes.

### Run the Migration

```bash
openclaw mem0 migrate
```

This will:

1. Read `MEMORY.md` and all `memory/*.md` files
2. Chunk them into individual memory items (facts, preferences, decisions)
3. Back up each file (e.g., `MEMORY.md.bak.1738856400000`)
4. Send each chunk to mem0 with metadata tracking the source file and heading
5. Rewrite `MEMORY.md` to a slim stub pointing to mem0
6. Save a manifest (`.mem0-migrated.json`) to avoid re-importing on future runs

### Flags Reference

| Flag                | Default     | Description                                           |
| ------------------- | ----------- | ----------------------------------------------------- |
| `--workspace <dir>` | auto-detect | Override workspace directory                          |
| `--dry-run`         | false       | Preview without sending or modifying files            |
| `--skip-backup`     | false       | Skip creating .bak files (not recommended)            |
| `--archive`         | false       | Move daily files to `memory/archive/` instead of .bak |
| `--keep-memory-md`  | false       | Don't rewrite MEMORY.md (only migrate daily files)    |
| `--batch-size <n>`  | 5           | Number of chunks sent in parallel per batch           |
| `--delay <ms>`      | 500         | Delay between batches to avoid overloading the API    |
| `--scope <scope>`   | user        | Store as `user` or `agent` memory                     |
| `--verbose`         | false       | Show detailed progress and chunk previews             |

### What Happens to Your Files

- **MEMORY.md**: Rewritten to a small stub with a pointer to mem0 and a "Quick Notes" section. The original is saved as `MEMORY.md.bak.<timestamp>`.
- **Daily files** (`memory/YYYY-MM-DD-*.md`): Backed up as `.bak` files (or moved to `memory/archive/` with `--archive`).
- **Manifest**: `memory/.mem0-migrated.json` tracks migrated files by content hash. Re-running the migration skips unchanged files automatically.

### Re-Running After Updates

If your MEMORY.md or daily files change after migration, just re-run:

```bash
openclaw mem0 migrate
```

The manifest detects changed files (by content hash) and only re-migrates those. Already-migrated files with unchanged content are skipped.

## Option B: Agent-Driven Migration

Instead of the CLI, you can ask your agent to review and migrate its own memories. This leverages the agent's understanding of context to decide what matters most.

**Best for**: Workspaces under ~20KB where you want the agent to exercise judgment about what to keep. For larger workspaces, use the CLI migration.

### Full Migration Prompt

Copy and paste this to your agent:

> I want to migrate my workspace memories into mem0. Please:
>
> 1. Read my MEMORY.md file and identify each distinct fact, preference, decision, or piece of knowledge.
> 2. For each item, use the `memory_store` tool to save it to mem0. Include a brief, clear summary as the text.
> 3. After storing all items, edit MEMORY.md to remove the migrated entries and add a note at the top saying memories have been moved to mem0.
> 4. Then read each file in the `memory/` directory. For each session file, identify the key facts and decisions discussed, and store those in mem0 using `memory_store`.
> 5. Give me a summary of what was migrated when you are done.
>
> Take your time and be thorough. It is better to store too many memories than to miss important ones.

### Selective Migration (Preferences Only)

If you only want to offload preferences and decisions:

> Review my MEMORY.md and look for personal preferences, tool choices, and recurring decisions. Store only those into mem0 using `memory_store`. Leave everything else in MEMORY.md. Tell me what you stored.

### Daily Files Only

To migrate session logs without touching MEMORY.md:

> Look through my `memory/` directory and identify the most important facts and decisions from the last 30 days of session files. Store each one using `memory_store` with a clear one-line summary. Do not modify MEMORY.md.

## Verifying the Migration

After migrating, check that your memories made it:

```bash
# Search for a known memory
openclaw mem0 search "dark mode preference"

# See overall stats
openclaw mem0 stats

# List all stored memories
openclaw mem0 list --limit 20
```

## Rolling Back

If something went wrong, restore from backups:

```bash
# Restore MEMORY.md from backup
cp ~/.openclaw/workspace/MEMORY.md.bak.1738856400000 ~/.openclaw/workspace/MEMORY.md

# Or restore archived daily files
cp ~/.openclaw/workspace/memory/archive/*.md ~/.openclaw/workspace/memory/
```

The migration manifest (`memory/.mem0-migrated.json`) can be deleted to force a fresh migration on the next run.

## How It Works

The CLI migration uses a heading-aware Markdown chunker:

- **MEMORY.md**: Headings (`##`) define sections/categories. List items and paragraphs become individual memory chunks. Code blocks are kept intact.
- **Session files** (`memory/YYYY-MM-DD-*.md`): Metadata is extracted as one chunk. Conversation exchanges are grouped into chunks of ~5 pairs.
- **Metadata**: Each chunk is tagged with its source file, heading, line range, and migration timestamp for traceability.
- **Idempotency**: A manifest file tracks migrated files by SHA-256 hash. Re-running skips unchanged files.
