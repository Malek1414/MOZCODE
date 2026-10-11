# Area: Metering, token estimation & shared utilities

Paths: `src/metering/store.ts` (179 lines), `src/util/tokens.ts` (25), `src/util/files.ts` (56).
3 files, 14 functions mapped (store.ts 9, tokens.ts 1, files.ts 4 including the inner `walk`).

These modules hold everything that is not parsing or tool logic. They count tokens for every tool reply,
append one savings record per tool call to a local JSONL store, aggregate that store for the
dashboard, the `moz_savings` tool and the status line, and walk/filter the project tree for `code_search`.

---

## src/metering/store.ts

**Purpose:** a file-backed, append-only savings ledger under `~/.mozcode` (one JSONL file per project),
plus a per-project "current session" pointer and an in-memory aggregator (`summarize`).

Data type: `MeteringEntry` (`store.ts:7-16`) holds `{ts, session, project, tool, path?, baselineTokens, actualTokens, savedTokens}`.
`Summary` (`store.ts:114-125`) holds totals plus `byTool`, `byDay`, `byFile` and `bySession` breakdowns. Both are consumed by
`src/dashboard/metrics.ts:1` and `src/dashboard/render.ts:1`.

### `mozcodeHome(): string` (`store.ts:19`)
- **What:** returns the root state directory: `$MOZCODE_HOME` if set, else `~/.mozcode`.
- **How:** an env lookup with `path.join(os.homedir(), ".mozcode")` as the fallback.
- **Why:** the single place that decides where state lives. Tests point it at a temp dir (`test/metering.test.ts:11-12`).
- **Used by:** `server.ts:287` (status text), `dashboard/generate.ts:26-27` (dashboard.html location), and internally by `meteringDir` and `sessionsDir`.
- **Risks:** none significant. An empty-string env value falls back correctly because `||` is used.

### `meteringDir()` / `sessionsDir()` (`store.ts:23`, `store.ts:57`)
- Trivial helpers that return `<home>/metering` and `<home>/sessions`.

### `projectFile(project): string` (`store.ts:27`)
- **What:** maps an absolute project path to `<home>/metering/<sanitized-basename>-<sha1[0:12]>.jsonl`.
- **How:** SHA-1 of the full path keeps projects that share a basename apart, and the sanitized basename keeps the filename readable.
- **Why:** gives each project its own ledger file without a database. `test/statusline.test.ts:49` reimplements the naming, so the format is effectively a contract.
- **Risks:** the naming is duplicated in a test instead of being exported, so the two could drift. SHA-1 is used only as an ID, not for security, which is fine here.

### `record(project, session, meta: SavingsMeta): Promise<void>` (`store.ts:34`)
- **What:** appends one `MeteringEntry` line with an ISO timestamp to the project's JSONL. It never throws.
- **How:** runs `fs.mkdir(recursive)` and then `fs.appendFile(JSON.stringify(entry)+"\n")` on every call, and swallows all errors (`store.ts:52-54`).
- **Why:** it is the metering hook behind every tool call. `server.ts:69` (`meter()`) awaits it before returning the tool result. Making it best-effort keeps metering from breaking a tool call.
- **Depends on:** `SavingsMeta` from `tools/types.ts`. `savedTokens` is clamped to be at least 0 in `makeMeta` (`tools/types.ts:31`).
- **Used by:** `server.ts:69`, `scripts/benchmark.ts:77,89,103`, and `test/metering.test.ts`.
- **Risks:** (a) Every tool call pays a `mkdir` syscall plus an append before it replies, and `meter()` awaits both, which adds a little latency. (b) Errors are swallowed silently with no debug log, so a broken disk or permissions problem is invisible. (c) Files are created with the default umask (usually 0644), so absolute project paths and file names are readable by other local users. (d) The ledger grows without bound: there is no rotation or compaction.

### `writeCurrentSession(project, session)` (`store.ts:71`)
- **What:** writes the server's per-process session id to `<home>/sessions/<sha1[0:12]>.session`.
- **How:** `mkdir` followed by `writeFile`, with errors swallowed.
- **Why:** lets the out-of-process status line attribute "this session" savings (`server.ts:304-307`, `statusline.ts:69-75`).
- **Risks:** this is a last-writer-wins pointer. If two MCP server processes run for the same project (for example Claude Code and Codex, or two windows), the status line shows only the newer one's session. The write is not atomic (no temp file and rename), so a concurrent read could see an empty file, which then takes the fallback path.

