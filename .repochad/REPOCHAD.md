# RepoChadLite report: MOZCODE

Branch `repochad/2026-10-11` on the private mirror `Malek1414/MOZCODE-repochad`, based on `b827622` of `Malek1414/MOZCODE` (`main`). The original repository was not touched: its remote is named `upstream` and its push URL is set to `DISABLED`.

Supporting documents:
- [MAP.md](MAP.md): an evidence-backed map of every area of the codebase, with per-area detail in [map/](map/)
- [EXPLAINED.md](EXPLAINED.md): the codebase in plain English
- [SCOUT.md](SCOUT.md): related projects, libraries and practices from GitHub and the web, ranked by fit
- [CHANGES.jsonl](CHANGES.jsonl): one machine-readable line per attempted change
- [baseline.json](baseline.json): the test command and result before any change

## What MOZCODE is

MOZCODE helps an AI coding assistant such as Claude Code or Codex read and change code while using fewer tokens, so each session costs less and finishes sooner. It works like a reference librarian between the assistant and your files. Instead of handing over whole files, it hands over a table of contents (`code_outline`), one function (`code_read`), search hits grouped by the function they sit in (`code_search`), or a one-step edit of a single function (`code_edit`). It also lists a whole SQLite or Postgres schema in one answer (`db_schema`). Every call is logged to a savings ledger in `~/.mozcode`, and a status line and dashboard turn that ledger into estimated dollars, minutes and round trips saved. A session-start hook reminds the assistant to use these tools, and the whole thing ships as a prebuilt bundle in `dist/`, so users install it as a plugin without building anything. It is a clean-room rebuild of the idea behind WOZCODE.

## Results at a glance

| | Count |
|---|---|
| Changes kept (each its own commit) | 49 (quality 31, security 8, scale 10) |
| Changes reverted | 0 |
| Ideas looked at and deliberately skipped | 19 |
| Files changed vs. base | 50 (+10,284 / -1,390 lines; most of the added lines are the rebuilt `dist/` bundle and `package-lock.json`) |

**Tests:** before `pass` (`npm ci && npm test`, 72 tests per EXPLAINED.md) -> after `pass` (`npm test`: 18 files, 143 passed, 1 skipped). The skipped test is the opt-in Postgres test, which runs only when `MOZCODE_TEST_POSTGRES_URL` is set. Every commit was followed by a full test run, and none had to be reverted.

Highlights:
- **Quality:** `code_search` path filters work again (`src/**/*.ts` used to match nothing). `code_edit` no longer rewrites the wrong span or hides failures. The SessionStart nudge now survives `/clear` and compaction. Tests and benchmarks no longer write fake savings into the real ledger. CI now runs typecheck, tests and a stale-bundle check.
- **Security:** search regexes run on a linear-time engine (re2js), so a pattern like `(a+)+$` can no longer freeze the server. `code_edit` writes are confined to the project root. `db_schema` only reads env vars that hold a Postgres URL, and its introspection is read-only and time-bounded. The metering store is created private to the user. `npm audit` now reports 0 vulnerabilities.
- **Scale:** a WASM memory leak is fixed (RSS growth over 1,500 parses went from about 940 MB to about 70 MB). Each parse is capped at 500 ms. Large outputs are capped. Search reads files in parallel. The status line reads an incremental rollup instead of the whole lifetime ledger (0.24 s -> 0.04 s per refresh on a 37 MB ledger).

## Kept changes

Listed in the order they were made. The "Commit" column is the short SHA on this branch.

