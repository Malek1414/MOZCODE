# MOZCODE

**A symbol-level MCP server for Claude Code, Codex, and OpenAI models.** MOZCODE
returns the *symbol you asked for* instead of the whole file, so an agentic coding loop spends far fewer input
tokens. It parses source with tree-sitter, hands the model a function/class/method
(or a collapsed outline) rather than 400 lines of context, anchors edits to AST
spans so the model never re-reads a file after editing it, and meters the estimated
savings to a local dashboard.

Everything runs **locally**. There is no account, no proxy, and no server that
receives your code — the MCP server is a local stdio process.

> **Provenance.** MOZCODE is a clean-room, open-source implementation designed from a
> public technical teardown of [WOZCODE](https://wozcode.com) (Woz, YC W25). No
> WOZCODE source, assets, or branding are used. It reconstructs a well-known public
> technique — tree-sitter AST extraction + a local MCP server — from first
> principles. Not affiliated with Woz. MIT-licensed.

## Why it saves tokens

In an agentic loop, the accumulated conversation is re-sent on every turn, so a
file read into context at turn 3 is paid for again at turns 4, 5, 6… until
compaction. Returning *less text per tool call* therefore compounds across the
session. MOZCODE attacks bytes-per-tool-call:

- **code\_read(path, symbol)** → just that function/class + a few context lines.
  No symbol → a collapsed-body outline of the file.
- **code\_outline(path)** → the AST skeleton: every symbol's signature + line span.
- **code\_search(query)** → matches **grouped by their enclosing symbol**, not raw
  lines. Many grep hits collapse into the handful of functions that contain them.
- **code\_edit(path, symbol, new\_source)** → replace a whole symbol in place,
  anchored to its AST span. Validates the file still parses. No re-read afterward.
- **db\_schema(path | connection\_env)** → map an entire SQLite or PostgreSQL
  schema in one metadata-only call: tables/views, columns, keys, and indexes.

Unsupported languages and parse errors **degrade gracefully** to a plain
(line-numbered) read — a tool call never hard-fails.

**Languages with real AST extraction:** TypeScript, TSX, JavaScript, Python.
Anything else falls back to a plain read.

**Databases:** pass a SQLite path directly, or put a PostgreSQL URL in
`DATABASE_URL` (or another environment variable named via `connection_env`).
Credentials never need to appear in a model-visible tool argument.

## Install (local, no account)

```bash
git clone <this-repo> mozcode && cd mozcode
npm install
npm run build
```

Then add it to Claude Code or Codex as a plugin (point your local plugin marketplace
at this directory), or run the server directly for testing:

```bash
node --no-warnings dist/server.js   # speaks MCP over stdio
```

The Claude manifest (`.claude-plugin/plugin.json`) and universal OpenAI/Codex
manifest (`.codex-plugin/plugin.json`) register the same local `mozcode` MCP
server. The OpenAI plugin also bundles a `mozcode` skill that teaches supported
models when to prefer the symbol-level tools. A **SessionStart hook** nudges the
model to use `code_*` for source files, and the three dashboard/status commands
remain available.

## Commands

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `/moz-savings`   | Estimated tokens saved this session and all-time.            |
| `/moz-status`    | Server status: supported languages, metering store location. |
| `/moz-dashboard` | Regenerate and open the local HTML savings dashboard.        |

## The savings dashboard

`/moz-dashboard` reads the metering log and writes a single self-contained,
theme-aware HTML file to `~/.mozcode/dashboard.html` (no server, works offline).
It includes a measured savings hero, modelled impact metrics, cumulative and
per-tool charts, top files, a session ledger, a manual theme switch, and fully
disclosed assumptions.

### On the honesty of the numbers

Savings are an **estimate against a counterfactual**. MOZCODE knows what it returned
and what a naive whole-file `Read` / plain `grep` of the same target *would have*
returned, and records the difference. Tokens are estimated at \~4 chars/token. This
illustrates the mechanism; it is **not a billing figure**, and the baseline (what
you would have spent otherwise) cannot be directly observed. The dashboard says so
on its face.

## Architecture

```javascript
Claude Code / Codex / OpenAI model session
  ├─ .mcp.json spawns  node dist/server.js   (local stdio)
  │     └─ 4 code tools + db_schema + 3 moz_* tools; records metering in-process
  ├─ hooks/session-start.mjs   → CWD + "prefer code_* tools" nudge
  └─ commands/                 → /moz-savings /moz-status /moz-dashboard
```

- `src/ast/` — tree-sitter loader + a controlled tree walk that captures top-level
  and class-member symbols (without descending into function bodies).
- `src/tools/` — the four tools, each with one job and a graceful fallback.
- `src/db/` — cached, read-only SQLite/PostgreSQL structural introspection.
- `src/metering/` — append-only JSONL store + aggregation.
- `src/dashboard/` — pure `Summary → HTML` renderer (validated data-viz palette).

**Design note:** the teardown described a PostToolUse hook for metering; MOZCODE
records in-process instead, because a shell hook only sees tool *text*, not the
structured baseline/actual counts. This is more reliable and keeps the hook surface
to a single SessionStart nudge (rather than intercepting every tool call).

## Develop

```bash

npm test          # engine, tools, DB schema, metering, dashboard, stdio integration
npm run build     # tsc + bundle grammars into grammars/
npm run dev       # run the server from source (tsx)
npm run benchmark:performance  # DB discovery + raw cold/warm latency
```

Design spec: [`docs/superpowers/specs/2026-07-24-mozcode-design.md`](docs/superpowers/specs/2026-07-24-mozcode-design.md).

## License

MIT.
