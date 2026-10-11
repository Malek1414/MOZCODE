# Area: Tests & fixtures

Paths: `test/codex-compat.test.ts` (143 lines), `test/dashboard.test.ts` (82), `test/db-schema.test.ts` (66),
`test/engine.test.ts` (81), `test/integration.test.ts` (123), `test/metering.test.ts` (41),
`test/packaging.test.ts` (203), `test/plugin-manifest.test.ts` (20), `test/statusline.test.ts` (124),
`test/tools.test.ts` (125), `test/fixtures/sample.py` (26), `test/fixtures/sample.ts` (39).

12 files, 72 test cases (all passing per `.repochad/last_test.log`, about 2.1 s total), and 13 test helper functions mapped.

Runner: vitest 3 (`package.json` script `"test": "vitest run"`). `vitest.config.ts` includes `test/**/*.test.ts`,
uses `environment: "node"` and sets `testTimeout: 20000`.

The suite works on two layers:
- **Unit tests** import TypeScript from `src/` directly: engine, tools, metering, dashboard, db-schema and packaging.
  The imports are `src/ast/engine`, `src/ast/languages`, `src/tools/{outline,read,search,edit,types}`, `src/metering/store`,
  `src/dashboard/{render,metrics}`, `src/db/schema`, `src/version` and `hooks/statusline-install.mjs`.
- **Black-box tests** spawn the committed bundles `dist/server.js` and `dist/statusline.js` with `node --no-warnings`:
  integration, codex-compat and statusline. These tests check what users actually run, **not** the current `src/`.
  No `pretest` build step exists (`package.json` scripts), so a stale `dist/` is tested as-is. The only staleness
  guard is the VERSION-constant check at `packaging.test.ts:69-75`.

No CI config is present in the repo (no `.github/`), so these tests run only when someone runs them locally.

---

## test/fixtures/sample.ts

**Purpose:** a small TypeScript module with one example of each symbol kind the AST engine must find.
- Contents: an import (`:2`), an exported const `GREETING` (`:4`), `interface User` (`:6-9`), `type UserId` (`:11`),
  `function add` (`:13-15`), an arrow-function const `multiply` (`:17-19`), and `class Account` (`:21-35`), which has a field,
  a constructor, `deposit` and a `private log` method. It also has a non-exported `async function loadConfig` (`:37-39`).
- **Used by:** `engine.test.ts:11`, `tools.test.ts:12` (and as a search root for `code_search` at `:79`), `integration.test.ts:21`
  (copied into the temp project) and `scripts/verify-bundle.mjs:20`.
- **Why:** it pins expectations such as `add`'s exact signature (`engine.test.ts:19`) and the body text that outlines must omit
  (`tools.test.ts:21-22`). Editing the fixture breaks several tests at once, which makes it effectively a contract.

## test/fixtures/sample.py

**Purpose:** the Python counterpart. It has a module docstring, `import os`, the constant `GREETING` (`:5`), `def add` (`:8`),
`class Account` with `__init__`, `deposit` and a `@property`-decorated `is_empty` (`:12-21`), and `async def load_config` (`:24-26`).
- **Used by:** `engine.test.ts:53` only.
- **Risks:** there is no JS, TSX or JSX fixture, although `SUPPORTED_LANGUAGES` covers them (`packaging.test.ts:25`).
  The JS and TSX grammars are checked only for presence on disk, never parsed in a test.

---

## test/engine.test.ts

**Purpose:** unit tests for the tree-sitter symbol extractor (`src/ast/engine.ts`).

### `read(f)` helper (`engine.test.ts:8`)
- Reads a fixture file as UTF-8 with `readFileSync(join(here,"fixtures",f))`.

### describe "TypeScript extraction" (`:10-50`)
- **What:** `extractSymbols(src,"typescript")` returns `hasError:false`. It also returns the kinds function, class, interface, type
  and const for the top-level declarations (`:13-26`). The arrow const `multiply` is classified as `function` (`:20`).
- Class methods get the qualified name `Account.deposit` with `container: "Account"` (`:28-34`).
- Byte spans (`startIndex`/`endIndex`) slice back to exactly `function add ... }` (`:36-42`). This guarantees that `code_edit`
  (span-anchored replace) and `code_read` agree with the source.
- `resolveSymbol` accepts both dotted names and bare names and returns `null` on a miss (`:44-49`).
- **Why:** these are the core behaviours that every `code_*` tool depends on.

