# MOZCODE

**A symbol-level MCP server for Claude Code that cuts input-token consumption.**
MOZCODE hands the model the *symbol it asked for* — a single function, class, or
method — instead of a whole file. It parses source with tree-sitter, anchors edits
to AST spans so the model never re-reads a file after editing, routes broad
read-only exploration to a cheaper model, and meters the estimated savings to a
local, Saira-styled dashboard.

Everything runs **locally**. No account, no proxy, no server ever receives your
code — the MCP server is a local stdio process, and the dashboard is a static HTML
file on your disk.

> **Provenance & disclaimer.** MOZCODE is a **clean-room, open-source
> implementation** designed from a public technical teardown of
> [WOZCODE](https://wozcode.com) (Woz, YC W25). No WOZCODE source code, assets, or
> branding are used. It reconstructs a well-known *public* technique — tree-sitter
> AST extraction served over a local MCP server, plus cheap-model routing — from
> first principles. **Not affiliated with, endorsed by, or connected to Woz.**
> MIT-licensed.

---

## Table of contents

- [Why it saves tokens](#why-it-saves-tokens)
- [How it works](#how-it-works)
- [The tools](#the-tools)
- [Agents (model routing)](#agents-model-routing)
- [The savings dashboard](#the-savings-dashboard)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Attach as a plugin to Claude Code](#attach-as-a-plugin-to-claude-code)
- [Commands](#commands)
- [Development](#development)
- [Repo layout](#repo-layout)
- [Honesty about the numbers](#honesty-about-the-numbers)
- [License & attribution](#license--attribution)

---

## Why it saves tokens

In an agentic coding loop, the accumulated conversation is **re-sent on every
turn**. A 400-line file read into context at turn 3 is paid for again at turns 4,
5, 6… until compaction. So a token wasted on an over-broad read early in a session
is billed repeatedly. Attacking **bytes-per-tool-call** therefore compounds across
the session — which is why returning *less text per call* can plausibly cut
25–50% of input tokens even though the technique itself is unglamorous.

MOZCODE's levers:

1. **Return a symbol, not a file.** A request for `Account.deposit` gets that method
   plus a few lines of context — not the 2,000-line module it lives in.
2. **Return a map before the territory.** `code_outline` gives the AST skeleton
   (every signature + line span, bodies omitted) so the model navigates before it
   reads.
3. **Group search hits by symbol.** Many grep matches collapse into the handful of
   functions/classes that contain them.
4. **Edit without re-reading.** Edits target an AST node by name, so after an edit
   the model already knows the new span — no confirming re-read.
5. **Explore on a cheaper model.** Broad read-only scans route to a Haiku-pinned
   sub-agent.

## How it works

1. Claude Code loads the plugin, which spawns a **local Node stdio MCP server**
   (`node dist/server.js`).
2. A **SessionStart hook** injects the working directory and nudges the model to
   prefer MOZCODE's `code_*` tools over the built-in whole-file `Read`/`Grep` for
   source files.
3. When the model calls a MOZCODE tool, the server parses the target file into a
   tree-sitter AST (WASM grammars for TypeScript, TSX, JavaScript, Python), extracts
   just the requested symbol or a compact outline, and returns that.
4. The server records, per call, how many tokens it returned versus what a naive
   whole-file `Read`/plain `grep` of the same target *would have* returned. This
   append-only metering lives at `~/.mozcode/metering/*.jsonl`.
5. `/moz-dashboard` renders that metering into a self-contained HTML dashboard.

**Graceful degradation:** an unsupported language or a parse error never hard-fails
a tool call — the server falls back to a plain, line-numbered read and flags the
result `degraded`. A missing symbol returns the file's outline so the model can
retry with a valid name.

## The tools

| Tool | Input | Returns |
|---|---|---|
| `code_outline` | `path` | AST skeleton: every symbol's signature + line span, bodies omitted. |
| `code_read` | `path`, `symbol?`, `context_lines?` | The named symbol's source + N context lines; or a whole-file outline when no symbol is given. |
| `code_search` | `query`, `path_glob?` | Matches grouped by their **enclosing** function/class (signature + location), not raw lines. |
| `code_edit` | `path`, `symbol`, `new_source` | Replaces the symbol's AST span in place, validates the file still parses, and confirms the new span — no re-read needed. |

Plus three management tools: `moz_savings`, `moz_status`, `moz_dashboard` (surfaced
as the `/moz-*` slash commands).

**Languages with real AST extraction:** TypeScript, TSX, JavaScript, Python.
Everything else falls back to a plain read.

## Agents (model routing)

MOZCODE ships two sub-agents so exploration runs cheap and editing stays capable:

- **`moz-explore`** — read-only codebase exploration ("where is X defined / used",
  "how does Y flow"). **Pinned to Haiku**, so broad scans cost a fraction of the
  main model. It can only read/search — never edit.
- **`moz-code`** — the main coding agent. Full read/write tools, but disciplined:
  it reads by symbol, searches by symbol, edits by AST span, and **delegates
  open-ended scans to `moz-explore`** rather than burning main-model tokens on them.

Routing exploration to a cheaper model is the second big lever (after
bytes-per-call); the two compound.

## The savings dashboard

`/moz-dashboard` reads the metering log and writes a single **self-contained,
theme-aware HTML file** to `~/.mozcode/dashboard.html`, then opens it. No server,
no account, works offline — the [Saira](https://fonts.google.com/specimen/Saira)
typeface (the font WOZCODE's own site uses) is embedded as base64 so it renders
in-brand with nothing leaving the machine.

Six headline metrics, modeled on WOZCODE's login dashboard:

| Metric | Source |
|---|---|
| **Tokens saved** | Measured directly (input tokens not sent). |
| **Efficiency gain** | Measured directly (avg payload reduction vs. baseline). |
| **Cost saved** | Derived: tokens × input price + output of avoided round-trips. |
| **API cost saved** | Derived: tokens saved × input token price. |
| **Time saved** | Derived: avoided round-trip latency + prompt-prefill time. |
| **LLM calls saved** | Derived: re-reads (edits) + consolidated searches. |

Every **derived** figure is badged `est` and computed from an **auditable
assumptions block printed on the dashboard itself** (input price, per-call cost,
latency, etc.). Plus per-KPI sparklines, a cumulative-savings area chart, a
"where the savings come from" breakdown by tool, and a per-session log.

## Architecture

```
Claude Code session
  ├─ .mcp.json / plugin.json spawn:  node --no-warnings dist/server.js   (stdio, alwaysLoad)
  │     ├─ 4 code tools: code_read / code_outline / code_search / code_edit
  │     ├─ 3 mgmt tools: moz_savings / moz_status / moz_dashboard
  │     └─ records per-call savings to ~/.mozcode/metering/*.jsonl (in-process)
  ├─ hooks/session-start.mjs   → inject CWD + "prefer code_* tools" nudge
  ├─ agents/  moz-code (main) · moz-explore (read-only, Haiku)
  └─ commands/  /moz-savings  /moz-status  /moz-dashboard
```

- `src/ast/` — tree-sitter loader + a controlled tree walk that captures top-level
  and class-member symbols (without descending into function bodies), with dotted
  symbol resolution (`Class.method`) and a graceful fallback ladder.
- `src/tools/` — the four tools, each with one job.
- `src/metering/` — append-only JSONL store + aggregation.
- `src/dashboard/` — pure `Summary → HTML` renderer + KPI derivations + embedded font.

**Design note:** the original teardown described a PostToolUse hook for metering;
MOZCODE records **in-process** instead, because a shell hook only sees tool *text*,
not the structured baseline/actual token counts. This is more reliable and keeps the
hook surface to a single SessionStart nudge rather than intercepting every tool call.

## Tech stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript on Node.js (ESM), spawned via `node --no-warnings` |
| MCP | `@modelcontextprotocol/sdk` (low-level `Server`, stdio transport) |
| Parsing | `web-tree-sitter` (WASM) + `tree-sitter-wasms` grammars — no native addon build |
| Tests | Vitest — engine, tools, metering, dashboard, and a real stdio integration test |
| Dashboard | Hand-rolled inline SVG (validated data-viz palette), Saira font embedded as base64 |

## Attach as a plugin to Claude Code

MOZCODE ships **pre-bundled** — `dist/server.js` is a single self-contained file
with every dependency inlined, and the tree-sitter wasm grammars are committed
alongside it. There is **no build step and no `npm install`**. You only need Node 18+
(which Claude Code already requires).

```
# In Claude Code:
/plugin marketplace add Malek1414/MOZCODE
/plugin install mozcode@mozcode
```

(Or point at a local clone: `/plugin marketplace add /absolute/path/to/MOZCODE`.)

Then reload plugins / restart the session and verify it's live:

```
/moz-status
```

You should see the supported languages and the metering store path. From then on
the model will prefer MOZCODE's symbol-level tools for code; check savings any time
with `/moz-savings`, or open the dashboard with `/moz-dashboard`.

Running the bundled server standalone (for debugging) needs nothing installed:

```bash
node --no-warnings dist/server.js   # speaks MCP over stdio, no node_modules required
```

## Commands

| Command | What it does |
|---|---|
| `/moz-savings` | Estimated tokens saved this session and all-time. |
| `/moz-status` | Server status: supported languages, metering store location. |
| `/moz-dashboard` | Regenerate and open the local HTML savings dashboard. |

## Development

Contributors (not needed to *use* the plugin — only to change it):

```bash
npm install          # dev dependencies
npm run dev          # run the server from source (tsx), for iteration
npm test             # full suite (32 tests)
npm run typecheck    # tsc --noEmit
npm run build        # esbuild → self-contained dist/server.js + wasm in grammars/
node scripts/verify-bundle.mjs   # prove the bundle runs with no node_modules
```

The committed `dist/server.js` and `grammars/*.wasm` are the shipped artifacts;
re-run `npm run build` after changing `src/` and commit the updated bundle.

Design spec: [`docs/superpowers/specs/2026-07-24-mozcode-design.md`](docs/superpowers/specs/2026-07-24-mozcode-design.md).

## Repo layout

```
MOZCODE/
  .claude-plugin/  plugin.json · marketplace.json
  .mcp.json        MCP server registration
  agents/          moz-code.md · moz-explore.md
  commands/        moz-savings.md · moz-status.md · moz-dashboard.md
  hooks/           hooks.json · session-start.mjs
  src/
    server.ts      MCP wiring
    ast/           loader.ts · engine.ts · languages.ts · queries/
    tools/         outline.ts · read.ts · search.ts · edit.ts · types.ts
    metering/      store.ts
    dashboard/     render.ts · metrics.ts · generate.ts · saira-font.ts
    util/          files.ts · tokens.ts
  grammars/        *.wasm (bundled at build)
  test/            engine · tools · metering · dashboard · integration
```

## Honesty about the numbers

Only **tokens saved** and **efficiency gain** are measured directly. Everything
else — cost, time, LLM calls — is **derived** from those via the stated
assumptions, and every derived figure is labelled an estimate on the dashboard. The
baseline (what you *would* have spent) is a counterfactual that cannot be directly
observed, so these numbers illustrate the mechanism; they are **not a billing
figure**. Token counts use a ~4-chars/token heuristic.

## License & attribution

- Code: **MIT**.
- Typeface: **Saira**, © The Saira Project Authors, SIL Open Font License 1.1.
- Independent clean-room project inspired by a public teardown of WOZCODE. Not
  affiliated with Woz.
