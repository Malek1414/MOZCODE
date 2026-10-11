# Area: Design docs

This area holds two prose files and no code. `README.md` is the user-facing contract: what the tools do, how to install, how honest the numbers are, and the architecture. `docs/superpowers/specs/2026-07-24-mozcode-design.md` is the original MVP design spec, marked "Status: approved, executing" (`spec:3`). It is the record of how MOZCODE reconstructs WOZCODE's technique: tree-sitter AST, a local stdio MCP server and model routing (`spec:7-13`).

For this area, "meaningful functions" means the contracts each document makes about the code: tool contracts, hooks, metering, the dashboard, layout and build. I checked every contract against the source. Where a doc no longer matches the code, I list it as drift, because drift is what improvement passes and the recap video would otherwise repeat as fact.

Files: 2. Mapped contract sections: 14 (README 8, spec 6 groups). Drift findings: 9.

---

## README.md
**Purpose:** The user-facing description, install guide and architecture overview of MOZCODE v0.3.0.

### Tool surface ("Why it saves tokens"), `README.md:19-44`
- **What:** It promises five model-facing tools: `code_read`, `code_outline`, `code_search`, `code_edit` and `db_schema` (`:26-34`). It also promises graceful degradation, so that "a tool call never hard-fails" (`:36-37`), and AST support for TS, TSX, JS and Python only (`:39-40`).
- **How (verified):** All of these tools are registered in `src/server.ts:79,99,115,134,154`. Postgres credentials come from an environment variable named by `connection_env` (`:42-44`). That env-var indirection keeps secrets out of model-visible arguments.
- **Why:** This is the token-saving mechanism. Each call carries fewer bytes, and the saving compounds because context is re-sent every turn (`:21-24`).
- **Risks:** None in the text itself.

### Install / Codex registration, `README.md:46-90`
- **What:** Using it as a plugin needs no build step, because `dist/` and `grammars/*.wasm` are committed (`:54-57`). Codex needs `npm run install:codex` (`:66-79`), which exists at `package.json` `"install:codex": "node scripts/install-codex.mjs"`.
- **Why:** Codex does not expand `${CLAUDE_PLUGIN_ROOT}` (`:73-75`). See the plugin-integration map.
- **Risks:** `:49` uses a `<this-repo>` placeholder in place of the real clone URL `Malek1414/MOZCODE`. That is minor.

### Status line, `README.md:92-122`
- **What:** It shows the status line format (`:97`), registration through the SessionStart hook into `~/.claude/settings.json` (`:100-104`), a 5-second refresh (`:103`), Codex non-support (`:106-111`), and a conservative install policy: no clobbering, repoint on upgrade, refuse unparseable JSON, and the `MOZCODE_NO_STATUSLINE=1` opt-out (`:113-122`).
- **How (verified):** The 5-second refresh comes from `REFRESH_INTERVAL_SEC = 5` in `hooks/statusline-install.mjs:28`, and the "current" check is at `:63`.
- **Risks:** None found.

### Commands table, `README.md:124-130`
- **What:** It lists `/moz-savings`, `/moz-status` and `/moz-dashboard`. These map to `commands/moz-*.md` and the MCP tools `moz_savings`, `moz_status` and `moz_dashboard` (`src/server.ts:186,197,208`).
- **Risks:** None found.

### Dashboard + "On the honesty of the numbers", `README.md:132-147`
- **What:** The dashboard writes a self-contained HTML file to `~/.mozcode/dashboard.html` (`:134-138`). Savings are counterfactual estimates (`:142-147`).
- **Risks (DRIFT, high):** `:144` says "Tokens are estimated at ~4 chars/token". The code actually uses the `gpt-tokenizer` o200k_base BPE (`src/util/tokens.ts:1,16-19`), and uses chars/4 only as a fallback when an exception is caught (`:21-23`). The same stale claim appears in the shipped dashboard's "auditable" assumptions list at `src/dashboard/render.ts:314`. This is a real correctness bug, not only a docs problem: the page that calls its assumptions auditable states the wrong tokenizer. The README also never mentions dollar or round-trip estimates, yet the status line example (`:97`) shows `$` figures, and the dashboard derives them from `inputPricePerM` and related values (`src/dashboard/render.ts:308-313`).