### describe "Python extraction" (`:52-74`)
- Checks the kinds function, class, method and variable. A decorated method is still a `method` (`:63`), and its span starts at
  `@property`, so the decorators are captured (`:68-73`).

### describe "error handling" (`:76-81`)
- Broken TS input gives `hasError:true` and does not throw (`:77-80`).
- **Risks:** nothing checks which symbols are still recovered from a partially broken file, and nested functions and
  namespaces are never exercised.

---

## test/tools.test.ts

**Purpose:** unit tests of the four code tools called directly as functions, bypassing MCP.

### `fixture(f)` helper (`tools.test.ts:12`)
- Returns the absolute fixture path.

### `fn(i)` generator (`tools.test.ts:28-33`)
- Builds 40 synthetic six-line functions so the token savings of an outline are measurable on a realistically sized file.

### describe "code_outline" (`:14-48`)
- The outline has signatures but no bodies (`:15-23`). On the 40-function file, `meta.actualTokens < baselineTokens` (`:25-40`).
  An unsupported extension (`.md`) yields `degraded:true` (`:42-47`).
- **Risks:** the temp files at `:34` and `:43` (`os.tmpdir()/mozcode-outline-<ts>.ts`, `mozcode-<ts>.md`) are **never deleted**.
  `Date.now()` names could collide in parallel runs.

### describe "code_read" (`:50-75`)
- Returns a single symbol, not the whole file, with `savedTokens > 0` (`:51-57`). It resolves dotted names (`:59-62`). With no
  symbol it returns an outline (`:64-67`). On a miss it is degraded and lists the available symbols (`:69-74`).

### describe "code_search" (`:77-97`)
- Hits are grouped under qualified names, in the format `Account.deposit [method L<a>-<b>; hit L<n>]` (`:78-85`), with no
  `[top-level]` bucket. A match on `export function add` is attributed to `add`, not to the export statement (`:87-91`).
  An empty result returns "No matches" (`:93-96`).
- **Why:** this pins the output format that the model is told to act on (inferred from the SessionStart nudge).

### describe "code_edit" (`:99-125`)
- `beforeEach` copies `sample.ts` to a random temp path (`:101-104`).
- A valid replacement persists to disk, leaves the rest of the file intact, and can be read back through `codeRead` (`:106-115`).
- A replacement that breaks the parse is rejected and leaves the file byte-identical (`:117-124`).
- **Risks:** there is no `afterEach`, so the copied temp files leak (`:102`). Nothing tests editing a method inside a class,
  editing a Python symbol, or concurrent edits.

---

## test/metering.test.ts

**Purpose:** tests the JSONL savings ledger (`src/metering/store.ts`).
- `beforeEach` sets `process.env.MOZCODE_HOME` to a unique temp path. `afterEach` deletes the variable and removes the directory (`:10-17`).
- "records and reads back" (`:19-25`): two `record()` calls followed by `loadEntries()` give 2 entries, and `savedTokens` is
  computed by `makeMeta` (1000-100 = 900).
- "summarizes" (`:27-40`): over 3 entries in 2 projects, it checks `calls`, `totalSaved`, `projects`, `byTool`, that `byFile` is
  sorted by saved tokens, and that `avgReductionPct > 80`.
- **Risks:** the test mutates global `process.env`, which is safe only because vitest isolates files per worker. No test covers
  `writeCurrentSession`/`readCurrentSession` directly (they are covered only indirectly by `statusline.test.ts`), a corrupt or partial
  JSONL line, or the `topFiles` cap.

---

## test/dashboard.test.ts

**Purpose:** checks that the dashboard HTML renderer and the metric derivations work without a browser.

### `entry(over)` factory (`dashboard.test.ts:6-18`)
- Builds a `MeteringEntry` with defaults plus overrides. `dataset` (`:20-26`) covers all five metered tools across two sessions and two days.

### describe "six-metric dashboard renderer" (`:28-69`)
- Uses string `toContain` checks on `renderDashboard(summarize(dataset))`. The checks cover the six KPI labels (`:29-34`), the
  embedded Saira `@font-face` and the brand (`:36-41`), the disclaimer and the `$3.00` price assumption (`:43-48`), the gauge and
  sparkline classes (`:50-54`), the ARIA labels (`:56-62`), and the empty-state copy (`:64-68`).