### `readCurrentSession(project): Promise<string|undefined>` (`store.ts:81`)
- **What:** reads and trims the pointer file. It returns `undefined` if the file is missing or empty.
- **Used by:** `statusline.ts:72`. When it returns nothing, the status line falls back to the session of the newest entry (`statusline.ts:73-75`).
- **Risks:** low.

### `loadEntries(): Promise<MeteringEntry[]>` (`store.ts:91`)
- **What:** loads every entry from every project's JSONL into memory and skips malformed lines.
- **How:** `readdir`, then a sequential `readFile` per file, `split("\n")` and `JSON.parse` per line, cast to `MeteringEntry` without any shape check.
- **Why:** the only reader of the ledger. It feeds the dashboard, `moz_savings` and the status line.
- **Used by:** `statusline.ts:66` (on every status-line refresh), `server.ts:269-270` (twice per `moz_savings` call), `dashboard/generate.ts:24`.
- **Risks:** **scale.** Cost is O(all-time history across all projects) on every status-line render. That is a full parse of every ledger, the opposite of WOZCODE-style responsiveness, and it grows without bound. `moz_savings` reads and parses everything twice (`server.ts:269-270`). **Quality:** a line that parses as JSON but has the wrong shape (`null`, `{}`, a number) passes the cast. Downstream, `summarize` then hits `e.ts.slice` or `e.baselineTokens` on null and throws, or NaN spreads into the totals. In the status line, that error is replaced by a silent "$0.00" fallback (`statusline.ts:82-85`).

### `summarize(entries, topFiles = 15): Summary` (`store.ts:127`)
- **What:** a pure aggregation that computes totals, the average reduction %, distinct projects, and per-tool, per-day (UTC date), per-file (top N) and per-session breakdowns, each sorted.
- **How:** a single pass with four `Map`s and a `Set`. `avgReductionPct` is `totalSaved/totalBaseline*100`, which is a ratio of sums, not a mean of ratios.
- **Why:** the shared model behind the dashboard (`dashboard/generate.ts:24`, `render.ts`), the `moz_savings` text (`server.ts:269-276`) and the status-line metrics (`statusline.ts:51`).
- **Risks:** (a) `byFile` is keyed only by the *project-relative* path (`store.ts:152-156`), so `src/index.ts` from different projects merges into one row in the all-time dashboard. (b) `byDay` uses the UTC date from the ISO string (`store.ts:149`), so local evening activity lands on the next day. (c) The name `avgReductionPct` suggests a mean of per-call ratios but is a weighted ratio. That is fine, but undocumented. Tested in `test/metering.test.ts:27-39` and `test/dashboard.test.ts`.

---

## src/util/tokens.ts

**Purpose:** the one token counter used for all savings accounting.

### `estimateTokens(text): number` (`tokens.ts:16`)
- **What:** returns the o200k_base BPE token count of `text` (0 for empty input). If the encoder throws, it falls back to `ceil(len/4)`.
- **How:** `countTokens` from `gpt-tokenizer/encoding/o200k_base` (`tokens.ts:1`). The doc comment (`tokens.ts:3-15`) says plainly that this is a proxy for a GPT tokenizer, not Claude's tokenizer.
- **Why:** a deterministic, offline, fast estimate of the baseline (whole-file) and actual (returned) tokens per tool call. It was introduced in commit 4fa3973, replacing a chars/4 heuristic.
- **Used by:** `tools/read.ts:25,37,47,59,68`, `tools/outline.ts:19,27,35`, `tools/edit.ts:15,19,26,35,47`, `tools/search.ts:72,76,128`, `db/schema.ts:458,462`, `scripts/benchmark.ts:70`.
- **Risks:** **scale/responsiveness.** BPE tokenization is synchronous CPU work on the request path. Every `code_read` or `code_outline` tokenizes the *entire* source file only to compute the counterfactual baseline (`read.ts:25`, `outline.ts:19`), so on large files the metering costs more than the useful work and blocks the single-threaded stdio server's event loop. Baselines for unchanged files are not cached (the source cache in the tools could also hold the token count). Savings are reported in dollars elsewhere even though the count comes from a non-Claude tokenizer. This is documented, but it is still an estimate.

---

## src/util/files.ts

**Purpose:** project file discovery and path filtering for `code_search`.

Constants: `IGNORED_DIRS` (`files.ts:4-6`) and `CODE_EXTENSIONS` (`files.ts:8-10`, TS/JS/Python only).