| Category | Title | Why | Impact | Commit |
|---|---|---|---|---|
| quality | Make code_search path_glob match project-relative globs | matchesGlob ran an anchored regex over the absolute path, so 'src/**/*.ts' (the schema's own example), 'src/tools/*.ts' and '*.ts' matched nothing; the endsWith fallback over-matched | Scoped code_search works as documented; no false 'No matches' or suffix over-matches | `1a191d1` |
| quality | Stop code_edit from rewriting the wrong span | Exported declarations spliced from 'function' (export export ...), ambiguous bare names edited the first match, and multi-declarator const edits deleted sibling declarators | code_edit refuses ambiguous names and shared-statement edits and handles repeated export modifiers | `d275f37` |
| quality | Validate code_read context_lines | A string context_lines caused string concatenation, negative values cut the symbol off, NaN returned nothing | context_lines is coerced and clamped to 0..200 | `67cf336` |
| quality | Report failed code_edit calls as tool errors | 'symbol not found' and 'unsupported language' returned isError:false and were metered as savings | Clients see failed edits as errors; failed edits no longer inflate savings | `3c14566` |
| quality | Isolate codex-compat test servers from the real ~/.mozcode | Each test run wrote session pointers and metering rows into the developer's real store | Running npm test no longer inflates the real dashboard and status line | `02d62de` |
| quality | Flag code_search results cut off at the 200-match cap | The header said '200 matches' with no truncation flag | The model knows a capped result is partial and is told to narrow the query | `3925cee` |
| quality | Re-inject the SessionStart nudge after /clear and compaction | Matcher was 'startup\|resume', so the code_* nudge was lost after /clear or auto-compaction | Long sessions keep routing to the token-saving tools | `20b077b` |
| quality | Keep a missing browser opener from crashing the MCP server | spawn() of a missing xdg-open/open emits an unhandled 'error' event; Windows used shell:true with an unquoted path | moz_dashboard cannot crash the server; Windows paths with spaces open | `f779b5f` |
| quality | Skip metering lines that are not valid entries | A 'null' or '{}' line made summarize throw or spread NaN, so the status line showed $0.00 | Corrupt ledger lines are skipped instead of breaking every total | `dddb70c` |
| quality | Fix '1m 60s' in fmtDuration | Rounding after the remainder printed '1m 60s' / '1h 60m' | Durations display correctly on the dashboard and status line | `ed896c2` |
| quality | State the real token-count method on the dashboard and README | Dashboard and README claimed ~4 chars/token, but counts use the o200k BPE; README said build runs tsc | The auditable-assumptions disclosure matches the code | `1fb6e3d` |
| quality | Make the bundle build atomic and cwd-independent | bundle.mjs deleted dist/ before esbuild ran and resolved paths from process.cwd() | A failed or misplaced build can no longer delete the shipped bundle | `8967925` |
| quality | Don't cache rejected parser and analysis promises | A single transient wasm/parse failure was cached forever, disabling AST features until restart | AST tools recover on the next call after a transient failure | `1e00187` |
| quality | Give Codex its own SessionStart hook | Codex loaded the Claude Code hooks/hooks.json, which rewrote ~/.claude/settings.json to point Claude Code's status line at the Codex plugin copy and nudged toward Read/Grep tools Codex lacks | Codex sessions get a correct nudge (incl. after clear/compact) and never touch Claude Code settings | `77cd59c` |
| quality | Keep a symlinked settings.json a symlink when installing the status line | Temp-file + rename replaced a dotfile-managed symlinked ~/.claude/settings.json with a regular file and reset its mode; temp file leaked on rename failure | Dotfile-managed settings stay linked and keep their permissions | `de25a2c` |
| quality | Stop benchmark:tokens writing into the real metering store | benchmark.ts recorded every call into ~/.mozcode unless MOZCODE_HOME was set, adding synthetic bench:corpus rows to the real ledger | Benchmarks no longer inflate the user's real dashboard and status line | `91a5afb` |
| quality | Invalidate the SQLite schema cache when the WAL file changes | The cache was keyed on the main file's mtime/size only; schema changes in an uncheckpointed -wal file were missed until refresh:true | db_schema reflects new tables/columns in WAL-mode databases immediately | `60cc56e` |
| quality | Parse Postgres index columns from indexdef correctly | indexColumns regex-cut indexdef at the first ')', so expression indexes, opclasses, DESC/NULLS, COLLATE and quoted names produced wrong or garbage column lists | db_schema shows correct Postgres index columns; first unit tests on the Postgres path | `99f8f97` |
| quality | Count only calls that saved tokens as avoided round-trips | Every code_edit/code_search/db_schema call counted as an avoided round-trip, including failed edits already in ledgers and no-match searches, inflating callsSaved, costSaved and timeSavedSec | Dashboard and status line no longer credit failed or empty calls | `a5719cb` |
| quality | Keep generic defaults in type-alias signatures | The type-alias signature was cut at the first '=', so 'type Box<T = string>' showed as 'type Box<T' | code_outline shows full type parameters | `e6f96a9` |
| quality | Qualify nested Python class members with the full class path | Nested class members were qualified only by the inner class name, so 'Meta.run' matched Outer.Meta.run before a top-level Meta.run, and code_read/code_edit hit the wrong symbol | Qualified lookups in files with nested classes resolve to the intended symbol | `df6a8d1` |
| quality | Keep the status line's session segment when the cwd changes | Session entries were matched by exact equality with stdin cwd, which follows the session into subdirectories while the server meters under the launch dir, so the session segment fell to $0.00 | Status line keeps showing current-session savings after cd into a subdirectory | `b9d2a8d` |
| quality | Make verify-bundle runnable and cover the status line bundle | verify-bundle.mjs had no npm script, was cwd-dependent, leaked temp dirs and the child on failure, and never checked dist/statusline.js | npm run verify:bundle proves both shipped bundles run without node_modules | `56d7a97` |
| quality | Add CI that runs typecheck, tests and a stale-bundle check | No .github/ existed; the committed dist/ the tests exercise could be stale relative to src/ with nothing catching it | Every push/PR typechecks, fails on a stale bundle, runs tests and verify:bundle on Node 22 and 24 | `4f70810` |
| quality | Resolve the hook's plugin root with fileURLToPath | The fallback used URL.pathname (percent-encoded, /C:/ on Windows), so a plugin path with a space silently skipped the status line install | The fallback works for paths with spaces and on Windows | `24f6d39` |
| quality | Make the benchmark scripts fail loudly and stop hard-coding counts | A missing zod corpus was skipped silently (NaN% if empty); '69 -> 4' was a literal printed as 'Measured'; reduce() without an initial value threw an opaque TypeError | Benchmark output is honest about what is measured and fails clearly on a missing corpus | `604df7a` |
| quality | Warn when code_edit leaves the edited symbol undefined | Nothing checked that new_source still defined the requested symbol (and the parse guard is skipped on files with errors), yet the reply said 'No re-read needed' | The model is told when an edit removed or renamed the symbol instead of assuming success | `fc6c3be` |
| quality | Pin code_edit splicing after non-ASCII text | Hot-spot lead said spans were UTF-8 byte offsets; verified false on web-tree-sitter 0.25 (UTF-16 code units), but nothing guarded it | A future web-tree-sitter upgrade that changes offset semantics fails the suite instead of corrupting files | `2284de7` |
| quality | Remove the unused readFileSafe helper | Dead code whose name implied a non-throwing read but which was a bare fs.readFile | Less misleading surface in src/util | `012ddb1` |
| quality | Mark the original design spec as historical | Spec read 'approved, executing' while describing a PostToolUse hook, .scm queries and ripgrep that don't exist and omitting db_schema, statusline, Codex | Readers are pointed to README/src and told exactly where the spec diverges | `c7fb829` |
| quality | Ignore the dashboard preview output | preview-dashboard.ts writes dash-preview.html to the repo root, which was not gitignored | Previewing the dashboard can no longer leak a generated file into commits | `a444b80` |
| security | Run code_search queries on a linear-time regex engine (re2js) | Model-supplied regex ran on V8's backtracking engine synchronously on the stdio event loop; (a+)+$ froze the server (ReDoS) | No query can stall the MCP server; ordinary regex syntax still works, lookaround/backreference queries fall back to a literal search with a note | `477420c` |
| security | Only let db_schema read env vars that hold a Postgres URL | connection_env is model-chosen; a prompt-injected call could point pg at any secret in the server env and get error text back | Non-Postgres-URL values are refused before pg parses or dials them, and the error never echoes the value | `1564f6c` |
| security | Bound db_schema introspection on the server side | query_timeout only stops the client waiting; the catalog query kept running server-side, and the sqlite3 CLI fallback had no timeout | Postgres introspection runs in BEGIN READ ONLY with statement_timeout/lock_timeout; sqlite3 CLI is killed after 10 s | `74f7c72` |
| security | Create the metering store and dashboard private to the user | Ledger, session pointers and dashboard.html list project paths and file names but were created 0755/0644 | Other local users can no longer read a user's project paths and file names from new MOZCODE state | `c8bac7b` |
| security | Escape timestamp-derived day labels in the dashboard | p.day (from the ledger ts) was the only ledger-derived string interpolated raw into the dashboard SVG | A tampered ledger line cannot inject markup into dashboard.html; escaping of paths/tools/sessions/timestamps is now pinned by a test | `4a864e7` |
| security | Keep code_edit writes inside the project root | code_edit accepted absolute and ../ paths (also while UNRESOLVED), so a prompt-injected model could rewrite code in other repos, plugin hooks or global packages, bypassing the host's workspace write boundary | Writes outside the project (../, absolute, sibling-prefix, symlink escapes) are refused unless MOZCODE_ALLOW_EDIT_OUTSIDE_PROJECT=1 | `611ebb4` |
| security | Update the MCP SDK and patched transitive deps, rebuild dist | npm audit: high in @modelcontextprotocol/sdk 1.29.0, fast-uri (inlined in dist/server.js), ip-address, nanoid, source-map-js; critical proxy-addr; moderate qs, hono | npm audit --omit=dev reports 0 vulnerabilities; the shipped bundle carries the patched SDK 1.32.1 and fast-uri 3.1.8 | `e55f3fe` |
| security | Upgrade vitest to 5 to clear critical dev-dependency advisories | Critical advisories in vitest 3.2.7, tinypool and @vitest/mocker remained after the runtime fixes | npm audit reports 0 vulnerabilities across all deps | `da591d9` |
| scale | Reuse one parser per language and free parse trees | parserFor created a new WASM Parser on every call and extractSymbols never deleted the Tree; the WASM heap is not garbage collected and never shrinks, so every cache miss and code_edit validation leaked memory in the long-lived MCP server | 1500 parses of src/db/schema.ts: RSS 129 MB -> 1067 MB before, 127 MB -> 197 MB after (flat at 4000 parses); 4.9 ms/parse unchanged (.repochad/bench/parse-rss.ts) | `f4bacf2` |
| scale | Cap each tree-sitter parse at 500 ms | extractSymbols parsed synchronously with no limit, so one huge or minified file blocked the single-threaded stdio server for every other call | 6.1 MB TS file: event-loop block 1465 ms -> 517 ms; 4.3 MB dist/server.js 899 ms -> 519 ms; bounded at ~500 ms for any size; normal parses unchanged at 4.9 ms (.repochad/bench/parse-budget.ts) | `2c4128e` |
| scale | Cap code_read's plain-text fallback at 2000 lines / 100k chars | For unsupported or too-large-to-parse files, code_read returned the whole file numbered with no cap, costing more tokens than the built-in Read | package-lock.json: 45,592 returned tokens -> 29,744 (file is 39,422 tokens); a multi-MB log or bundle is now bounded at ~100k chars instead of growing with file size (.repochad/bench/plain-read.mts) | `731e7de` |
| scale | Count a file's baseline tokens once per version | read/outline/edit re-ran synchronous o200k BPE over the whole source on every call just for the metering baseline, dominating warm-cache latency and blocking the event loop on large files | Warm-cache, 200 calls: schema.ts code_read 3.1 -> 1.3 ms, code_outline 1.9 -> 0.3 ms; 300 KB TS file code_read 24.4 -> 1.0 ms, code_outline 27.9 -> 4.3 ms (.repochad/bench/read-hot.mts) | `64427a3` |
| scale | Read the metering ledger once per moz_savings call | moz_savings called loadEntries() twice, reading and parsing the entire all-project ledger twice per call | Ledger I/O and JSON parsing per moz_savings call halved (2 full reads -> 1) | `261332d` |
| scale | Read code_search files in parallel batches of 32 | code_search awaited up to 5000 stats/reads one at a time, so cold-cache latency was per-file I/O latency times the file count | Synthetic 3000-file tree, no-match query: cold 278 -> 123 ms, warm 84 -> 55 ms (.repochad/bench/search-cold.mts) | `45adee8` |
| scale | Say when code_search hits the 5000-file limit | listSourceFiles stopped silently at 5000 files and path_glob was applied after the cap, so large repos got silent false 'No matches' and narrow globs could be starved | Truncation is now reported; path_glob-scoped searches count only matching files toward the cap; walk order deterministic across filesystems; no latency change (3000-file bench cold 117 ms, warm 58 ms) | `b24a2bb` |
| scale | Group Postgres catalog rows in linear time | postgresSnapshot copied each table's array on every row (O(k^2) per table) and duplicated the existing groupRows helper | Mocked catalog with one 30,000-column table: first db_schema call 1175 ms -> 116 ms; O(k^2) -> O(k) per table (.repochad/bench/pg-grouping.md) | `5f9d84d` |
| scale | Cap db_schema output at a 50k-character budget | renderSnapshot had no output cap, so schemas with thousands of tables returned everything in one tool result | 1500-table SQLite schema: 83,020 -> 16,461 returned tokens (313,953 -> 58,134 chars); omitted objects are named and query narrows the result (.repochad/bench/schema-cap.mts) | `940ead0` |
| scale | Keep an incremental ledger rollup for the status line | Every status line refresh (a fresh process per prompt update) re-read and parsed the entire never-rotated all-project ledger, so cost grew with lifetime usage | 200k-entry (37 MB) ledger: 0.24 s -> 0.04-0.05 s per refresh (flat, same as empty ledger); O(lifetime entries) -> O(new entries) (.repochad/bench/statusline-ledger.md) | `632e65b` |

## Reverted changes

None. Every kept commit passed the full test suite on the first try.

## Skipped ideas and why

| Category | Idea | Reason skipped |
|---|---|---|
| quality | Atomic code_edit write (temp + rename) | Low confidence the trade-off is right: rename breaks symlinks/hard links and file modes, which needs the same handling as the settings fix; the crash window is small |
| quality | Signed savings (book overhead instead of clamping to 0) | Product/metric-definition change that alters every headline number; needs an owner decision |
| quality | moz_status doctor self-test | New feature, not a correctness fix |
| quality | Tighten statusline isOurs() heuristic | Low impact; any stricter rule risks orphaning existing installs |
| quality | engines field / Node version declaration | Runtime falls back to the sqlite3 CLI; the right floor (18 for runtime, 22.12 for dev/tests) is a maintainer call |
| quality | Per-tool sparklines, TOOL_ORDER colour fallback, byFile cross-project merge, UTC byDay | Cosmetic/low impact |
| quality | Atomic session pointer, install-codex atomic re-register, codex-compat harness hardening, test temp cleanup | Low impact; stopped here |
| security | Confine code_read / code_outline / db_schema path to the project | Product decision: host Read tools also read outside the workspace and monorepo users read sibling packages. Question for the owner: should reads be confined too (same opt-out as code_edit)? |
| security | Shell-quote pluginRoot in the status line command | Low confidence it is worth it: the source is the host's CLAUDE_PLUGIN_ROOT or the hook's own path (trusted), changing the quoting would rewrite every existing install's settings.json, and Windows quoting differs |
| security | V8 linear-time regexp flag for code_search | Superseded by the re2js commit; the flag needs launch-arg changes in two manifests and does not cover the i/u flags |
| security | Plugin userConfig (sensitive) for the Postgres URL | New configuration feature rather than a fix; the URL-shape guard already closes the arbitrary-env-var read. Owner decision |
| scale | Make metering writes non-blocking | Low impact (sub-millisecond local append) and making it fire-and-forget would let moz_savings miss the call it just made; not worth the ordering risk |
| scale | Fix file-cache byte accounting (UTF-16, symbols, trees) | Low confidence it matters: trees are now freed after parse, and an oversized entry is evicted on the next access to another file; a precise memory model is guesswork |
| scale | Postgres introspection via pg_index and fewer round trips | Cannot verify against a real PostgreSQL here (opt-in test is skipped); one pg Client cannot pipeline queries anyway |
| scale | Move SQLite introspection off the event loop | Catalog queries are small and already bounded; the CLI fallback already has a 10 s timeout from the security pass |
| scale | Loosen the statusline exit-delay timing assertion | Test-stability tweak, not a scale fix; no flake observed in this run |
| scale | Outline depth control and directory outlines | Changes default output (hides members) and adds a feature; product decision for the owner |
| scale | .gitignore-aware source walk (node-ignore) | Adds a runtime dependency; the file-limit truncation is now reported instead, owner can decide on the dependency |
| scale | Switch grammars to @vscode/tree-sitter-wasm and web-tree-sitter 0.27 | Medium-effort dependency migration with possible node-type differences; explicit tree/parser freeing already fixes the leak |

## Open questions for the owner

1. **Should the read tools be confined to the project too?** `code_edit` now refuses writes outside the project root (opt-out: `MOZCODE_ALLOW_EDIT_OUTSIDE_PROJECT=1`). `code_read`, `code_outline` and the `db_schema` path still accept `../` and absolute paths, matching the host's own Read tool. Monorepo users may rely on that.
2. **Should savings be signed?** `makeMeta` clamps saved tokens at 0, so calls that cost more than the built-in tool are never booked as a loss. Changing that moves every headline number.
3. **Which Node version is the floor?** The bundle targets Node 18 and falls back to the `sqlite3` CLI, but `node:sqlite`, vitest 5 and CI need Node 22.12+. An `engines` field was not added.
4. **New runtime dependencies?** `.gitignore`-aware search (node-ignore) and moving the grammars to `@vscode/tree-sitter-wasm` were left out because they add or swap dependencies.
5. **Postgres URL as a plugin secret?** A `userConfig` (sensitive) setting would keep the DB URL out of the shell environment. That is a new configuration feature.
6. **Existing local state.** New `~/.mozcode` files are created private (0700/0600), but existing ones keep their old modes (`chmod -R go-rwx ~/.mozcode` fixes that). An earlier benchmark run left 498 synthetic rows in `~/.mozcode/metering/bench_corpus-*.jsonl`, which you may want to delete.
7. **Bundle size.** re2js adds about 6.3k lines of bundled tables to `dist/server.js`.
8. **Performance note.** `benchmark:performance` reports cached `db_schema` at 0.22x the speed of raw SQLite (slower). This was noticed but not investigated.
9. **CI has not run on GitHub yet.** `.github/workflows` was added and the local build was checked byte-identical to the committed `dist/`. The first push to this mirror is its first real run.

## How to review and test this branch locally

```bash
git clone https://github.com/Malek1414/MOZCODE-repochad.git
cd MOZCODE-repochad
git checkout repochad/2026-10-11

# See every change, one commit per improvement
git log --oneline main..repochad/2026-10-11
git diff --stat main...repochad/2026-10-11
git show <sha>              # read one change with its "why" in the commit body

# Run the checks (Node 22.12+ or 24)
npm ci
npm run typecheck
npm test                    # expect 18 files, 143 passed, 1 skipped
npm run verify:bundle       # proves dist/ runs without node_modules

# Optional: the Postgres test against a throwaway database
MOZCODE_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/scratch npm test
```

To try it as a plugin, point Claude Code at your checkout of this branch the same way you install MOZCODE today, start a session, and check that `code_search` with `path_glob: "src/**/*.ts"` returns matches and that the status line still shows savings.

The `.repochad/bench/` scripts behind the scale numbers stay local and are not committed. Each scale entry above names the script it came from.

If one change is unwanted, revert just that commit on the branch with `git revert <sha>` (no force-push needed).

## How to open a PR to the original repo (only after you approve)

Nothing has been sent to `Malek1414/MOZCODE`. When you are happy with the branch:

```bash
gh pr create --repo Malek1414/MOZCODE --base main \
  --head Malek1414:repochad/2026-10-11 \
  --title "RepoChadLite: quality, security and scale fixes" \
  --body-file .repochad/REPOCHAD.md
```

`Malek1414/MOZCODE-repochad` is a separate repository, not a GitHub fork, so GitHub may not let you open a cross-repo PR from it. In that case, push the branch to the original repo from your own clone (`git push https://github.com/Malek1414/MOZCODE.git repochad/2026-10-11`) and open the PR there. You can also open it in the browser at https://github.com/Malek1414/MOZCODE/compare. Either way, do it yourself. RepoChadLite never pushes to the original.

You may want to leave the `.repochad/` folder out of the PR. If so, run `git rm -r --cached .repochad && git commit -m "chore: drop RepoChadLite report"` on a copy of the branch first.
