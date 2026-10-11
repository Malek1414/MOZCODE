# Area: Build, benchmarks & dev scripts

Paths: `scripts/bundle.mjs`, `scripts/verify-bundle.mjs`, `scripts/benchmark.ts`, `scripts/benchmark-performance.ts`,
`scripts/gen-dashboard.ts`, `scripts/preview-dashboard.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`.

This area is how MOZCODE is built into the committed, dependency-free `dist/` bundle, how that bundle is checked,
and how the WOZCODE-comparison numbers (token savings, latency) are measured. None of it runs in the user's
request path. Only `dist/` + `grammars/` (produced by `bundle.mjs`) ship.

---

## package.json

**Purpose:** npm manifest. It names the package `mozcode` v0.3.0, declares ESM, lists runtime and dev dependencies, and defines the dev scripts.

- `"type": "module"`: `package.json:6`. All `.mjs`/`.ts` scripts are ESM, so top-level `await` works in `bundle.mjs`, `verify-bundle.mjs` and `gen-dashboard.ts`.
- `bin.mozcode → dist/server.js`: `package.json:7-9`. Running `npx mozcode` starts the bundled stdio server.
- `files`: `package.json:10-21`. The npm payload is the prebuilt artifacts (`dist`, `grammars`), the plugin
  manifests and hooks, and `scripts/install-codex.mjs` only. No `src/`. That matches the "no build step on the user's machine" goal (`scripts/bundle.mjs:1-4`).
  It is asserted by `test/packaging.test.ts:40-42`.
- `scripts`: `package.json:22-31`
  - `build` → `node scripts/bundle.mjs` (esbuild only. There is **no** `tsc` step, although README.md:175 says "tsc + bundle").
  - `typecheck` → `tsc -p tsconfig.json --noEmit` (covers `src/` only, see tsconfig).
  - `dev` → `tsx src/server.ts` (run from source).
  - `test` / `test:watch` → vitest.
  - `benchmark:tokens` / `benchmark:performance` → `node --no-warnings --import tsx scripts/…ts`.
  - **No script** for `verify-bundle.mjs`, `gen-dashboard.ts` or `preview-dashboard.ts`, and nothing chains `build` → `verify-bundle`.
- `dependencies`: `package.json:32-38`: `@modelcontextprotocol/sdk`, `gpt-tokenizer`, `pg`, `tree-sitter-wasms`, `web-tree-sitter`.
  All are inlined by esbuild at build time, so at runtime they matter only for `dev`/tests.
- `overrides["@hono/node-server"] = 2.0.11`: `package.json:47-49`. This pins a transitive dependency of the MCP SDK. Why: I could not determine it from the code. Inferred: a security or compat pin.
- **Risks:**
  - There is no `engines` field. The bundle targets `node18` (`scripts/bundle.mjs:23`), but `db_schema`'s native SQLite path needs Node 22.12+ (`src/db/schema.ts:210` error text), and `benchmark-performance.ts` statically imports `node:sqlite` (`scripts/benchmark-performance.ts:16`).
  - `zod` is used as the benchmark corpus (`scripts/benchmark.ts:49`, `scripts/benchmark-performance.ts:229`) but is not declared. It is only present transitively through `@modelcontextprotocol/sdk` (zod 4.4.3 is installed at present).

## tsconfig.json

**Purpose:** strict TypeScript settings used **only for typechecking** (`npm run typecheck`). Emitting is done by esbuild.

- `module/moduleResolution: NodeNext`, `target ES2022`, `strict: true`: `tsconfig.json:3-9`. This forces the `.js` import suffixes used throughout `src/` and the scripts.
- `include: ["src/**/*.ts"]`, `exclude: [..., "test"]`: `tsconfig.json:17-18`.
- **Risks:**
  - `scripts/*.ts` and `test/*.ts` are **never typechecked**: tsx and vitest strip types without checking. A signature drift in `src/` (for example `codeRead`, `record`) would only surface at benchmark runtime.
  - `outDir: "dist"` + `rootDir: "src"` + `sourceMap: true` (`tsconfig.json:7-14`): running `tsc` without `--noEmit` would write per-file JS and maps into the committed bundle directory and clobber the esbuild layout.