### describe "metric derivations" (`:71-82`)
- `computeMetrics` returns `tokensSaved` as the exact sum, and `callsSaved` = 11. The test comment at `:75` gives the formula:
  1 edit + 0.5 per search + 9 DB discovery turns, rounded up. It also checks `costSaved >= apiCostSaved` and an efficiency above 80%.
- **Risks:** the assertions are copy and markup strings, so a harmless wording change breaks them. Meanwhile a real XSS
  regression (for example a file path with `<script>` in `byFile`) is **not** tested; `path` values flow into the HTML. The
  `callsSaved` magic constants are duplicated between the test comment and `metrics.ts`.

---

## test/db-schema.test.ts

**Purpose:** tests `db_schema` against a real SQLite file.
- `beforeEach` creates a temp dir and uses `node:sqlite`'s `DatabaseSync` (`:5`, `:15`) to build 3 tables with an FK, a unique index
  and a view. It then calls `clearDbSchemaCache()`, and `afterEach` removes the directory and clears the cache again (`:12-42`).
- "compact whole-database map" (`:44-52`) checks the summary line, the FK arrow notation
  `organization_id INTEGER!→organizations.id`, the unique-index notation and the view, with `savedTokens > 0`.
- "filters the cached map" (`:54-60`): a query for `organizations` returns that table and `users`, which has an FK to it,
  but excludes `audit_log`.
- "does not accept PostgreSQL credentials as tool input" (`:62-65`): `connectionEnv` names an environment variable that is not
  set, and the call rejects with a clear message.
- **Risks:** `node:sqlite` is experimental and prints `ExperimentalWarning` (`last_test.log`). It appeared in Node 22.5 behind a flag, and `src/db/schema.ts:210` asks for Node 22.12+. `package.json` declares **no
  `engines` field**, so on Node 20 these tests fail at their static `node:sqlite` import. The tool itself does not: `db_schema` imports `node:sqlite` dynamically and falls back to the `sqlite3` CLI (`schema.ts:174,199-206`). The Postgres path has no positive test.
  Its only coverage is the missing-env error.

---

## test/packaging.test.ts

**Purpose:** guards what a user actually installs: committed assets, version agreement, launch descriptors, and the
status-line self-installer. The JSDoc blocks at `:17-22` and `:48-54` explain why.

### describe "shipped assets" (`:23-46`)
- Checks that a `.wasm` file exists for every `SUPPORTED_LANGUAGES` id via `GRAMMAR_FILE` (`:24-29`), plus `tree-sitter.wasm`
  (`:31-33`), `dist/server.js` and `dist/statusline.js` (`:35-38`), and that `package.json.files` includes dist, grammars and hooks (`:40-45`).
- **Why:** the plugin ships with no build step and no node_modules, so a missing asset only fails on a user's machine.

### describe "version consistency" (`:55-76`)
- `package.json`, both plugin manifests and `src/version.ts` agree (`:58-67`). The bundle contains `VERSION = "<v>"` (`:69-75`).
- **Why:** Claude Code re-copies a plugin only when its version changes (`:48-54`).

### describe "client-specific MCP launch configuration" (`:78-102`)
- `.mcp.json` launches `node --no-warnings ./dist/server.js` with `cwd "."` and no `CLAUDE_PLUGIN_ROOT` (`:81-89`).
  The Claude manifest keeps `${CLAUDE_PLUGIN_ROOT}/dist/server.js` and `alwaysLoad:true` (`:91-101`).

### describe "statusline self-install" (`:104-149`), pure
- Uses `planStatusLine(settings, pluginRoot, env?)`. It covers install while preserving other keys (`:108-118`), never clobbering a
  foreign status line (`:120-125`), updating a stale self-entry after an upgrade (`:127-132`), a no-op when already current (`:134-137`),
  the `MOZCODE_NO_STATUSLINE` opt-out (`:139-143`), and `refreshInterval >= 1` (`:145-148`).

### describe "statusline self-install (filesystem)" (`:151-203`)
- Uses `installStatusLine(settingsPath, root)` against a temp `.claude/settings.json`. It covers creating the file (`:163-168`),
  preserving unrelated keys (`:170-179`), refusing an unparsable file and leaving it byte-identical (`:181-190`), refusing when the
  statusline bundle is missing (`:192-196`), and leaving no temp files behind, which shows the write is atomic (`:198-202`).
- **Risks:** the coverage is strong. Gaps: no test covers concurrent sessions racing on settings.json, and `hooks/session-start.mjs`
  itself (the nudge text and the call into the installer) is untested.

