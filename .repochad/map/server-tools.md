# Area: MCP server core & tool handlers

Paths: `src/server.ts`, `src/tools/read.ts`, `src/tools/outline.ts`, `src/tools/search.ts`, `src/tools/edit.ts`, `src/tools/types.ts`, `src/version.ts`
Counts: 7 files, 16 functions/handlers (plus the `TOOLS` table, 2 interfaces and 1 constant).

Request path: stdio JSON-RPC → `CallToolRequestSchema` handler (`src/server.ts:227`) → `resolvePaths` → `code*` tool function → `analyzeFile` (mtime/size cache, `src/ast/file-cache.ts:35-69`) → tree-sitter symbols → text payload + `SavingsMeta` → `meter()` appends a JSONL line → `textResult`.

---

## src/server.ts — MCP entry point
**Purpose:** Declares the 8 MCP tools, works out which project directory relative paths resolve against, sends each call to its tool implementation and meters it, then connects over stdio.

### Module-level state — `src/server.ts:19,36,50`
- `SESSION = crypto.randomUUID()` (`:19`): a per-process id, not Claude's session id (comment `:305-306`).
- `PLUGIN_ROOT` (`:36`): the parent of the bundle's directory (`dist/..`).
- `PROJECT` / `PROJECT_UNRESOLVED` (`:50`): computed once at startup by `resolveProject`.

### `resolveProject(): {project, unresolved}` — `src/server.ts:38`
- **What:** Returns `MOZCODE_PROJECT` if set (`:39-40`). Otherwise it returns `process.cwd()`, flagged unresolved when cwd equals the plugin root and `MOZCODE_TRUST_CWD !== "1"` (`:42-47`).
- **How:** `path.resolve` equality check. There is no realpath, so a symlinked plugin dir would not be detected.
- **Why:** Codex launches plugin MCP servers with cwd set to the plugin root. Without this check, relative reads and edits would hit MOZCODE's own installed source (doc comment `:21-35`, commit b827622).
- **Used by:** `resolvePaths`, the unresolved guard at `:232`, `moz_status`. Tested in `test/codex-compat.test.ts:101-133`.
- **Risks:** Low. Symlinked or case-variant paths bypass the equality check.

### `resolvePaths(p): {abs, rel}` — `src/server.ts:60`
- **What:** Absolute paths pass through. Relative paths resolve against `PROJECT`. `rel` is the project-relative label used in output and metering.
- **How:** `path.isAbsolute` / `path.resolve` / `path.relative`.
- **Why:** Lets tools accept either form and keeps output paths short.
- **Risks (security, medium):** Paths are not confined to the project. Both absolute paths and `../../` traversals are accepted, so `code_edit` (`:254-256`) can rewrite any file the user can write. When the project is UNRESOLVED, absolute paths are still allowed on purpose (`:230-236`). `String(args.path)` turns a missing path into the literal file name `"undefined"`. That case only fails with ENOENT, but the arguments are never validated against `inputSchema`.

### `meter(result)` — `src/server.ts:68`
- **What:** Awaits `record(PROJECT, SESSION, meta)` and then returns the result unchanged.
- **How:** `record` runs `mkdir -p` and `appendFile`, one JSONL line per call, and swallows errors (`src/metering/store.ts:34-54`).
- **Why:** Every code tool reports its savings to the dashboard and status line.
- **Risks (scale/responsiveness, low):** A disk `mkdir` and an append sit on the critical path of every tool response. Fire-and-forget would return sooner.

### `textResult(text, isError?)` — `src/server.ts:73`
Builds the MCP `{content:[{type:"text"}], isError}` envelope. Trivial.

### `TOOLS` — `src/server.ts:77-218`
Static tool descriptors with JSON-schema inputs and MCP annotations: `code_read`, `code_outline`, `code_search`, `code_edit`, `db_schema`, `moz_savings`, `moz_status`, `moz_dashboard`. The descriptions push the model to use these instead of the built-in Read and Grep (`:81`, `:117`), which is the main lever for token savings. `test/integration.test.ts:42-77` asserts the annotations.

