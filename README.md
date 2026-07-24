# Terse

**A symbol-level MCP server for Claude Code.** Terse returns the *symbol you asked
for* instead of the whole file, so an agentic coding loop spends far fewer input
tokens. It parses source with tree-sitter, hands the model a function/class/method
(or a collapsed outline) rather than 400 lines of context, anchors edits to AST
spans so the model never re-reads a file after editing it, and meters the estimated
savings to a local dashboard.

Everything runs **locally**. There is no account, no proxy, and no server that
receives your code — the MCP server is a local stdio process.

> **Provenance.** Terse is a clean-room, open-source implementation designed from a
> public technical teardown of [WOZCODE](https://wozcode.com) (Woz, YC W25). No
> WOZCODE source, assets, or branding are used. It reconstructs a well-known public
> technique — tree-sitter AST extraction + a local MCP server — from first
> principles. Not affiliated with Woz. MIT-licensed.

## Why it saves tokens

In an agentic loop, the accumulated conversation is re-sent on every turn, so a
file read into context at turn 3 is paid for again at turns 4, 5, 6… until
compaction. Returning *less text per tool call* therefore compounds across the
session. Terse attacks bytes-per-tool-call:

- **`code_read(path, symbol)`** → just that function/class + a few context lines.
  No symbol → a collapsed-body outline of the file.
- **`code_outline(path)`** → the AST skeleton: every symbol's signature + line span.
- **`code_search(query)`** → matches **grouped by their enclosing symbol**, not raw
  lines. Many grep hits collapse into the handful of functions that contain them.
- **`code_edit(path, symbol, new_source)`** → replace a whole symbol in place,
  anchored to its AST span. Validates the file still parses. No re-read afterward.

Unsupported languages and parse errors **degrade gracefully** to a plain
(line-numbered) read — a tool call never hard-fails.

**Languages with real AST extraction:** TypeScript, TSX, JavaScript, Python.
Anything else falls back to a plain read.

## Install (local, no account)

```bash
git clone <this-repo> terse && cd terse
npm install
npm run build
```

Then add it to Claude Code as a plugin (point your plugin config at this directory),
or run the server directly for testing:

```bash
node --no-warnings dist/server.js   # speaks MCP over stdio
```

The plugin manifest (`.mcp.json` / `.claude-plugin/plugin.json`) registers the
`terse` MCP server (`alwaysLoad`), a **SessionStart hook** that nudges the model to
prefer the `code_*` tools for source files, and three commands.

## Commands

| Command | What it does |
|---|---|
| `/terse-savings` | Estimated tokens saved this session and all-time. |
| `/terse-status` | Server status: supported languages, metering store location. |
| `/terse-dashboard` | Regenerate and open the local HTML savings dashboard. |

## The savings dashboard

`/terse-dashboard` reads the metering log and writes a single self-contained,
theme-aware HTML file to `~/.terse/dashboard.html` (no server, works offline):
headline stat tiles, cumulative savings over time, savings by tool, top files by
reduction, and a per-session log.

### On the honesty of the numbers

Savings are an **estimate against a counterfactual**. Terse knows what it returned
and what a naive whole-file `Read` / plain `grep` of the same target *would have*
returned, and records the difference. Tokens are estimated at ~4 chars/token. This
illustrates the mechanism; it is **not a billing figure**, and the baseline (what
you would have spent otherwise) cannot be directly observed. The dashboard says so
on its face.

## Architecture

```
Claude Code session
  ├─ .mcp.json spawns  node dist/server.js   (stdio, alwaysLoad)
  │     └─ 4 code tools + 3 terse_* tools; records metering in-process
  ├─ hooks/session-start.mjs   → CWD + "prefer code_* tools" nudge
  └─ commands/                 → /terse-savings /terse-status /terse-dashboard
```

- `src/ast/` — tree-sitter loader + a controlled tree walk that captures top-level
  and class-member symbols (without descending into function bodies).
- `src/tools/` — the four tools, each with one job and a graceful fallback.
- `src/metering/` — append-only JSONL store + aggregation.
- `src/dashboard/` — pure `Summary → HTML` renderer (validated data-viz palette).

**Design note:** the teardown described a PostToolUse hook for metering; Terse
records in-process instead, because a shell hook only sees tool *text*, not the
structured baseline/actual counts. This is more reliable and keeps the hook surface
to a single SessionStart nudge (rather than intercepting every tool call).

## Develop

```bash
npm test          # 28 tests: engine, tools, metering, dashboard, stdio integration
npm run build     # tsc + bundle grammars into grammars/
npm run dev       # run the server from source (tsx)
```

Design spec: [`docs/superpowers/specs/2026-07-24-terse-design.md`](docs/superpowers/specs/2026-07-24-terse-design.md).

## License

MIT.