---

## test/plugin-manifest.test.ts

**Purpose:** one assertion that `.claude-plugin/plugin.json` has **no** `commands`, `agents` or `hooks` keys, so Claude Code's
folder auto-discovery is used (`:11-19`). This is a regression test for commit `dee4039` ("Fix Claude plugin auto-discovery manifest").

---

## test/codex-compat.test.ts

**Purpose:** guards the Codex launch path and the "which project am I in?" resolution logic (`resolveProject` in `src/server.ts`).

### describe "plugin launch descriptor" (`:9-28`) and "plugin manifest" (`:30-39`)
- `.mcp.json` contains no `${...}` placeholders, because Codex passes them through literally (`:13-15`). It uses `cwd "."` and the
  relative `./dist/server.js`, and that file exists (`:17-21`). `scripts/install-codex.mjs` exists and sets `MOZCODE_TRUST_CWD=1` (`:23-27`).
  `.codex-plugin/plugin.json` paths start with `./` (`:33-38`).
- These checks partly duplicate `packaging.test.ts:81-89`.

### `callTool(cwd, name, args, env?)` (`codex-compat.test.ts:42-99`)
- **What:** spawns `dist/server.js` in `cwd` with `MOZCODE_PROJECT=""` plus any overrides. It then runs a minimal JSON-RPC exchange
  by hand (initialize, then `notifications/initialized`, then `tools/call` id 2) and resolves with `{text, isError}`.
- **How:** newline-delimited JSON framing over stdout (`:61-87`), a 20 s kill timer (`:56-59`), and a kill after the reply (`:79-81`).
- **Why:** it reproduces exactly what Codex does, without the SDK client, to test cwd and env resolution.
- **Risks:**
  - **The spawned server is not given `MOZCODE_HOME`** (`:52`). Every run therefore writes a session pointer
    (`server.ts:307` `writeCurrentSession`) and metering entries (`server.ts:68` `meter`, for the `code_search` calls at
    `:115`, `:123` and `:134`) into the developer's **real `~/.mozcode`**. Test runs inflate the user's real savings dashboard
    and status line.
  - `JSON.parse(line)` at `:69` throws inside a stream event handler, which becomes an uncaught exception rather than a rejection.
  - There is no `child.on("exit")`/`"error"` handler, so a crashing server is reported only after the 20 s timeout.
  - stderr is piped (`:51`) but never read. A chatty server could fill the pipe buffer and stall.

### describe "project resolution guard" (`:41-143`)
- Launched with cwd at the plugin root and no override, `code_search` fails with "could not determine which project" and points to
  `install-codex.mjs` (`:101-106`). `moz_status` still works and reports `UNRESOLVED` (`:108-112`).
- Launched in a real workspace (`root/src`), it works (`:114-120`). `MOZCODE_PROJECT` overrides it (`:122-131`), and so does
  `MOZCODE_TRUST_CWD=1` (`:133-142`).
- **Why:** this is the regression suite for `b827622` ("Fix Codex MCP startup and workspace resolution").
- **Risks:** the tests search the live repo (`query "resolveProject"`), so their results depend on the repo's own source.

---

## test/integration.test.ts

**Purpose:** an end-to-end test over real MCP stdio using the SDK `Client` + `StdioClientTransport` against the committed `dist/server.js`.
- `beforeAll` (`:18-34`) creates temp project and home dirs, copies `sample.ts`, builds a one-table SQLite DB, and spawns the server
  with `MOZCODE_HOME` isolated (`:30`). This is the correct isolation that `codex-compat` lacks. `afterAll` closes the client and removes both dirs (`:36-40`).

### `text(r)` helper (`:77`)
- Joins the text content parts of a tool result.

### Cases
- Exactly eight tools are listed (`:42-48`). The annotations are checked: the read tools are `readOnly/idempotent/!openWorld`,
  `code_edit` is `destructive`, and `db_schema` is `openWorldHint:true` (`:50-75`).
- Each tool is called once: outline (`:79-83`), read (`:85-89`), search (`:91-94`), db_schema (`:96-100`), edit persisted to disk
  (`:102-110`), moz_savings (`:112-115`), and moz_dashboard writing `<home>/dashboard.html` (`:117-122`).