### ListTools handler — `src/server.ts:225`
Returns `TOOLS`.

### CallTool handler — `src/server.ts:227-302`
- **What:** If the project is UNRESOLVED, it refuses every call except `moz_status` and calls that pass an absolute `path` (`:232-236`). Otherwise it dispatches by name, and any exception becomes an `isError` text (`:298-301`).
- **How:** A `switch`. Arguments are cast (`as string | undefined`) and never validated.
  - `code_edit` sets `isError` only when `r.degraded && r.text.includes("rejected")` (`:257`).
  - `moz_savings` calls `loadEntries()` twice (`:269-270`), so every metering file for every project is read and parsed twice (`src/metering/store.ts:91-110`).
  - `moz_dashboard` always says "Opening in your browser", even when `open:false` (`:292-293`).
- **Why:** It is the single routing point for the server.
- **Risks:**
  - (quality, low) `code_edit` returns "symbol not found" and "unsupported language" as success (`isError:false`), so clients cannot tell the edit did not happen.
  - (scale, low) `moz_savings` costs O(all history) twice per call.
  - (quality, low) Argument types are never checked. For example, a string `context_lines` reaches `withContext` (see below).

### `main()` — `src/server.ts:304`
Writes the current-session marker (`writeCurrentSession`) for the status line, connects `StdioServerTransport` and logs readiness to stderr. On a fatal error it exits with code 1 (`:314-318`).

---

## src/tools/types.ts — shared result and metering types
**Purpose:** The contract between the tools and the server/metering. `SavingsMeta` is defined at `:1-10` and `ToolResult {text, degraded, meta}` at `:12-18`.

### `makeMeta(tool, path, baselineTokens, actualTokens)` — `src/tools/types.ts:20`
- **What/How:** Builds a `SavingsMeta`, with `savedTokens = max(0, baseline - actual)` (`:31`).
- **Why:** Gives every tool the same savings accounting. The baseline is "what a naive Read/Grep would have returned" (`:4`).
- **Risks:** None. The baseline is an estimate by design: `estimateTokens` is backed by gpt-tokenizer.

---

## src/version.ts — version constant
**Purpose:** `VERSION = "0.3.0"` (`:10`), the single source of truth. `test/packaging.test.ts` keeps it in lockstep with `package.json` and both plugin manifests (`:4-8`). It is used by `server.ts:221,280`.

---

## src/tools/outline.ts — `code_outline`
**Purpose:** Returns a file's skeleton of signatures and line spans with bodies left out. This is the "map" step before `code_read`.

### `renderOutline(symbols, relPath): string` — `src/tools/outline.ts:7`
- **What:** Prints one line per symbol: `indent + signature [kind Lstart-end]`. Members are indented by `depth`. Prints "(no top-level symbols found)" when the list is empty.
- **Used by:** `codeOutline`, `codeRead` (no symbol given, or a symbol miss), and `codeEdit` (symbol miss).

### `codeOutline(absPath, relPath): ToolResult` — `src/tools/outline.ts:17`
- **What:** For a supported language, returns the outline, with a note when the file has syntax errors (`:33`). For an unsupported language, returns the first 40 lines (`:21-28`).
- **How:** `analyzeFile` (cached parse) → `renderOutline`. The baseline is the token count of the whole file.
- **Why:** Gives the model the cheap overview, much like WOZCODE's outline-first read.
- **Risks (quality, low):** The metered `actualTokens` uses `text` without the syntax-error note (`:35`), so it is slightly understated. Tested in `test/tools.test.ts:15-49`.

---

## src/tools/read.ts — `code_read`
**Purpose:** Returns just one symbol plus N context lines, or the outline when no symbol is given.

