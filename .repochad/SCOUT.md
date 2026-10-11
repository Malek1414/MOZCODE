# SCOUT (round 2): MOZCODE improvement leads

This file synthesises the second scout round: 27 vetted findings, deduplicated to 22 items (12 quality, 5 security, 5 scale). All items have fit >= 3, and each was checked for licence, recency (pushed within 12 months) and adoption. The base for this round is branch `repochad/2026-10-11` after the round-1 quality commits (1a191d1..1e00187).

- Hot-spot numbers (#N) refer to `.repochad/MAP.md`.
- Round-1 items are written as **R1-xx** and are kept unchanged in `.repochad/SCOUT.round1.md`.
- **Licence rule:** context-mode is ELv2, Serena is GPL-3.0, and jCodeMunch uses a dual-use licence. From these, copy the design only and never the code. WOZCODE is proprietary. MOZCODE stays clean-room MIT.

Spot-checked on the branch while writing this file:
- `.codex-plugin/plugin.json` has no `hooks` key.
- `src/tools/search.ts` `buildRegex` still runs `new RegExp(query, "g")` on model input.
- `src/` has no `.delete()` calls, and `loader.ts:83` still runs `new Parser()` on every call.
- `types.ts:31` still clamps savings with `Math.max(0, ...)`.
- `package.json` still pins `@modelcontextprotocol/sdk ^1.19.1` and `vitest ^3.0.0`.
- There is no `LICENSE` file and no `.github/` directory.
- `stash@{0}` still holds the atomic-write WIP.

---

## TOP 5: what the improvement passes should use

| # | Item | Pass | Fit | Effort | Hot spots |
|---|------|------|-----|--------|-----------|
| 1 | Separate Codex hook file, so Codex stops running the Claude Code SessionStart hook (Q1) | quality | 5 | S | 14, 20 |
| 2 | Upgrade `@modelcontextprotocol/sdk` to ^1.32.1 and vitest to ^5.0.3, then **rebuild dist/** (S1) | security | 5 | S | 16, 19 |
| 3 | ReDoS-safe `code_search` with re2js and a literal fallback (S2) | security | 5 | S | 5, 11 |
| 4 | web-tree-sitter hygiene: `tree.delete()`, one Parser per language, and a parse deadline (SC1) | scale | 5 | S | 2, 11 |
| 5 | Signed savings: record overhead and losses instead of clamping them to zero (Q2) | quality | 4 | S | 17 |

**Next in line** (if the pass has budget left): Q3 CI, S3 `db_schema` env allow-list, Q4 doctor check, Q5 LICENSE and notices, SC2 outline depth and directory overview.

Why these five:
- **Item 1** is a live cross-host bug. Under Codex, the Claude hook rewrites `~/.claude/settings.json`, and the status-line path flips between hosts on every session. It is also the only routing lever MOZCODE has on Codex.
- **Item 2** was in the round-1 top 5 and is still open. It is the only advisory fix that reaches users, because fast-uri is inlined in `dist/server.js`.
- **Item 3** closes a measured 17.5 s event-loop freeze caused by a single regex.
- **Item 4** fixes a measured RSS growth from 52 MB to 876 MB, and it caps the 790 ms parse block. It needs no new dependency.
- **Item 5** keeps the product's core claim (tokens saved) honest.

All five are small, local and testable with the existing suite.

---

## Quality

### Q1. Separate Codex hook file, so Codex stops running the Claude Code SessionStart hook [TOP 5]
- **URLs:** https://learn.chatgpt.com/docs/hooks. Peers: https://github.com/mksglu/context-mode (ELv2, design only), https://github.com/rtk-ai/rtk/blob/master/hooks/codex/README.md (Apache-2.0)
- **Fit 5 | Effort S**
- **What:** Codex lifecycle hooks are on by default. Codex auto-loads `hooks/hooks.json` from a plugin root unless `.codex-plugin/plugin.json` sets `hooks`, and it sets `CLAUDE_PLUGIN_ROOT` so Claude-format hooks run. context-mode ships its own `.codex-plugin/hooks.json` with per-event adapters. rtk has a fail-open `Host::Codex` handler.
- **For MOZCODE:** `.codex-plugin/plugin.json` has no `hooks` key, so once the user trusts the hook, Codex runs `hooks/session-start.mjs`. That causes two problems:
  - (a) The hook calls `installStatusLine(defaultSettingsPath(), ...)`, which writes `~/.claude/settings.json` (`statusline-install.mjs:30`) and points it at the Codex plugin-cache copy. With both hosts installed, the path flips on every session, because `isOurs` matches either copy.
  - (b) The hook injects a nudge about built-in Read/Grep, tools that Codex does not have.
- **Fix:**
  1. Add `"hooks": "./.codex-plugin/hooks.json"` to the Codex manifest.
  2. In that file, register a Codex-only SessionStart (`startup|resume|clear|compact`) that skips the status-line install and names Codex's tools (shell, grep_files, apply_patch).
  3. Optionally, add a PreToolUse hook on `grep_files|shell` that adds context pointing to `code_search`.
  4. Add a test that the Codex hook never touches `~/.claude`.

### Q2. Signed savings: record overhead and losses (trace-mcp PR #915 correction) [TOP 5]
- **URLs:** https://github.com/nikolai-vysotskyi/trace-mcp (MIT). Same reporting pattern: https://github.com/jgravelle/jcodemunch-mcp (ideas only)
- **Fit 4 | Effort S**
- **What:** trace-mcp found that 4 of its 23 tools returned more tokens than the Read/Grep they replaced. It now credits zero to tools that replace no read and books them as overhead. It also publishes an all-in figure (66.5% against 67.4%) and lists the cases where it lost.
- **For MOZCODE:** `makeMeta` clamps `savedTokens = Math.max(0, baseline - actual)` (`src/tools/types.ts:31`), so overhead never shows. Concrete cases:
  - Grouped `code_search` output can be longer than the raw grep lines.
  - A search with no matches forces `baseline=1` but returns about 10 tokens (`search.ts:72-76`).
  - `code_outline` on an unsupported language books the whole file minus the first 40 lines as saved (`outline.ts:19-27`).
  - The always-loaded tool schemas are never counted: 1,043 o200k tokens for `tools/list`, of which about 200 are for the three `moz_*` tools.
- **Fix:**
  1. Store the signed delta.
  2. Have `summarize` and `computeMetrics` report net savings, with overhead on its own line.
  3. Credit zero to degraded fallbacks.
  4. Optional: fold the `moz_savings`, `moz_status` and `moz_dashboard` tools into one `moz_status{view}`.
- Pairs with Q6. The fix touches the status line and the dashboard, so update their tests.

### Q3. CI: GitHub Actions with stale-dist check, audit, OSV-Scanner, Dependabot, plugin validate and an MCP smoke test (merged from 4 findings)
- **URLs:** https://github.com/actions/setup-node, https://github.com/google/osv-scanner-action (Apache-2.0), https://code.claude.com/docs/en/plugins-reference#validate-the-manifest, https://github.com/modelcontextprotocol/inspector
- **Fit 4 | Effort S** (supersedes R1-Q8)
- There is no `.github/` directory. The black-box tests run the committed `dist/` with no pretest build, so a source fix that was never rebuilt passes locally and still ships the old code (#16, #19). Add a Node 22/24 matrix job:
  ```
  npm ci && npm run build && git diff --exit-code dist/ grammars/ && npm run typecheck && npm test && npm audit --omit=dev --audit-level=high
  ```
- Add these steps to the same workflow:
  - `node scripts/verify-bundle.mjs`, which is orphaned today.
  - `claude plugin validate --strict`, which catches manifest and hook mistakes. The manifests change in Q1, R1-Q1 and S3.
  - `npx @modelcontextprotocol/inspector --cli node dist/server.js --method tools/list`, plus one `tools/call`, as an independent handshake check. It needs Node >=22.19, and it is a dev tool only, so there is no bundle or licence impact.
  - OSV-Scanner, and `.github/dependabot.yml` for npm and github-actions. **Configure Dependabot to ignore web-tree-sitter minor versions** (see SC4).

### Q4. Doctor check: turn `moz_status` into a live install and runtime self-test
- **URLs:** https://github.com/mksglu/context-mode (`ctx_doctor`, ELv2, design only), https://github.com/jgravelle/jcodemunch-mcp (`install-status`)
- **Fit 4 | Effort S** (absorbs the round-1 addendum item "loud startup self-check")
- `moz_status` (`src/server.ts:283-293`) prints only static text. Instead, run these checks live and print pass/fail lines, each with a one-line fix:
  - `node:sqlite` is present (needs Node >=22.5, while the bundle targets node18, #16).
  - The `sqlite3` CLI is on PATH.
  - web-tree-sitter initialises and each grammar actually loads (#12).
  - `~/.mozcode/metering` is writable.
  - The status line in `~/.claude/settings.json` points at this plugin root.
  - The project resolved.
- This is about 60 lines in an existing handler. Also log one clear stderr line at startup if any grammar fails to load.

### Q5. Ship a LICENSE file and third-party notices for the bundled dist/
- **URLs:** https://esbuild.github.io/api/#legal-comments, https://www.npmjs.com/package/generate-license-file (ISC, v4.2.5)
- **Fit 4 | Effort S**
- `package.json` says MIT, but the repo has no LICENSE file. `dist/server.js` inlines @modelcontextprotocol/sdk, pg, gpt-tokenizer, web-tree-sitter, zod and ajv (all MIT) and fast-uri (BSD-3-Clause), yet only 2 copyright or `@license` strings survive in it. MIT and BSD-3 both require the notice to travel with redistributed copies.
- **Fix:**
  1. Add a `LICENSE` file.
  2. In `scripts/bundle.mjs`, add a notices step: either feed the esbuild metafile inputs to generate-license-file, or use `legalComments:'external'`.
  3. List the grammars' upstream MIT licences. tree-sitter-wasms itself is Unlicense.
- This matters more for a project that markets itself as a clean-room alternative to a proprietary product.

### Q6. Benchmark against a grep-and-read baseline on pinned public repos, and publish the losses
- **URLs:** https://github.com/jgravelle/jcodemunch-mcp (methodology only), https://github.com/nikolai-vysotskyi/trace-mcp (`benchmarks/pr-context/dataset.json`)
- **Fit 4 | Effort M**
- `scripts/benchmark.ts` measures each tool against the whole file it came from, which is a read-all ceiling. It also has hard-coded "69 -> 4" literals (#22) and writes to the real ledger (#3).
- **Fix:**
  - Write a small task file of queries, each mapped to an expected symbol, over a pinned commit of zod plus this repo.
  - Compare against an `rg -l`-top-3-files baseline, which is "the number to quote".
  - Print a per-task table that includes the regressions, and point the ledger at a temp directory.
- It reuses the existing tools and gpt-tokenizer, so no new dependencies are needed. Run it later in CI to catch token regressions. Do this after Q2.

### Q7. Return syntax diagnostics from `code_edit` (Serena EditingToolWithDiagnostics, mcp-language-server)
- **URLs:** https://github.com/isaacphi/mcp-language-server (BSD-3-Clause), https://github.com/oraios/serena (GPL-3.0, design only)
- **Fit 3 | Effort S** (same idea as the round-1 addendum "post-edit syntax check")
- `code_edit` only accepts or rejects, and it skips the check when the original file already had errors (#8, `edit.ts:33`). After the splice, collect the ERROR and MISSING nodes inside or next to the edited span. Return `line:col` plus a one-line excerpt for each, both on rejection and as warnings on success. Compare error counts before and after the edit, rather than skipping the check. This uses tree-sitter only: no LSP and no new dependency.

### Q8. Atomic, symlink- and mode-preserving writes (write-file-atomic, or its pattern)
- **URL:** https://github.com/npm/write-file-atomic (ISC, v8.0.0)
- **Fit 3 | Effort S** (same as R1-Q6, which is still open)
- There are three unsafe writes:
  - `src/tools/edit.ts:80` writes in place with `fs.writeFile`, which is not atomic (#22).
  - `hooks/statusline-install.mjs:120-124` renames a temp file over `~/.claude/settings.json`, which replaces a symlink with a plain file and resets its mode (#20).
  - The dashboard write.
- **Caveat:** v8 requires node `^22.22.2 || ^24.15 || >=26`, and `hooks/*.mjs` run unbundled with no node_modules. So either bundle the library for `code_edit` and the dashboard, or copy its realpath-plus-mode pattern (lib/index.js:93-106) into the hook.
- **Start from `stash@{0}`**, an interrupted WIP for an atomic `code_edit` write with a stale-read guard. Finish and test it, or drop it.

### Q9. Grammar-load smoke test, and the web-tree-sitter >=0.26 pitfall
- **URL:** https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
- **Fit 3 | Effort S** (prerequisite for SC4 and R1-Q9)
- Verified in scratch: web-tree-sitter 0.26.13 and 0.27.1 both fail in `Language.load` (in the dylink loader) for all four committed tree-sitter-wasms grammars. The `^0.25.10` range protects users today, but a Dependabot bump (Q3) would silently disable every `code_*` tool.
- Add a test that loads every `grammars/*.wasm` through `loader.ts`, and also through `dist/server.js`. Pin or ignore web-tree-sitter minor versions until SC4 lands.

### Q10. knip for dead code and unused dependencies
- **URL:** https://github.com/webpro-nl/knip (ISC, v6.41.0, 12.4k stars)
- **Fit 3 | Effort S** (supersedes R1-Q14, now with evidence)
- A read-only run flagged the following:
  - Unused exports: `readFileSafe` (`src/util/files.ts:83`), `readCurrentSession` (`src/metering/store.ts:81`) and `DEFAULT_ASSUMPTIONS` (`src/dashboard/metrics.ts:24`).
  - The orphaned `scripts/verify-bundle.mjs`.
  - The undeclared `codex` binary used by `scripts/install-codex.mjs`.
- First add a `knip.json` that declares the entry points `hooks/*.mjs`, `src/statusline.ts` and `dist/*`, to remove the false positives. Then add knip to CI (#22).

### Q11. picomatch for `path_glob`
- **URL:** https://github.com/micromatch/picomatch (MIT, v4.0.7, already in node_modules transitively)
- **Fit 3 | Effort S** (R1-Q4. Commit 1a191d1 chose a hand-rolled fix to keep zero new dependencies.)
- The current `globToRegex` (`src/util/files.ts:39-81`) supports only `*`, `**` and `?`. So `src/**/*.{ts,tsx}`, `!**/*.test.ts` and `[a-c]*.ts` are escaped literally and silently return "No matches". Replace it with `picomatch(glob, {dot:false, basename: !glob.includes('/')})`, which removes about 40 lines. Alternatively, if zero new dependencies stays the policy, at least reject unsupported syntax with an explicit error.

### Q12. Postgres `db_schema` integration tests (Testcontainers, or an Actions postgres service)
- **URL:** https://github.com/testcontainers/testcontainers-node (MIT)
- **Fit 3 | Effort M** (guards R1-Q11)
- The Postgres path in `src/db/schema.ts` has no tests, and `indexColumns` regex-parses `indexdef` (#18). Add a vitest suite, gated on Docker being available, that starts postgres:16 and creates expression, opclass, DESC and INCLUDE indexes. Snapshot the `renderSnapshot` output before moving to `pg_get_indexdef(oid,k,true)`. pg-mem was rejected because it lacks the pg_catalog functions this code needs.

---

## Security

### S1. Upgrade `@modelcontextprotocol/sdk` to ^1.32.1 and vitest to ^5.0.3, then rebuild dist/ [TOP 5]
- **URL:** https://github.com/modelcontextprotocol/typescript-sdk
- **Fit 5 | Effort S** (R1-S1, still open)
- `npm audit` on the current branch reports 11 advisories:
  - Critical: proxy-addr, tinypool and vitest.
  - High: the SDK (OAuth credential redirection), fast-uri (host confusion), ip-address, nanoid and source-map-js.
- Every advisory except the vitest chain is fixable with a non-major bump. fast-uri is inlined in `dist/server.js` (10 occurrences), so **the fix reaches users only after `npm run build`**.
- vitest 5 is semver-major, so check `vitest.config.ts`. Re-run the black-box tests after the rebuild (#16, #19).

### S2. ReDoS-safe `code_search`: re2js by default, keeping the escaped-literal fallback (merged from 3 findings) [TOP 5]
- **URLs:** https://github.com/le0pard/re2js (MIT, v2.8.6, about 8.9M weekly downloads, zero dependencies, node>=18). Alternatives: https://v8.dev/blog/non-backtracking-regexp, https://github.com/BurntSushi/ripgrep
- **Fit 5 | Effort S** (supersedes R1-S3 steps 1 and 3 for the catastrophic case)
- **Problem:** `buildRegex` (`src/tools/search.ts:18-24`) runs `new RegExp(query, "g")` on model input, synchronously over up to 5000 files, on the stdio event loop (#5, #11).
- **Measured:** on the pattern `(a+)+$` against 28 `a`s plus `!`, V8 took 17,571 ms and re2js took 0.5 ms. On a realistic scan of 34,676 lines, re2js took 11.9 ms against 2.6 ms for RegExp, so normal searches stay fast.
- **Fix:** replace `buildRegex`/`rx.exec` with `RE2JS.compile(q).matcher(line).find()`. RE2 rejects lookaround and backreferences by throwing `RE2JSSyntaxException`, so keep the existing escaped-literal fallback for those. Leave the `enclosing()` grouping unchanged. Add a regression test that `(a+)+$` returns within, say, 1 s.
- **Zero-dependency alternative, not preferred:** the V8 linear engine. Compile with `new RegExp(q,'gl')` under `--enable-experimental-regexp-engine` and fall back to a literal on throw. This was verified on Node 22.16, but the flags are experimental, must be passed in both `.claude-plugin/plugin.json` args and `scripts/install-codex.mjs`, and do not cover the `i`/`u` flags.
- **Later, optional:** spawn `rg --json` with a timeout only when `command -v rg` resolves to a real binary. On this machine `rg` is a shell function, not a binary. Never use @vscode/ripgrep, because its postinstall download breaks the pre-bundled model.

### S3. `db_schema`: stop letting the model choose which env var is read (allow-list, plus `userConfig` sensitive)
- **URL:** https://code.claude.com/docs/en/plugins-reference#user-configuration
- **Fit 4 | Effort S**
- `connection_env` (`src/server.ts:170-173,267`, `src/db/schema.ts:367`) lets a prompt-injected model point pg at any env var in the server process (#7). A local test did not echo secret-shaped values in pg errors, so treat this as a least-privilege fix, not a confirmed leak.
- **Fix:**
  1. Accept only `DATABASE_URL` plus the names listed in a user-set `MOZCODE_DB_ENVS`. Reject anything else with `isError`.
  2. Optionally, add `userConfig.postgres_url {sensitive:true}`, mapped through `.claude-plugin/plugin.json` `mcpServers.mozcode.env`. Codex keeps the allow-list path through `install-codex.mjs`.

### S4. Server-side Postgres guards and a timeout on the sqlite3 CLI fallback
- **URL:** https://node-postgres.com/apis/client
- **Fit 3 | Effort S**
- `inspectPostgres` (`schema.ts:348-353`) sets only `connectionTimeoutMillis` and the client-side `query_timeout`. Add:
  - `statement_timeout: 10_000`
  - a `lock_timeout`
  - `options: '-c default_transaction_read_only=on'`
- These make introspection read-only and bounded on the server, which matches the tool's `readOnlyHint:true`.
- `querySqliteCli` (`schema.ts:189`) runs `execFile('sqlite3', ...)` with no timeout (#11). Add `timeout: 10_000` and a `killSignal`. Each of these is a one-line change. Do it in the same commit series as S3.

### S5. Owner-only permissions for `~/.mozcode` ledgers, session pointers and the dashboard
- **URL:** https://nodejs.org/api/fs.html#fspromisesappendfilepath-data-options
- **Fit 3 | Effort S**
- `src/metering/store.ts:40,51,73` and `src/dashboard/generate.ts:27` create files with the default umask (0644 for files, 0755 for directories). Every entry records an absolute project path, a file path and a session id (#22).
- Pass `{mode:0o700}` for directories and `{mode:0o600}` for files, and run a one-time `chmod` on files that already exist. This is about 4 lines with no behaviour change for a single user.

---

## Scale

### SC1. web-tree-sitter memory and time controls: `tree.delete()`, one Parser per language, and a parse deadline (merged from 2 findings) [TOP 5]
- **URLs:** https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web, https://app.unpkg.com/web-tree-sitter@0.25.6/files/web-tree-sitter.d.ts
- **Fit 5 | Effort S** (R1-SC1, plus the parse cap)
- **Problem:** `loader.ts` creates a new Parser on every call, and `engine.ts:225-230` never deletes the Tree or the Parser (#2). Parsing has no size or time cap (#11).
- **Measured** on the installed 0.25.10 with the repo's own grammar:
  - Memory: 1500 cache-miss parses of `src/db/schema.ts` grew RSS from 52 MB to 876 MB without delete, and only to 155 MB with delete.
  - Time: parsing the 4 MB `dist/server.js` blocks the event loop for about 790 ms, and a 6.6 MB TS file took 1,237 ms.
  - Deadline: `parse(src, null, {progressCallback: () => performance.now()-start > 20})` cancelled the parse in about 20 ms (it returns `null`).
- **Fix:**
  1. Cache one Parser per `LanguageId`.
  2. Wrap parse and walk in `try { ... } finally { tree.delete() }`.
  3. Pass a deadline `progressCallback` in `extractSymbols`, and add a byte-size pre-check. Map a `null` tree to the existing degraded or whole-file path.
  4. Add a regression test that RSS stays bounded over N parses, and that an oversized input degrades instead of blocking.
- No new dependency is needed. `setTimeoutMicros` is deprecated, so do not use it.

### SC2. Outline depth control and directory overview (Serena `get_symbols_overview` design)
- **URL:** https://github.com/oraios/serena/blob/main/src/serena/tools/symbol_tools.py (GPL-3.0, design only)
- **Fit 4 | Effort S**
- `renderOutline` (`src/tools/outline.ts:7-15`) prints every symbol at every depth, and it accepts only one file.
- **Fix:**
  - Add `depth` (default 1) and a character budget, with an explicit marker: "N more symbols, re-call with depth=...".
  - Then let `code_outline` take a directory and return a capped, top-level-only listing that respects the `listSourceFiles` skip rules.
- This cuts both tokens and round trips. It complements R1-SC2 (output caps) and a later `code_map` (R1-Q9).

### SC3. `.gitignore`-aware source walk with node-ignore
- **URL:** https://github.com/kaelzhang/node-ignore (MIT, v7.0.12, about 330M weekly downloads, zero dependencies)
- **Fit 4 | Effort S** (R1-SC4, still open)
- `src/util/files.ts:4-6` uses a fixed `IGNORED_DIRS` list. So vendor/, out/, target/ and generated folders use up the silent 5000-file cap and add noise to `code_search` (#10).
- **Fix:** load the root `.gitignore` once per project, then prune each directory with `ig.ignores(rel + '/')` before descending into it. It is tiny and bundles into dist.

### SC4. `@vscode/tree-sitter-wasm` as the grammar source (unblocks web-tree-sitter 0.27 and more languages)
- **URL:** https://github.com/microsoft/vscode-tree-sitter-wasm (MIT, v0.3.1, about 200k weekly downloads)
- **Fit 4 | Effort M** (merged with the >=0.26 pitfall. Q9 is the prerequisite.)
- tree-sitter-wasms (18 stars, last release 2025-10) builds grammars that fail on web-tree-sitter 0.26 and 0.27, which pins MOZCODE to 0.25.x. The @vscode grammars load on both 0.25.10 and 0.27.1 (verified, ABI 14/15). The upgrade has two payoffs:
  - (a) web-tree-sitter 0.27 adds FinalizationRegistry auto-free. Measured over 1500 parses without delete: 319 MB on 0.27.1 against 776-876 MB on 0.25.10. Explicit delete (SC1) is still best, at 76 MB.
  - (b) Go, Java, Rust, C++, C#, Ruby, PHP and Bash grammars become available for R1-Q9.
- Copy the .wasm files into `grammars/` in `bundle.mjs`, and re-run the outline and edit tests, since node type names may differ. If the bundled grammars are rebuilt from upstream instead, use `tree-sitter build --wasm`.

### SC5. lru-cache for the AST file cache
- **URL:** https://github.com/isaacs/node-lru-cache (BlueOak-1.0.0, v11.5.3)
- **Fit 3 | Effort S** (R1-SC6. Its rejected-promise part already landed in 1e00187.)
- `src/ast/file-cache.ts` counts only `stat.size`, which ignores UTF-16 doubling and WASM tree memory (#11).
- **Fix:**
  - Use `maxSize` with `sizeCalculation = source.length*2` plus an estimate for the tree.
  - If trees are ever cached, use `dispose` to call `tree.delete()` on eviction.
  - Cache the baseline token count per (mtime, size), instead of re-running o200k BPE over the whole file on every call (`tokens.ts:16`, `read.ts:25`, R1-SC8).

---

## Dedup log (round 2)
- "web-tree-sitter Tree.delete/Parser reuse/progressCallback" + "ParseOptions.progressCallback budget" -> **SC1**
- "re2js" + "V8 linear-time RegExp engine" + "ripgrep optional backend" -> **S2** (re2js is the default, V8 is the zero-dependency alternative, rg is a later option)
- "GitHub Actions CI" + "`claude plugin validate --strict`" + "MCP Inspector CLI smoke test" + Dependabot ignore rule from the "web-tree-sitter >=0.26 pitfall" -> **Q3**
- "web-tree-sitter >=0.26 pitfall" (smoke-test part) -> **Q9**; (grammar-source part) -> **SC4** with "@vscode/tree-sitter-wasm"
- "Doctor check" + round-1 addendum "loud startup self-check" -> **Q4**
- "code_edit syntax diagnostics" + round-1 addendum "post-edit syntax check" -> **Q7**
- "write-file-atomic" = R1-Q6 + `stash@{0}` -> **Q8**
- "node-ignore" = R1-SC4 -> **SC3**; "lru-cache" = R1-SC6 -> **SC5**; "knip" = R1-Q14 -> **Q10**; "picomatch" = R1-Q4 -> **Q11**; "SDK/vitest bump" = R1-S1 -> **S1**
- "Testcontainers" -> **Q12** (test harness for R1-Q11)
- "db_schema env allow-list" and "Postgres guards" kept separate (**S3**, **S4**), because they address different hot spots (#7 and #11). Do them in one commit series.

## Round-1 status (for the passes; details in SCOUT.round1.md)
- **Landed:**
  - R1-Q2 part 1: SessionStart matcher (20b077b).
  - R1-Q3, partly: `code_edit` isError (3c14566), `context_lines` validation (67cf336), readOnlyHint annotations present.
  - R1-Q4 via a hand-rolled fix (1a191d1).
  - R1-Q5, partly: wrong-span fix (d275f37).
  - R1-Q7: browser opener (f779b5f).
  - R1-Q13: token-count label (1fb6e3d).
  - R1-SC2, partly: 200-match cap flag (3925cee).
  - R1-SC6, partly: rejected promises (1e00187).
- **Still open, not repeated above:**
  - R1-Q1: `settings.json` agent default plus `disallowedTools`. There is still no `settings.json`, and both agents still grant Read and Grep.
  - R1-Q2 part 2: PreToolUse redirect on Read/Grep.
  - R1-S2: realpath path containment (#6).
  - R1-SC2: output caps and pagination (#15).
  - R1-SC3: status-line rollup (#9).
  - R1-Q10: `engines` and the node22 target.
  - R1-Q11/Q12: Postgres index catalog and SQLite `schema_version`.
  - R1-SC5: fdir and the file-list cache.