- **Risks:** the cases depend on order. `moz_savings` relies on the earlier calls having been metered, and edit mutates the
  shared fixture copy. The `moz_savings` assertion only checks that the word "saved" appears. `code_edit` is annotated
  `idempotentHint:true` (`:66`), which is true only for identical `new_source`. That is acceptable but worth noting.

---

## test/statusline.test.ts

**Purpose:** a black-box test of `dist/statusline.js` as Claude Code runs it: write JSON to stdin, close stdin, read until exit.

### `runStatusline(home, cwd): Promise<Run>` (`:23-41`)
- Spawns the bundle with an isolated `MOZCODE_HOME`. It records `firstByteMs` and `exitMs` and writes
  `{session_id, cwd, workspace.current_dir}` to stdin.

### `plain(s)` (`:44`)
- Strips ANSI SGR codes.

### `appendEntry(home, project, session, saved)` (`:46-64`) / `writeSessionPointer(home, project, session)` (`:66-72`)
- These write the store files directly: `metering/<base>-<sha1[0:12]>.jsonl` and `sessions/<sha1[0:12]>.session`.
- **Risks:** they **re-implement** the private `projectFile()` naming (`src/metering/store.ts:27`) and the session-pointer naming
  instead of importing them. If the store's naming changes, these helpers silently write files the statusline never reads.
  The tests would then fail with confusing "0 tokens" output, or with a different change they could pass for the wrong reason.

### Cases
- "exits promptly" (`:88-103`) asserts `exitMs - firstByteMs < 150` ms. This is a regression guard for `e2f8a9a`, where a stdin
  safety timer held the event loop for about 500 ms. It also asserts `exitMs < 3000`.
- "no stale cache" (`:105-113`): the second run reflects the appended entries (1.0k, then 5.0k).
- "scopes the session segment" (`:115-123`): splitting on `│` gives the current-session total (2.0k) and the all-time total (11k).
- **Risks:** the 150 ms delta is a timing assertion and may flake on a heavily loaded CI box, although it was chosen to be robust
  (comment at `:97-99`).

---

## Coverage gaps (cross-file)

- Untested modules: `hooks/session-start.mjs`, `scripts/install-codex.mjs` (only checked for a string), `src/ast/file-cache.ts`
  (no invalidation test), `src/ast/loader.ts` (only indirectly), `src/util/files.ts` ignore and filter rules, and `src/dashboard/generate.ts`
  (only via integration). The JS, TSX and JSX parse paths have no tests, and `db_schema` against Postgres has no positive test.
- There are no path-traversal or security tests, for example `code_read` with `../../etc/passwd` or an absolute path outside the
  project, or `db_schema` with a path outside the project. Containment logic that may exist in `server.ts` is unverified by the suite.
- There are no performance or regression thresholds in the suite. Speed benchmarks live in `scripts/benchmark*.ts` and are not run by `npm test`.

## Hot spots (ranked)

1. **codex-compat tests pollute the real `~/.mozcode`** (`test/codex-compat.test.ts:52`). The test spawns the server without `MOZCODE_HOME`,
   so session pointers and metering entries land in the user's real savings data.
2. **Black-box tests exercise the committed `dist/`, not `src/`, and there is no pretest build** (`integration.test.ts:11`,
   `statusline.test.ts:9`, `codex-compat.test.ts:49`). A `src/` fix can pass the unit tests while the shipped bundle stays broken, and the
   reverse can also happen. Only the VERSION string is checked (`packaging.test.ts:69-75`).
3. **No security tests for path containment** (`code_read`/`code_edit`/`db_schema` paths outside the project), and no XSS test for
   dashboard rendering of file paths (`dashboard.test.ts`).
4. **No Node engine constraint**, but the tests and the db tool use `node:sqlite` (experimental; the code's own error asks for Node 22.12+, `schema.ts:210`) (`db-schema.test.ts:5`,
   `integration.test.ts:8`).
5. **The store file naming is duplicated in the test helpers** (`statusline.test.ts:49-52`, `:69-71`) instead of being exported from `store.ts`.
6. **Temp-file leaks** in `tools.test.ts:34`, `:43` and `:102` (no cleanup).
7. **Fragile `callTool` harness**: an uncaught `JSON.parse` exception, no exit/error handler (a failure costs a 20 s timeout), and
   undrained stderr (`codex-compat.test.ts:51-87`).
8. **No CI**, so the guards in `packaging.test.ts` (shipped assets, version drift) protect only developers who run `npm test` locally.