### `withContext(source, startLine, endLine, context)` — `src/tools/read.ts:13`
- **What/How:** Splits the source into lines, slices `[start-1-ctx, end+ctx]` and adds line-number prefixes.
- **Risks (quality, low):** `context` is not validated. A string such as `"5"` from a loosely typed client makes `endLine + context` a string concatenation (`10 + "5"` → `"105"`), so far too many lines are returned. A negative value cuts off the symbol body. `NaN` returns nothing.

### `codeRead(absPath, relPath, {symbol, contextLines})` — `src/tools/read.ts:23`
- **What:** Has four branches:
  1. Unsupported language: the whole file, numbered, marked degraded (`:29-39`).
  2. No symbol given: the outline (`:42-49`).
  3. Symbol not found: the outline with a "not found" header, marked degraded (`:51-61`).
  4. Symbol found: the span with context (`:63-69`).
- **How:** `analyzeFile` → `resolveSymbol` (exact qualified name first, then the first bare-name match; `src/ast/engine.ts:234-239`).
- **Why:** This is the core token saver. Missing symbols degrade to an outline so the model can retry with a real name and does not need a full Read.
- **Risks:**
  - (scale, medium) The unsupported-language branch has no size cap (`:29-38`). A large non-code file (logs, JSON, a minified bundle) is returned whole and numbered, which can cost more tokens than the built-in Read with its limit and offset. `analyzeFile` also caches the whole file in memory.
  - (quality, low) A bare-name match picks the first symbol with that name, so overloaded or repeated member names such as `constructor` or `render` come back silently ambiguous.
  - Tested in `test/tools.test.ts:51-76`.

---

## src/tools/search.ts — `code_search`
**Purpose:** Runs a grep across the project, then groups the hits by their innermost enclosing symbol, which keeps the output small.

### `buildRegex(query)` — `src/tools/search.ts:18`
Tries `new RegExp(query,"g")`. If the query is not a valid regex, it falls back to an escaped literal.
- **Risks (security/responsiveness, medium):** The pattern comes from the model and is unbounded, so catastrophic backtracking is possible (for example `(a+)+$`). It runs synchronously on the single event loop over every line of up to 5000 files, which freezes the whole stdio server with no timeout.

### `enclosing(symbols, offset)` — `src/tools/search.ts:27`
A linear scan that returns the smallest symbol span containing `offset`. The cost is O(matches × symbols) per file, which is fine because matches are capped at 200.
- **Risk:** None from offsets. Both sides are UTF-16: the match offset is built from JS string lengths (`:54-63`), and web-tree-sitter 0.25.10 returns UTF-16 `startIndex`/`endIndex` (`src/ast/engine.ts:14`; re-run in fact-check: after `// héllo wörld — ünïcode 😀😀\n`, `a` starts at index 37, the correct JS index). An earlier draft said the spans drift after non-ASCII text. That was refuted.

### `codeSearch(root, query, pathGlob?)` — `src/tools/search.ts:37`
- **What:** Lists source files, filters them by glob and scans line by line. It records the first match per line and stops at 200 matches (`MAX_MATCHES`, `:9`). Files are grouped together. For a supported language, each hit is mapped to its enclosing symbol as `qualifiedName [kind span; N hits Lx,Ly]`. Lines outside any symbol are listed raw.
- **How:** `listSourceFiles` (recursive readdir, skips dot-dirs and the fixed `IGNORED_DIRS` list (`files.ts:4-6`), limit 5000; `src/util/files.ts:13-36`) → `readCachedSource` → per-line `rx.exec` → `analyzeFile` for each file that has hits.
- **Why:** Many grep lines collapse into a few actionable symbols, and the model can pass those directly to `code_read`/`code_edit`.
- **Risks:**
  - **(quality, high) `path_glob` filtering is broken for globs relative to the project.** `matchesGlob` is applied to the absolute file path with an anchored `^…$` regex (`src/util/files.ts:39-52`, called at `search.ts:47`). The schema's own example `"src/**/*.ts"` (`server.ts:128`), as well as `"*.ts"`, never match. Verified: `matchesGlob("/Users/x/repo/src/tools/read.ts","src/**/*.ts") === false`, while `"**/*.ts"` is true. Any scoped search therefore returns "No matches". No test covers `path_glob`.
  - (quality, medium) Silent truncation. At 200 matches the scan stops (`:61,65`), and the header reports "200 matches" with no "truncated" flag, so the model assumes the results are complete. The baseline also counts only the capped hits.
  - (scale/responsiveness, medium) Every call walks the whole tree again (no file-list cache) and awaits each `readCachedSource` one at a time (`:46-53`). On a cold cache that means up to 5000 serial stats and reads per query. WOZCODE-style responsiveness would need a cached file index, parallel reads in batches, or ripgrep.
  - (quality, low) Only the first match on each line is recorded, and patterns that span lines can never match because the scan is line by line.
  - (quality, low) `listSourceFiles` skips every dot-directory (`files.ts:27`). It also stops silently at 5000 files.
  - Tested in `test/tools.test.ts:78-100`.