### Architecture, `README.md:149-169`
- **What:** It contains a tree of host → `dist/server.js` with "4 code tools + db_schema + 3 moz_* tools" (`:154`), the SessionStart hook and `commands/`, plus per-directory notes for `src/ast`, `src/tools`, `src/db`, `src/metering` and `src/dashboard` (`:159-164`).
- **Why:** The design note at `:166-169` explains why metering moved from the PostToolUse hook in the spec to in-process recording: a shell hook sees only tool text, not the structured baseline and actual counts. This is the only written rationale for diverging from the spec.
- **Risks (DRIFT, low):** The tree leaves out `agents/` (`agents/moz-code.md`, `agents/moz-explore.md`), `skills/mozcode/SKILL.md`, `src/statusline.ts` and `src/util/`. It also leaves out the status line install that `hooks/session-start.mjs` performs.

### Develop, `README.md:171-181`
- **What:** It lists the dev commands and links to the design spec (`:181`).
- **Risks (DRIFT, medium):** `:176` says `npm run build  # tsc + bundle grammars into grammars/`. The real build is `node scripts/bundle.mjs`, which is an esbuild bundle (`scripts/bundle.mjs:5`) plus a wasm copy (`:33-38`). It does no `tsc`. Type checking is a separate script, `npm run typecheck`, which the README does not list. `:175` lists `npm test` but leaves out `benchmark:tokens`. The code block opens with an empty line (`:174`), which is cosmetic.

### Provenance / License, `README.md:13-17,183-185`
- **What:** It describes a clean-room reconstruction from a public teardown of WOZCODE, under the MIT license.
- **Risks:** Legal framing only. "No WOZCODE ... assets ... are used" (`:15`) should be re-checked against commit history, which mentions porting WOZCODE's dashboard background (from the system overview). I could not verify that from this area.

---

## docs/superpowers/specs/2026-07-24-mozcode-design.md
**Purpose:** The approved MVP design spec. It sets the goals, non-goals, tool contracts, AST engine, metering, hooks, dashboard, testing, layout and build order. Line references below use the prefix `spec:`.

### Goals & non-goals, `spec:19-40`
- **What:** The MVP is four tools, real AST for TS/TSX/JS/Python, JSONL metering, two hooks, skills, and a local dashboard (`:26-34`). Non-goals: Haiku routing, `/woz-kb`, accounts and remote services (`:36-40`).
- **Risks (DRIFT, medium):** The spec lists "Custom routed sub-agents / cheap-model (Haiku) routing" as a non-goal (`:37`). The repo now ships `agents/moz-explore.md` and `agents/moz-code.md`, and its marketplace description advertises "Haiku-routed agents". `db_schema` and the status line are also out of scope here. The spec was never updated to record these scope changes.

### Architecture / hooks, `spec:42-61, 100-107`
- **What:** Two hooks, SessionStart and PostToolUse (`:32,52-54,105-107`).
- **Risks (DRIFT, medium):** No PostToolUse hook exists. `hooks/` contains only `hooks.json`, `session-start.mjs` and `statusline-install.mjs`. Metering moved in-process, as the README explains at `:166-169`. The names `sessionstart.js` and `posttooluse.js` (`spec:53-54,151`) no longer match the real files either.

### Tool contracts, `spec:63-72`
- **What:** It sets each tool's inputs and outputs and the "degrade rather than throw" rule.
- **Risks (DRIFT, medium):** For `code_search` the spec says "Ripgrep for hits" (`:69`). The implementation does not shell out to ripgrep. It builds a JS `RegExp` straight from the model-supplied query (`src/tools/search.ts:18-23`) and walks files in-process, capped at `MAX_MATCHES = 200` (`:9,61,65`). Using an unvalidated regex this way creates a catastrophic-backtracking (ReDoS) risk on the server's single event loop, and the spec's ripgrep design would have avoided it. That risk belongs to the tools area, but the drift starts here.