## vitest.config.ts

**Purpose:** test runner config. `vitest.config.ts:3-9`. It includes `test/**/*.test.ts`, uses the node environment and sets `testTimeout: 20000`.
- **Why:** the long timeout is inferred to accommodate WASM grammar init and stdio-spawn integration tests (`test/codex-compat.test.ts:49` spawns `dist/server.js`).
- **Risk:** tests run against the **committed** `dist/` (`test/packaging.test.ts:36-37,73`). Tests do not rebuild, so a stale bundle passes or fails independently of `src/` changes. `packaging.test.ts:72` partly guards this through the version string.

---

## scripts/bundle.mjs

**Purpose:** produce the self-contained plugin. It bundles `src/server.ts` and `src/statusline.ts` into single ESM files with every npm dependency inlined, and copies the tree-sitter WASM assets into `grammars/` (`scripts/bundle.mjs:1-4`).

Top-level script (no functions):
- **Step 1, esbuild**: `scripts/bundle.mjs:14-31`
  - **What:** `rmSync(dist)` and then `build({ entryPoints: [server.ts, statusline.ts], bundle, platform:"node", format:"esm", target:"node18", outdir: dist })`. The result is `dist/server.js` and `dist/statusline.js`.
  - **How:** a banner injects a `createRequire` shim (`:27-30`) so bundled CJS deps (e.g. `pg`) still have `require` inside ESM.
  - **Why:** so `.mcp.json` / plugin manifests can launch `node dist/server.js` with no `node_modules` (commit `e6c6d2f` "Ship a pre-bundled, one-click-installable plugin").
- **Step 2, WASM assets**: `scripts/bundle.mjs:34-48`
  - **What:** copies 4 grammars from `tree-sitter-wasms/out/` (TS, TSX, JS, Python) plus the `web-tree-sitter/tree-sitter.wasm` runtime into `grammars/`.
  - **How:** `createRequire(import.meta.url).resolve(...)` locates the package dirs.
  - **Why:** web-tree-sitter loads its grammars at runtime from disk, and the files cannot be inlined into JS.