---

## src/tools/edit.ts — `code_edit`
**Purpose:** Replaces a whole symbol's source text, using its AST span as the anchor. It refuses the edit when the change would newly break the parse, and returns a short confirmation so no re-read is needed.

### `codeEdit(absPath, relPath, symbolName, newSource)` — `src/tools/edit.ts:8`
- **What:** If the language is unsupported or the symbol is not found, it returns a degraded message (`:17-27`). Otherwise it builds `next = source[0:startIndex] + newSource + source[endIndex:]` (`:29`) and re-parses it. If the file used to parse cleanly and now does not, the edit is rejected (`:32-36`). Otherwise it writes the file and invalidates the cache (`:38-39`).
- **How:** `analyzeFile` → `resolveSymbol` → string splice → `extractSymbols(next)` → `fs.writeFile`.
- **Why:** Matches WOZCODE's "edit by symbol, no line numbers, no re-read" technique. The parse check stands in for a compile check.
- **Risks:**
  - **(refuted in synthesis and fact-check) "The splice uses UTF-8 byte offsets as JS string indices."** An earlier draft rated this high. It does not hold: web-tree-sitter 0.25.10 returns UTF-16 offsets (`src/ast/engine.ts:14`). With the source `// héllo wörld — ünïcode 😀😀\nexport function a()…`, `extractSymbols` gives `a` the start index 37 and `source.slice(startIndex, endIndex)` returns exactly `function a() { return 1; }`, and the synthesis pass saw `codeEdit` replace `a` correctly through `dist/server.js`. A non-ASCII regression test is still worth adding. The real weak points of the guard are listed next.
  - (quality, medium) Ambiguous bare names. `resolveSymbol` falls back to the first symbol with a matching bare name (`engine.ts:237`), so `code_edit(symbol:"constructor")` or a repeated method name rewrites whichever one comes first, silently.
  - (quality, medium) The guard is weak. The check only asks whether the whole file has parse errors (`hasError`). A file that already had an error accepts any edit. Nothing checks that `newSource` still defines the symbol that was asked for.
  - (quality, low) The write is not atomic: `fs.writeFile` truncates the file in place, so a crash mid-write corrupts it. Nothing guards against a TOCTOU change between the cached read and the write. `newEndLine` is off by one when `newSource` ends with a newline (`:41-42`).
  - (quality, low) Failures come back to the client as non-errors (see the CallTool handler, `server.ts:257`).
  - Tested in `test/tools.test.ts:102-125` and `test/integration.test.ts:102-110`.

---

## Notes on responsiveness compared with the WOZCODE design (for the improvement passes)
- The hot path is fast once warm: an mtime/size-keyed parse cache (`src/ast/file-cache.ts:35-69`) means repeat `code_read`/`code_outline` calls skip both the read and the parse.
- Per-call latency mostly comes from the serial tree walk and reads in `code_search` and from the metering append, which is awaited.
- Correctness gaps cost more round-trips than they save in tokens. The broken `path_glob`, silent truncation and silent failures all force the model to retry or fall back to the built-in Read/Grep, which defeats the token-saving goal.