### `listSourceFiles(root, limit = 5000): Promise<string[]>` (`files.ts:13`)
- **What:** recursively lists absolute paths of code files under `root`. It skips ignored directories and every dot-directory, and stops at `limit`.
- **How:** an inner async DFS `walk(dir)` (`files.ts:15`) using `readdir({withFileTypes:true})`, run sequentially (one `await` per directory). Unreadable directories are skipped. Symlinks are neither followed nor listed, because `Dirent.isFile()` and `isDirectory()` return false for them.
- **Why:** gives `code_search` its candidate files (`tools/search.ts:43`).
- **Risks:** (a) The 5000 cap truncates silently: search results in big monorepos are incomplete with no warning, and DFS order decides which files are dropped. (b) `.gitignore` is not honoured, so generated directories with other names (for example `out/`, `vendor/`, `target/`) are scanned. (c) The full tree is walked again on every `code_search` call with no cache, and the traversal is serial. (d) Symlinked source files are skipped without notice.

### `matchesGlob(filePath, glob): boolean` (`files.ts:39`)
- **What:** a hand-written glob that converts `**` to `.*` and `*` to `[^/]*`, anchors the pattern, and also accepts any path that `endsWith(glob)`.
- **How:** escapes regex metacharacters, uses a space as a temporary placeholder for `**`, then builds a `RegExp` on every call.
- **Used by:** `tools/search.ts:47`, which passes the **absolute** file path.
- **Risks (verified by running the function):** **High: broken for its own documented example.** `server.ts:128` advertises `path_glob` as e.g. `"src/**/*.ts"`, but because `search.ts:47` passes absolute paths, the `^`-anchored regex never matches and the `endsWith` fallback fails too. Results: `matchesGlob("/U/x/proj/src/tools/read.ts","src/**/*.ts") === false`, and likewise for `"src/tools/*.ts"` and `"*.ts"`. Only globs starting with `**/` work. Even on a relative path, `src/**/*.ts` fails for `src/a.ts`, because `**/` turns into `.*/` and so requires at least one extra directory. The `endsWith` fallback over-matches: `"ad.ts"` matches `.../read.ts`. `?` is not escaped, so it acts as a regex quantifier, and a literal space in a glob becomes `.*`. A user-supplied glob compiles into a `RegExp`, but every metacharacter except `*`/`?` is escaped, so the ReDoS risk is low.

### `readFileSafe(filePath): Promise<string>` (`files.ts:54`)
- **What:** a plain wrapper around `fs.readFile(utf8)`.
- **Risks:** **dead code.** Nothing in `src/`, `test/` or `scripts/` calls it. The name suggests error handling or path containment that it does not provide.

---

## Tests covering this area
- `test/metering.test.ts`: `record`, `loadEntries`, `summarize` (happy path only, no malformed lines or concurrency).
- `test/dashboard.test.ts`: `summarize` together with the renderer.
- `test/statusline.test.ts`: reimplements `projectFile` naming (line 49).
- No direct tests for `matchesGlob`, `listSourceFiles` or `estimateTokens`, which is why the glob bug went unnoticed.

## Hot spots (ranked)
1. **High, quality:** `matchesGlob` (`files.ts:39`) together with `search.ts:47` absolute paths means `code_search` `path_glob` such as the documented `src/**/*.ts` matches nothing; `endsWith` over-matches.
2. **Medium, scale:** `loadEntries` (`store.ts:91`) re-parses the entire all-time ledger on every status-line refresh, and twice per `moz_savings`, and the ledger grows without bound (no rotation, compaction or rollup).
3. **Medium, scale:** `estimateTokens` (`tokens.ts:16`) runs synchronous BPE over whole files just to compute the baseline (`read.ts:25`, `outline.ts:19`, `edit.ts:15`), which blocks the stdio event loop on large files, and the result is not cached.
4. **Medium, quality:** `loadEntries` casts unvalidated JSON, so a valid-JSON line of the wrong shape crashes `summarize` (`store.ts:149`), and the status line silently shows $0.00.
5. **Medium, scale/quality:** `listSourceFiles` (`files.ts:13`) truncates silently at 5000 files, ignores `.gitignore`, and walks the tree serially and uncached on every search.
6. **Low, quality:** `summarize.byFile` (`store.ts:152`) merges same-named relative paths across projects. `byDay` uses UTC.
7. **Low, quality:** the session pointer (`store.ts:71`) is last-writer-wins and not atomic, so concurrent servers for the same project are misattributed.
8. **Low, security:** metering and session files use the default umask, so other local users can read project paths and file names. `record` swallows errors with no diagnostics.
9. **Low, quality:** `readFileSafe` (`files.ts:54`) is dead code with a misleading name. `projectFile` naming is duplicated in `test/statusline.test.ts:49`.