### AST engine, `spec:74-84`
- **What:** It calls for lazily initialised parsers, bundled wasm, per-language `.scm` queries, dotted symbol resolution, and a fallback ladder.
- **Risks (DRIFT, low):** No `.scm` query files and no `Query(` usage exist in `src/ast/`. The README describes a "controlled tree walk" instead (`README.md:159-160`). The layout in `spec:155-156` (`ast/queries/typescript.scm`) is therefore stale. The real files are `engine.ts`, `file-cache.ts`, `languages.ts` and `loader.ts`.

### Savings metering, `spec:86-98`
- **What:** It specifies `ceil(chars/4)` tokens, a store at `~/.mozcode/metering/<project-hash>.jsonl`, and snake_case fields.
- **Risks (DRIFT, low):** Tokens are now counted with BPE (`src/util/tokens.ts:16-19`). The file name is `${base}-${hash}.jsonl` (`src/metering/store.ts:30`). Records use camelCase `baselineTokens`, `actualTokens`, `savedTokens` and include a `session` field (`src/metering/store.ts:7-16`), and a session pointer lives under `~/.mozcode/sessions/` (`:57-75`). The location can be overridden with `MOZCODE_HOME` (`:20`), which neither doc mentions.

### Skills / dashboard / errors / testing / layout / build order, `spec:109-174`
- **What:** It names three skills, five dashboard screens, the error-handling ladder, the test tiers, the repo layout and a nine-step build order.
- **Risks (DRIFT, low):** The `/moz-*` entries are now `commands/*.md` plus a single `skills/mozcode/SKILL.md`, not the `skills/mozcode-savings/`-style folders the spec lists (`:152`). The layout leaves out `src/db`, `src/util`, `src/statusline.ts`, `src/dashboard/{generate,metrics,saira-font}.ts`, `scripts/`, `.claude-plugin/`, `.codex-plugin/` and `agents/`. The spec's status line still reads "approved, executing" (`:3`), although the project shipped v0.3.0.

---

## Hot spots (ranked)
1. **The tokenizer disclosure is wrong in shipped output** (high, quality). `src/dashboard/render.ts:314` and `README.md:144` say "~4 chars/token", but the code uses o200k BPE (`src/util/tokens.ts:16-19`). The "auditable assumptions" are therefore false. Fix the render string and the README.
2. **The `code_search` regex is built from model input and runs without ripgrep** (medium, security). The spec promised ripgrep (`spec:69`). The implementation runs `new RegExp(query)` in-process (`src/tools/search.ts:18-23`), so a pathological pattern can block the stdio server.
3. **The README build docs are wrong** (medium, quality). `npm run build` is presented as "tsc + bundle" (`README.md:176`), but it only runs esbuild (`scripts/bundle.mjs:5`), and `typecheck` is undocumented. A contributor may assume the build type-checks.
4. **The spec is stale on hooks, scope and layout** (medium, quality). The PostToolUse hook is gone, Haiku agents were added despite being a non-goal, `db_schema` and the status line are missing, and the `.scm` queries never existed (`spec:32,37,53-54,69,77,151-158`). The spec should be marked superseded, or carry a "deviations" section.
5. **Dollar and round-trip figures are not disclosed in the README** (low, quality). The status line shows `$` values (`README.md:97`), but the honesty section covers tokens only. The price assumptions are visible only on the dashboard (`src/dashboard/render.ts:308-313`).
6. **The README architecture tree is incomplete** (low, quality). It leaves out `agents/`, the `skills/mozcode` skill, `src/statusline.ts`, `src/util/` and the `MOZCODE_HOME` override.