- **Depends on:** esbuild, tree-sitter-wasms, web-tree-sitter. **Used by:** `npm run build`. Its output is consumed by `.mcp.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `hooks/statusline-install.mjs` and `verify-bundle.mjs`.
- **Risks:**
  - `dist/` is deleted **before** the build (`:14`). If esbuild throws, the committed bundle is gone from the working tree, and the plugin is broken until rebuilt or `git checkout`.
  - `root = process.cwd()` (`:11`): running the script from any directory other than the repo root silently bundles or deletes the wrong paths. `rmSync(join(cwd,"dist"))` would delete an unrelated `dist/`.
  - `sourcemap: false` + no minify: stack traces from users point at the bundled file. This is acceptable but makes field debugging harder.
  - The final log line says "dist/server.js" only, though two bundles are produced (`:50`). Cosmetic.
  - `target: "node18"` does not match the actual runtime requirements (see package.json risks).

## scripts/verify-bundle.mjs

**Purpose:** proves the bundle is self-contained. It copies `dist/server.js` + `grammars/*.wasm` into a temp dir with no `node_modules`, starts it over stdio with the real MCP client, and checks tool listing, outline and read-by-symbol (`scripts/verify-bundle.mjs:1-2`).

Top-level script plus one helper:
- **Temp-tree setup**: `scripts/verify-bundle.mjs:9-24`. It creates `moz-bundle-*` (dist, grammars, proj with `test/fixtures/sample.ts`) and an isolated `MOZCODE_HOME` (`moz-home-*`), then asserts no `node_modules`.
- **Spawn + drive**: `:26-40`. `StdioClientTransport({ command:"node", args:[tmp/dist/server.js], cwd: tmp/proj, env:{…, MOZCODE_HOME, NODE_PATH:""} })` is followed by `listTools`, `code_outline(sample.ts)` and `code_read(sample.ts, "add")`.
- `text(r)`: `:35`. Joins the content text parts of an MCP result.
- **Assertion**: `:44-55`. It checks that there are exactly 8 tools, that `db_schema` is present, that the outline contains `class Account`, and that the read contains `function add` but not `class Account`. It exits 0 or 1.
- **Why:** to guard against esbuild leaving a bare `require`/`import` of an npm package that would only fail on a user machine without `node_modules`.
- **Depends on:** `@modelcontextprotocol/sdk` client, `test/fixtures/sample.ts`, server tool names (`src/server.ts:79-208`).
- **Risks:**
  - It is not wired into `package.json` scripts or tests, so it only runs if someone remembers it.
  - It does not copy or check `dist/statusline.js`, the second bundle (`bundle.mjs:18`).
  - The hard-coded `names.length === 8` (`:45`) breaks on any tool addition without explaining why. The assertion message only prints ❌.
  - There is no try/finally. If `connect`/`callTool` throws, the server child may linger and the `moz-bundle-*`/`moz-home-*` temp dirs leak (`:40-42` only run on success).
  - The env passes the full `process.env` (`:30`). An inherited `NODE_OPTIONS`/`NODE_PATH`-like setting is only partly neutralised (`NODE_PATH:""`), so a global module resolution path such as a parent `node_modules` above `os.tmpdir()` is not proven absent.
  - It uses `process.cwd()` as root (`:9`).

## scripts/benchmark.ts  (`npm run benchmark:tokens`)

**Purpose:** a real-data token-savings benchmark. It runs `codeOutline`/`codeRead`/`codeSearch` over real TS (zod source + this repo's `src/` and `test/`) and reports measured reduction against naive whole-file reads, so MOZCODE can be compared with WOZCODE's published claims (`scripts/benchmark.ts:1-7`).

- `walk(dir, out=[]): string[]`: `scripts/benchmark.ts:20-31`
  - **What:** recursively collects `.ts/.tsx/.js/.py` files (excluding `.d.ts`). Unreadable entries are skipped silently.
  - **How:** synchronous `readdirSync`/`statSync` recursion. It follows symlinks (`statSync`) and has no ignore list.
  - **Risks:** a missing dir (for example zod not installed) yields `[]` with no warning. Symlink loops would recurse forever. It walks any `node_modules` nested under `test/`.
- `median(xs): number`: `:33-38`. Standard median with an empty guard.
- `largestTopLevel(symbols): Symbol | null`: `:40-44`. Picks the depth-0 symbol with the largest byte span. It is the "main symbol" an agent would read.
- `main()`: `:46-126`
  - **What:** for each file it computes whole-file tokens (`estimateTokens`), outline tokens, and outline + one-symbol-read tokens (capped at the whole-file cost, `:93`). It then runs 5 search queries against zod (`:97-104`) and prints the token-weighted, mean and median reductions.
  - **How:** calls the tool functions directly (no MCP layer), `extractSymbols` and `languageForPath` from the AST engine, and `record()` for each result.
  - **Why:** the evidence base for the README savings claims. The "navigation session" model (`:79-93`) is the WOZCODE-style read pattern.
  - **Depends on:** `src/tools/{outline,read,search}.ts`, `src/ast/engine.ts`, `src/ast/languages.ts`, `src/util/tokens.ts`, `src/metering/store.ts:34`.
  - **Risks:**
    - **It writes benchmark rows into the user's real metering store.** `record("bench:corpus", "benchmark", …)` (`:77,89,103`) appends to `mozcodeHome()` = `~/.mozcode` unless `MOZCODE_HOME` is set (`src/metering/store.ts:20-22`). Running the benchmark therefore inflates the user's real savings dashboard and status line ("all-time saved") with synthetic numbers. This is intentional per `:6`, but it is not opt-in.
    - Division by zero: if the corpus is empty (zod missing), `fileTokTotal`, `outlineRed.length`, `files.length` and `symbolRed.length` are 0, and the output prints `NaN%` with no error (`:112-117`).
    - `codeOutline(file, file)` passes the absolute path as the relative path (`:73,85`), so the recorded `path` fields are absolute machine paths.
    - The search baseline is measured only on zod, not on the whole corpus (`:100`).
    - `main()` has no `.catch` (`:128`). Node will still exit non-zero on an unhandled rejection, but without context.
    - It depends on undeclared `zod` (see package.json).

## scripts/benchmark-performance.ts  (`npm run benchmark:performance`)

**Purpose:** a reproducible local latency benchmark for two claims. The first is that DB discovery takes one compact `db_schema` call instead of iterative SQLite metadata queries over a synthetic 68-table schema. The second is the gain from the file/AST cache over the uncached behaviour. Modeled agent-loop numbers are labelled MODELED (`scripts/benchmark-performance.ts:1-11`).

- `interface Timing {medianMs,p95Ms}` / `interface Comparison`: `:23-33`.
- `ROUND_TRIP_MS = 3_500`: `:35`. The assumed model/tool round trip that the MODELED speedups rely on. It is an assumption, not a measurement.
- `percentile(values, fraction)`: `:37-40`. Nearest-rank on the floor index. With 8 samples p95 is the max, and the median is the upper-middle element, not an interpolated value.
- `time(fn, iterations): Promise<Timing>`: `:42-50`. Sequential `performance.now()` sampling.
- `compare(old, current)`: `:52-60`. Speedup = old/current median, plus a reduction percentage.
- `fmt`, `fmtComparison`: `:62-71`. Console formatting.
- `clinicalNames`: `:73-91`. 68 table names.
- `createClinicalDatabase(filePath)`: `:93-130`
  - **What:** creates `studies` plus 67 child tables, each with an FK to `studies(id)` and 2 indexes, using `node:sqlite` `DatabaseSync`.
  - **How:** `db.exec` with interpolated, double-quoted identifiers, all from the constant list, so injection is not a concern.
- `iterativeWholeSchema(filePath)`: `:132-145`. The naive baseline: list the tables, then `PRAGMA table_xinfo` per table (69 queries).
- `tenStepDiscovery(filePath)`: `:147-166`. The naive baseline: 10 hand-picked discovery queries, modelling an agent exploring the schema.
- `benchmarkDb(root)`: `:168-226`
  - **What:** builds the DB in a temp dir, warms it up, then times naive-10, naive-69, `dbSchema` cold (cache cleared plus `refresh:true`) and `dbSchema` warm (30 iterations each). It prints measured and MODELED speedups and the token payload reduction, and returns a JSON object.
  - **Depends on:** `src/db/schema.ts:443` (`dbSchema`), `:466` (`clearDbSchemaCache`).
  - **Risks:**
    - The "69 → 4" query-count reduction (`:203,216`) is a **hard-coded literal**, not counted from `dbSchema`. If `src/db/schema.ts` changes its query count, the printed claim goes stale.
    - The same applies to "10 → 1" (`:206,220`).
    - The MODELED speedup formulas (`:190-193`) depend entirely on `ROUND_TRIP_MS`.
- `benchmarkCode(root)`: `:228-300`
  - **What:** on zod's `v4/core/schemas.ts` it times outline, outline + symbol read, and a 5-query search batch, each with the file cache cleared before every call ("previous uncached") and with the cache kept ("current cached"). It also times a raw `fs.readFile` for reference.
  - **How:** `clearFileCache()` (`src/ast/file-cache.ts:89`) between calls, `analyzeFile` to pick the largest top-level symbol (`:232-236`).
  - **Risks:**
    - `reduce` without an initial value (`:235`) throws `TypeError` if the file has no depth-0 symbols.
    - The target path is hard-coded into `node_modules/zod/src/v4/core/schemas.ts` (`:229`). It breaks if the transitive zod major version changes or moves its `src/`.
    - "cachedNavigation" still clears the cache once per iteration (`:259`), so it measures read-after-outline reuse, not a fully warm cache. That is acceptable, but the label is subtle.
    - The "uncached" baseline is a simulation of old behaviour (cache cleared), not a run of the old code.
- `main()`: `:302-319`. Creates a temp dir, runs the DB benchmark then the code benchmark, prints a machine-readable JSON (runtime info + results), and removes the temp dir in `finally`. **Risk:** there is no `.catch` on `main()` (`:321`). The `node:sqlite` static import (`:16`) makes the whole script fail at load on any Node that lacks an unflagged `node:sqlite` (Node 20, or 22.5+ without `--experimental-sqlite` on releases where it is still flagged).
- **Note:** unlike `benchmark.ts`, this script does **not** call `record()`, so it does not pollute metering. Inferred: `dbSchema`/`codeOutline` themselves do not record, because metering happens in the server layer. Not verified here.

## scripts/gen-dashboard.ts

**Purpose:** a 4-line dev helper (`scripts/gen-dashboard.ts:1-4`). It calls `generateDashboard()` (`src/dashboard/generate.ts:23`), which reads the real metering store, renders the HTML and writes `~/.mozcode/dashboard.html` (or `$MOZCODE_HOME`). It then prints the path and totals.
- **Why:** inferred to let a developer regenerate the dashboard outside an MCP session, for example after `benchmark:tokens` has recorded rows.
- **Risks:** it has no npm script and no error handling (top-level await rejection). It is effectively the same as the `moz_dashboard` tool without opening a browser.

## scripts/preview-dashboard.ts

**Purpose:** renders the dashboard from **synthetic** metering data for design iteration, with no real store touched (`scripts/preview-dashboard.ts:1-37`).
- **What:** builds 72 fake `MeteringEntry` rows over 6 days and 6 tools (`:5-28`), using deterministic pseudo-variation (`(i*137+d*91)%1600`). It runs `summarize(entries)` (`src/metering/store.ts:127`) and then `renderDashboard(...)` (`src/dashboard/render.ts`), and writes a minimal HTML shell to `process.argv[2]` or `dash-preview.html` in the cwd (`:35-36`).
- **Why:** to preview the WOZCODE-style dashboard port (commit `d38f437` "refresh dashboard") without needing real usage.
- **Risks:**
  - The default output `dash-preview.html` is written into the cwd (the repo root) and is **not** in `.gitignore` (`.gitignore` lists only `node_modules`, logs, `wozcode-teardown.md`, `benchmark.md`). It can be committed by accident.
  - Its HTML wrapper (`:30-33`) duplicates and diverges from `generate.ts`'s `wrap()` (`src/dashboard/generate.ts` ~`:1-20`). The preview may not match the real page's head and fonts.
  - The `"code_read"` duplicate in the tools list (`:6`) intentionally weights reads. Fine.
  - `project: "/Users/x/proj"` is a fake path. Fine.

---

## Cross-cutting observations for improvement passes

1. **The build is destructive and cwd-relative.** `bundle.mjs` deletes the committed `dist/` before building, and every script resolves paths from `process.cwd()` rather than `import.meta.url`.
2. **There is no build → verify → test chain.** `verify-bundle.mjs` is orphaned (no npm script, not in tests, no CI; there is no `.github/`). Tests exercise a committed `dist/` that may be stale relative to `src/`.
3. **Scripts and tests are outside typecheck coverage** (`tsconfig.json:17-18`).
4. **`benchmark:tokens` pollutes real user metering** in `~/.mozcode` by default, which skews the savings dashboard and status line.
5. **Benchmark claims contain hard-coded literals** ("69 → 4", "10 → 1", `ROUND_TRIP_MS=3500`) and depend on an undeclared transitive `zod`.
6. **The Node version contract is inconsistent.** The bundle targets node18, there is no `engines` field, and the perf benchmark and native SQLite need Node 22.x.
7. **The docs do not match the build.** README.md:175 says the build is "tsc + bundle", but the build is esbuild only.
