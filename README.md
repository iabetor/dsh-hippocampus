# dsh-hippocampus

A DeepSeek Harness memory plugin: durable cross-session facts with layered project/user storage, explicit `remember`/`recall`/`forget` tools, and automatic extraction from completed turns.

Named after the hippocampus — the brain's memory center.

## Install

```sh
git clone ... # your project
cd dsh-hippocampus
pnpm install
pnpm run build
```

## Mount

```sh
dsh web --patch "$PWD/cordis.patch.yml"
```

Or merge the patch into your user profile (`$DSH_HOME/cordis.patch.yml`) to keep it across runs:

```yaml
- insert:
    - id: dsh-hippocampus
      name: dsh-hippocampus
```

## How it works

### Layered storage

| Layer | Path | Lifecycle |
|---|---|---|
| Project | `<workspace>/.dsh/hippocampus/records/<uuid>.json` | Follows the workspace; clone/share with the repo |
| User | `~/.dsh/hippocampus/records/<uuid>.json` | Follows the user across all projects; capped at 200 records with LRU eviction |

Each record is one JSON file (human-readable, git-diffable, atomic writes). Project memory is searched first, then user memory as fallback — keeping token cost bounded and facts close to where they matter.

### Tools

| Tool | What it does |
|---|---|
| `remember(text, scope?, tags?)` | Stores a fact; `scope` defaults to `project`. Same-scope duplicates refresh instead of duplicating. |
| `recall(query, scope?, limit?)` | Searches project first, then user. Returns ranked hits. |
| `forget(id)` | Deletes a record by id. |

### Automatic extraction

On each completed turn, the routed LLM distills durable facts (with `[project]`/`[user]` scope labels) and merges them into the store, deduplicating by normalized text. Extraction is bounded (`maxTokens`, `timeoutMs`, `maxFactsPerTurn`) and best-effort: failures are logged, never thrown. A per-session cursor keeps it idempotent across restarts.

### Config

| Option | Default | Meaning |
|---|---|---|
| `autoExtract` | `true` | Automatic extraction on completed turns |
| `autoInject` | `true` | Inject relevant memory before steps (planned) |
| `maxUserRecords` | `200` | User-layer cap; LRU eviction beyond it |
| `maxTokens` | `512` | Extraction output cap |
| `timeoutMs` | `30000` | Extraction deadline |
| `extractionProvider` / `extractionModel` | `''` | Explicit extraction route; empty uses the session's routed model |
| `memoryRoot` | `~/.dsh/hippocampus` | User-layer root override |

## Verify the loop

1. In session A: *"Remember that my favorite drink is lapsang tea."*
2. Open session B (same host, no copy of A's conversation): *"What is my favorite drink? Check memory."*
3. The model calls `recall` and answers from memory.

## Zero upstream modification

This plugin rides only public harness interfaces (`ctx.tools`, `ctx.systemPrompt`, `ctx.on('session/event')`, `ctx.llm`). No deepseek-harness source, bundle, or gate is touched.

## License

MIT
