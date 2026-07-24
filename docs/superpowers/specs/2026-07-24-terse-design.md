# Terse — Symbol-Level MCP Server for Claude Code

*Design spec · 2026-07-24 · Status: approved, executing*

## Provenance & legal

Terse is a **clean-room open-source implementation** designed from a public technical
teardown of WOZCODE (a closed-source Claude Code plugin by Woz, YC W25). No WOZCODE
source code, assets, or branding are used or copied. The teardown itself is built entirely
from public sources and states plainly that WOZCODE's mechanism is a well-known public
technique (tree-sitter AST parsing + a local stdio MCP server + model routing) with nothing
proprietary in the request path. Terse reconstructs that *mechanism* from first principles.
Original name, MIT-licensed.

Where the teardown could not observe something (e.g. WOZCODE's exact tool surface, or what
its remote dashboard actually renders), Terse does **not** claim to replicate it. It builds an
honest analog and labels estimates as estimates.

## 1. Goal & non-goals

**Goal.** A local, zero-server Claude Code plugin that reduces input-token consumption by
returning *symbols and structural outlines instead of whole files*, supports AST-anchored
edits (no re-read after edit), and meters estimated savings — faithfully reproducing the core
token-saving mechanism described in the teardown (§4.2).

**In scope (MVP).**
- Local stdio MCP server (Node + TypeScript).
- Four symbol-aware tools: `code_outline`, `code_read`, `code_search`, `code_edit`.
- Real AST extraction for TypeScript, TSX, JavaScript, Python (tree-sitter WASM grammars).
- Graceful fallback to whole-file / line-range reads for unsupported languages or parse errors.
- Savings metering (estimated counterfactual bytes) persisted to a local JSONL store.
- Two hooks: SessionStart (CWD inject + tool-preference nudge), PostToolUse (record metering).
- Skills: `/terse-savings`, `/terse-status`, `/terse-dashboard`.
- Local self-contained HTML savings dashboard driven by real metering data.

