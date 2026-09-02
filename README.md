# dsh-hippocampus

A DeepSeek Harness memory plugin: durable cross-session facts with layered project/user storage, explicit `remember`/`recall`/`forget` tools, automatic extraction from completed turns, self-maintenance, and an audit trail with one-click restore.

Named after the hippocampus — the brain's memory center.

## Install

Install the latest release tarball into a dsh profile:

```sh
dsh plugin --profile web add "https://github.com/iabetor/dsh-hippocampus/releases/latest/download/dsh-hippocampus-0.1.0.tgz"
```

Or add it manually to the profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-hippocampus": "https://github.com/iabetor/dsh-hippocampus/releases/download/v0.1.0/dsh-hippocampus-0.1.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-hippocampus"]
    }
  }
}
```

Then restart `dsh web`. The plugin registers a **Memory** tab in the conversation view and a **Memory management** page in Settings.

### Development

```sh
git clone https://github.com/iabetor/dsh-hippocampus.git
cd dsh-hippocampus
pnpm install
pnpm run build   # typecheck + bundle (tsdown)
pnpm run test    # vitest
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
| `forget(id)` | Deletes a record by id (recorded in the audit trail). |

### Automatic extraction

On each completed turn, the routed LLM distills durable facts (with `[project]`/`[user]` scope labels) and merges them into the store, deduplicating by normalized text. Extraction is bounded (`maxTokens`, `timeoutMs`, `maxFactsPerTurn`) and best-effort: failures are logged, never thrown. A per-session cursor keeps it idempotent across restarts.

### Settings page

The **Memory management** settings page groups memory as **Global memory** (user layer) followed by one block per workspace's **Project memory** (collapsible). Each block supports search, delete, and per-record restore from the cleanup log.

### Maintenance & audit

- **Rule sweep** (timer, 24h): auto-extracted records never recalled within 30 days are removed. User-explicit records are never touched automatically.
- **Manual tidy** (settings button): runs the rule sweep, then asks the routed LLM to delete duplicates / transient / trivial auto-extracted records.
- **Audit trail** (`~/.dsh/hippocampus/audit.log`): every removal (rules / LLM / manual) is appended with id, scope, workspace, text, and tags; capped at the newest 50 entries.
- **Restore**: the cleanup-log panel offers one-click restore per deleted record — the record is recreated with its original id in its original workspace (refused when the workspace no longer exists).

### Config

| Option | Default | Meaning |
|---|---|---|
| `autoExtract` | `true` | Automatic extraction on completed turns |
| `autoInject` | `true` | Inject relevant memory before steps |
| `semanticRanking` | `true` | Hybrid keyword + embedding ranking |
| `keywordWeight` | `0.4` | Keyword weight in the hybrid score |
| `embeddingModel` | `Xenova/bge-small-zh-v1.5` | Local ONNX embedding model |
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

This plugin rides only public harness interfaces (`ctx.tools`, `ctx.systemPrompt`, `ctx.on('session/event')`, `ctx.llm`, `ctx.inject`). No deepseek-harness source, bundle, or gate is touched.

## Releasing

```sh
pnpm run build
pnpm pack                        # produces dsh-hippocampus-<version>.tgz
gh release create v<version> dsh-hippocampus-<version>.tgz
```

## License

MIT