**Non-goals (explicitly cut).**
- Custom routed sub-agents / cheap-model (Haiku) routing.
- Knowledge-base code reviewer, tuning loop, backtesting (WOZCODE's `/woz-kb`).
- OAuth, accounts, billing, quota, remote services of any kind.
- Any pixel-accurate replica of WOZCODE's remote dashboard (unobservable — see Provenance).

## 2. Architecture

100% local. Nothing leaves the machine.

```
Claude Code session
  |
  |- .mcp.json spawns:  node dist/server.js   (stdio, alwaysLoad)
  |     \- Terse MCP server: 4 tools + metering recorder
  |
  |- hooks/
  |     - sessionstart.js  -> inject CWD; nudge model toward code_* tools
  |     - posttooluse.js    -> append per-call savings to metering store
  |
  \- skills/  /terse-savings  /terse-status  /terse-dashboard  (read metering store)
```

The server is one process built around a **tree-sitter AST engine** using `web-tree-sitter`
(WASM grammars) to avoid native-addon build friction across user machines. Symbol extraction
and edit anchoring both go through this engine.

## 3. Tool contracts

| Tool | Input | Returns |
|---|---|---|
| `code_outline` | `path` | AST skeleton: each symbol as `kind name(signature) @Lstart-Lend`, bodies omitted. |
| `code_read` | `path`, `symbol?`, `context_lines?` | No symbol -> collapsed-body outline of whole file. With symbol -> that node's full source + N context lines. Unsupported/parse-fail -> line-ranged whole-file read with `degraded: true`. |
| `code_search` | `query`, `path_glob?` | Ripgrep for hits, then return each hit's **enclosing symbol signature + location**, deduped — not raw lines. Falls back to raw line matches when no enclosing symbol resolves. |
| `code_edit` | `path`, `symbol`, `new_source` | Replace the named node's byte span in place; re-parse to validate it still parses; return compact confirmation (symbol + new span). No re-read required. |

Each tool has one job and is independently testable. Every tool degrades rather than throws.

## 4. AST engine

- One lazily-initialized `Parser` per language; grammars loaded from bundled `.wasm`.
- A small **tree-sitter query per language** (`.scm`) identifies symbols: functions, methods,
  classes, exported/const declarations (TS/JS); `def`, `class`, decorated defs (Python).
- **Symbol resolution:** dotted paths (`ClassName.method`) resolve by walking the tree.
- **Fallback ladder:** unsupported extension -> whole-file/line-range read; parse error ->
  raw text with `degraded: true`; missing symbol -> return the file outline so the model can
  retry with a valid symbol name. A tool request never hard-fails on recoverable conditions.

Language set is the only per-language work; the rest of the pipeline is language-agnostic.

## 5. Savings metering (honest counterfactual)

The teardown flags (open q#4) that savings are measured against an *unobservable* baseline.
Terse does not fake precision:

- On each `code_read` / `code_outline` / `code_search`, the server holds both what it
  **returned** and what a naive `Read`/grep of the same target **would have** returned.
- It records `baseline_tokens - actual_tokens` per call. Tokens are estimated as
  `ceil(chars / 4)` and **labelled as an estimate**, not a billing figure.
- Records append to per-project JSONL at `~/.terse/metering/<project-hash>.jsonl`, each line:
  `{ ts, tool, path, project, baseline_tokens, actual_tokens, saved_tokens }`.
- `/terse-savings` and the dashboard aggregate these with an explicit "estimated, illustrative"
  disclaimer.

## 6. Hooks

Two only — deliberately narrower than WOZCODE's 11-hooks-on-every-event surface, which the
teardown notes carries a low community trust score (§4.4).

- **SessionStart:** inject working directory; add a short system-prompt nudge to prefer
  `code_*` tools over `Read`/`Grep` for source files.
- **PostToolUse:** record metering for Terse tools only. No interception of other tools.

## 7. Skills

- `/terse-savings` — session + all-time estimated savings (text).
- `/terse-status` — server health, loaded grammars, supported languages, store location.
- `/terse-dashboard` — regenerate and open the local HTML dashboard.

## 8. Local savings dashboard

A `/terse-dashboard` skill reads `~/.terse/metering/*.jsonl` and renders a **single
self-contained HTML file** (inline CSS/JS, data embedded as JSON) to `~/.terse/dashboard.html`,
then opens it. No running server, no account — consistent with the zero-server ethos.

Screens, all from real metering data, every total labelled *estimated*:
- **Stat tiles:** total estimated tokens saved (all-time), calls intercepted, average payload
  reduction %, active projects.
- **Savings over time** — cumulative line chart (per day/session).
- **Savings by tool** — bar (`code_read` / `code_outline` / `code_search`).
- **Top files by reduction** — ranked table/bar.
- **Session log** — per-session table: calls, baseline vs actual tokens, delta.

Theme-aware (light/dark), accessible palette, no external assets (works offline). Framed as
Terse's own dashboard — an analog of WOZCODE's savings view, not a claimed replica.

## 9. Error handling

Unsupported language -> fallback read (`degraded: true`). Parse failure -> raw text +
`degraded`. Missing symbol -> outline of available symbols. Missing file -> clear error
mirroring the built-in's message. No recoverable condition throws.

## 10. Testing

- **Unit (TDD):** AST engine per language against fixtures (TS, TSX, Python) with known
  symbols; assert extraction spans and edit byte-ranges (red -> green).
- **Tool contract tests:** each tool against fixtures, including the fallback ladder.
- **Metering test:** assert `baseline - actual` accounting on a known file.
- **Integration smoke:** spawn the server over stdio, list tools, call each once.

## 11. Repo layout

```
terse/
  .mcp.json
  hooks/            sessionstart.js, posttooluse.js
  skills/           terse-savings/, terse-status/, terse-dashboard/
  src/
    server.ts       MCP wiring (@modelcontextprotocol/sdk)
    ast/engine.ts   parser mgmt + queries + symbol resolution
    ast/queries/    typescript.scm, python.scm
    tools/          outline.ts, read.ts, search.ts, edit.ts
    metering/store.ts
    dashboard/render.ts
  grammars/         *.wasm (bundled)
  test/
```

## 12. Build order

1. AST engine + TS/JS extraction (TDD)
2. `code_outline` + `code_read`
3. `code_search`
4. `code_edit`
5. Python grammar
6. Metering + `/terse-savings`
7. Hooks + `/terse-status`
8. Dashboard + `/terse-dashboard`
9. Integration smoke + README
