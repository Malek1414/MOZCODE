# Area: Dashboard & status line

Paths: `src/dashboard/generate.ts`, `src/dashboard/metrics.ts`, `src/dashboard/render.ts`, `src/dashboard/saira-font.ts`, `src/statusline.ts`

This area turns the metering store (`src/metering/store.ts`: `loadEntries` at store.ts:91, `summarize` at store.ts:127) into two read-only views of the estimated savings. One is a self-contained HTML dashboard written to `~/.mozcode/dashboard.html`, produced by the `moz_dashboard` MCP tool (server.ts:290-293). The other is a one-line ANSI status line for Claude Code, bundled to `dist/statusline.js` (scripts/bundle.mjs:18). Every dollar, time and call figure is derived from measured token savings using fixed assumptions in `metrics.ts`.

Data flow: `~/.mozcode/metering/*.jsonl` → `loadEntries` → `summarize` → `computeMetrics` → (`renderDashboard` → `wrap` → file → browser) or (`segment` → stdout).

---

## src/dashboard/metrics.ts

**Purpose:** the shared derivation layer. It turns a metering `Summary` into KPI figures (cost, time, round-trips) using disclosed assumptions, and holds the formatters both views use.

### `interface MetricAssumptions` / `DEFAULT_ASSUMPTIONS`: metrics.ts:9, metrics.ts:24
- **What:** six constants: $3.00 per 1M input tokens, $0.004 per avoided call, 3.5 s latency per call, 0.05 s prefill per 1k tokens, a search factor of 0.5, and 9 DB turns avoided per schema call.
- **How:** a plain object literal, passed as the default to `computeMetrics`.
- **Why:** the comment at metrics.ts:3-8 says the counterfactual model should be auditable; the dashboard prints these values (render.ts:305-315).
- **Risks:** the numbers are hard-coded with no override (no env or config), so the price goes stale whenever model pricing changes.

### `computeMetrics(summary, _entries, a = DEFAULT_ASSUMPTIONS): KpiMetrics`: metrics.ts:45
- **What:** returns tokensSaved, apiCostSaved, costSaved, callsSaved, timeSavedSec, efficiencyGainPct and a cumulative tokens-saved series by day.
- **How:** reads the `code_edit`, `code_search` and `db_schema` call counts from `summary.byTool` (:51-53). It computes `callsSaved = round(edit + search*0.5 + schema*9)` (:57-59), then cost = tokens/1M*price + calls*costPerCall, and time = calls*latency + tokens/1k*prefill. The cumulative series is a running sum over `summary.byDay` (:65-66).
- **Why:** this one place derives the money and time numbers for both the dashboard and the status line.
- **Depends on / used by:** `Summary` from store.ts:114. Used by `renderDashboard` (render.ts:149), `segment` (statusline.ts:51) and test/dashboard.test.ts:73.
- **Risks:** (a) **Every** `code_edit` call counts as an avoided round-trip, including failed or degraded edits. Those are still metered: src/tools edit returns `makeMeta("code_edit", relPath, 0, …)` with `degraded: true` on the failure paths, and server.ts:256 meters them. So failed edits inflate callsSaved, costSaved and timeSavedSec. (b) The `_entries` parameter is unused. Callers pass `[]` (render.ts:149) or the full array (statusline.ts:51).

### `fmtDuration(sec)`: metrics.ts:81
- **What:** formats seconds as `45s`, `3m 20s` or `1h 12m`.
- **How:** threshold branches with `Math.floor` and `Math.round`.
- **Risks:** rounding happens after taking the remainder, so 119.6 s prints `1m 60s` and 7170 s prints `1h 60m` (edge-case display bug). There is no direct unit test.

### `fmtUsd(v)`: metrics.ts:90
- **What:** prints `$0.0012` (4 dp) under $0.01, 3 dp under $1, and otherwise `$12.34` with grouping.
- **How:** `toFixed` and `toLocaleString("en-US")`.
- **Risks:** none significant.

---

## src/dashboard/render.ts

**Purpose:** builds the dashboard body as one HTML string: inline CSS (light, dark and a toggle), SVG charts, a KPI grid, a top-files list, a session ledger, an assumptions footnote and a small theme-toggle script. It has no runtime dependencies.

### Helpers `fmt`, `comma`, `esc`: render.ts:5, :10, :13
- **What:** `fmt` gives compact `1.2k`/`3M`, `comma` gives a grouped integer, and `esc` escapes `& < > "` for HTML.
- **Risks:** `esc` does not escape `'`. That is fine at present because every attribute uses double quotes. `fmt` duplicates `compact` in statusline.ts:44 with slightly different rules (copy-paste drift).

### `TOOL_ORDER` / `TOOL_LABELS` / `toolLabel(tool)`: render.ts:17-28
- **What:** the display order and friendly names for the five metered tools. An unknown tool name falls back to underscores replaced by spaces.
- **Risks:** a tool missing from `TOOL_ORDER` gets `indexOf = -1`. It sorts first, and its colour becomes `--series-${(-1 % 4) + 1}` = `--series-0` (render.ts:156), which is undefined, so its bar renders invisible. This is latent: all five metered tools (server.ts:242-260) are listed today.

### `sparkline(values, colorVar)`: render.ts:31
- **What:** a 132×34 SVG area and line from a numeric series. It returns an empty string when there are fewer than 2 points.
- **How:** min/max normalisation into an SVG path.
- **Risks:** `Math.max(...values)` spreads the array, which is fine for per-day series. renderDashboard passes the **same token series** to the Cost, Time, Calls and API-cost tiles (render.ts:279-283), so those sparklines do not show their own metric (misleading visual).

### `gauge(pct)`: render.ts:49
- **What:** a donut SVG for 0–100 %, clamped, with an aria-label.
- **How:** circle `stroke-dasharray` set to `dash`/`circumference - dash`, rotated -90°.

### `kpiTile(opts)`: render.ts:62
- **What:** one KPI card with a label, an `est` badge, the value, a gauge or sparkline, and a subtitle.
- **Risks:** `opts.label`, `value` and `sub` are interpolated without `esc`. All callers pass constants or formatted numbers today.

### `barChart(rows)`: render.ts:83
- **What:** horizontal SVG bars of tokens saved per tool. Labels longer than 20 characters are truncated from the left.
- **How:** fixed geometry (row 34 px, label 130 px, bar 320 px), with widths scaled to the maximum and labels escaped.

### `areaChart(byDay)`: render.ts:103
- **What:** a 640×200 SVG area chart of cumulative tokens by day, with three gridlines, dots, and first/last (or all ≤5) date labels.
- **How:** linear x by index, linear y against the maximum. A single point is centred.
- **Risks:** `p.day` (from `e.ts.slice(0,10)`, store.ts:150) goes into `<title>` and text without `esc` (render.ts:121, :124). The source is local JSONL, so this is low risk, but it is the only unescaped data-derived string. `byDay.indexOf(p)` inside map is O(n²), which is negligible at day granularity.

### `topFiles(rows)`: render.ts:130
- **What:** the top 7 files by tokens saved, ranked, with escaped paths and proportional track bars.
- **Depends on:** `summary.byFile`, which is already capped at 15 (store.ts:176).

### `renderDashboard(summary, generatedAt = new Date()): string`: render.ts:148
- **What:** the full dashboard markup (`<div class="viz-root">` plus `<style>` plus `<main>` plus `<script>`).
- **How:** calls `computeMetrics`, sorts tool rows by `TOOL_ORDER`, and builds up to 20 session rows (session ids truncated to 12 characters and escaped, :161). It embeds `SAIRA_FONT_FACE` (:167), sets CSS custom properties for light, dark, `[data-theme]` overrides and the layered "WOZCODE-glow" background (:168-197, commit fb186fa), and adds a theme-toggle IIFE that persists to `localStorage` (:319-333).
- **Why:** to show users what MOZCODE saved. The design is a port of WOZCODE's look (Saira font, ambient glow).
- **Depends on / used by:** `computeMetrics`, `fmtUsd`, `fmtDuration`, `SAIRA_FONT_FACE`. Used by `generateDashboard` (generate.ts:25), scripts/preview-dashboard.ts:32 and test/dashboard.test.ts:30-65.
- **Risks:**
  - **Stale disclosure:** the assumptions list says "Token estimate: ~4 chars/token" (render.ts:314). Token counts actually come from `gpt-tokenizer` BPE (src/util/tokens.ts:7), with chars/4 only as a fallback (tokens.ts:22-23). The "auditable" footnote is wrong.
  - The `generatedAt` parameter is never used, so the page carries no generation timestamp.
  - `localStorage` calls (:323, :330) are not wrapped in try/catch. On `file://` with storage blocked, the toggle script throws and the button does nothing.
  - The single 190-line template literal with long one-line CSS rules is hard to review and diff (maintainability).

---

## src/dashboard/generate.ts

**Purpose:** the I/O shell around `renderDashboard`. It loads data, wraps it in a document, writes the file and opens it.

### `wrap(body)`: generate.ts:7
- **What:** a minimal `<!doctype html>` document with a title and a page background for light and dark.

### `generateDashboard(): Promise<{path, totalSaved, calls}>`: generate.ts:23
- **What:** reads **all** metering entries, summarises them, renders, `mkdir -p ~/.mozcode`, writes `dashboard.html`, and returns the path and totals.
- **How:** `loadEntries` → `summarize` → `renderDashboard` → `fs.writeFile`.
- **Depends on / used by:** `moz_dashboard` (server.ts:291) and scripts/gen-dashboard.ts:2.
- **Risks:** there is no direct test of the write path. The write is not atomic, which is acceptable for a single local writer.

### `openInBrowser(target)`: generate.ts:33
- **What:** best-effort `open` / `xdg-open` / `start` on the generated file, detached.
- **How:** `child_process.spawn(cmd, [target], {detached, stdio:"ignore", shell: win32})`.
- **Risks:** (a) On Windows the call runs through a shell as `start <path>` with the path unquoted. A home path with spaces (`C:\Users\Jane Doe\...`) breaks, and `start` treats a first quoted argument as a window title. Shell metacharacters in `MOZCODE_HOME` (store.ts:20) would also be interpreted by the shell. (b) Spawn errors arrive asynchronously through the `'error'` event, which is not handled. The try/catch only catches synchronous throws, so a missing `xdg-open` (headless Linux) emits an unhandled `error` event on the child, which can crash the MCP server process. (c) The caller still prints "Opening in your browser." even when `open:false` (server.ts:293, outside this area). There are no tests.

---

## src/dashboard/saira-font.ts

**Purpose:** embeds the Saira variable woff2 (latin subset, weights 400–800, OFL-1.1) as base64 so the dashboard renders in brand offline (saira-font.ts:1-4).

### `SAIRA_FONT_FACE` (const): saira-font.ts:7
- **What:** a `@font-face` rule with a `data:font/woff2;base64` URL.
- **Risks:** about 44 KB of source (`wc -c`) that ships inside `dist/server.js` and is inlined into every dashboard write. It is acceptable, but it is the largest single item in this area.

---

## src/statusline.ts

**Purpose:** the Claude Code status-line command. It reads Claude's JSON on stdin and prints `⚡ MOZCODE est. session: $… · N tokens · T · K roundtrips │ all-time: …` in 24-bit blue. Claude Code runs it again on every status update, as a fresh `node` process.

### `readStdin(): Promise<string>`: statusline.ts:13
- **What:** collects stdin into a string. It resolves immediately on a TTY, on `end` or `error`, or after a 500 ms safety timeout.
- **How:** the timer is `unref`'d and cleared on settle (:23-29), so the process exits as soon as output is written. This fixes a stale-status-line bug (commit e2f8a9a; test/statusline.test.ts:95).
- **Risks:** `done` can run twice (timeout, then end), but resolving a Promise twice is a no-op. Benign.

### `BLUE`/`RESET`/`blue(s)`: statusline.ts:39-41
- Truecolor ANSI wrapper. It ignores `NO_COLOR` (minor).

### `compact(n)`: statusline.ts:44
- Compact counts (`12.3k`, `4.1M`). This duplicates render.ts `fmt` (:5) with different rounding: 999.6 prints "1000" here.

### `segment(entries)`: statusline.ts:50
- **What:** the formatted `cost · tokens · time · roundtrips` for a set of entries.
- **How:** `computeMetrics(summarize(entries), entries)`, then `fmtUsd`, `compact` and `fmtDuration`.
- **Risks:** it inherits the inflated count of failed `code_edit` calls from computeMetrics, and the `fmtDuration` "60s" edge case.

### `main()`: statusline.ts:57
- **What:** resolves `cwd` from stdin JSON (`cwd` or `workspace.current_dir`, falling back to the process cwd). It loads **every** metering entry for all projects and filters to `e.project === cwd`. It picks the session from the pointer file (`readCurrentSession`, store.ts:81), or else the project's most recent entry, then writes one line.
- **Why:** to give an ambient "this session vs. all-time" savings readout, mirroring WOZCODE's status line (inferred from commit 4fa3973).
- **Depends on / used by:** `loadEntries`, `summarize`, `readCurrentSession`, `computeMetrics`. Installed by hooks/statusline-install.mjs:38 and tested end to end against `dist/statusline.js` (test/statusline.test.ts:28).
- **Risks:**
  - **Scale / latency hot path:** every status refresh re-reads and JSON-parses the *entire* metering history across all projects (store.ts:91-111), then summarises it twice (session and all-time). Cost grows linearly with lifetime usage and runs on every prompt update. There is no cache, rollup or tail-read. This is the main responsiveness risk compared with WOZCODE's "instant" status line.
  - The project match is exact string equality (`e.project === cwd`, :71). If Claude's cwd is a subdirectory of, or a symlink or differently normalised path to, the project the server resolved, the session segment silently shows $0.00.
  - `main().catch` prints a zero line (:82-85), which hides real errors with no debug channel (by design, but it hides regressions).

---

## Test coverage summary
- `renderDashboard` and `computeMetrics`: test/dashboard.test.ts (labels, font, disclaimer, gauge/spark, empty dataset, metric math).
- Status line: test/statusline.test.ts spawns the **built** `dist/statusline.js`, so it depends on the bundle being fresh.
- Untested: `generateDashboard`, `openInBrowser`, `fmtDuration`, `fmtUsd`, `compact`, and the unknown-tool or subdirectory-cwd paths.

## Hot spots (ranked)
1. **[quality, medium]** `openInBrowser` (generate.ts:33-40) has no `'error'` listener on the spawned child. A missing `xdg-open` emits an unhandled error that can crash the MCP server. Windows `start` with an unquoted path through `shell:true` breaks on spaces.
2. **[scale, medium]** `statusline.ts:66` re-reads and parses the full all-project JSONL history on every status refresh: O(lifetime entries) per prompt update, with no cache or rollup.
3. **[quality, medium]** `computeMetrics` (metrics.ts:51-58) counts failed or degraded `code_edit` calls as avoided round-trips, which inflates calls, cost and time saved.
4. **[quality, low]** The stale "~4 chars/token" assumption in the dashboard footnote (render.ts:314); the real counts come from gpt-tokenizer (util/tokens.ts).
5. **[quality, low]** The status-line project match is exact (statusline.ts:71). A subdirectory or symlinked cwd shows a $0 session.
6. **[quality, low]** `fmtDuration` rounding prints `1m 60s` / `1h 60m` (metrics.ts:83-86).
7. **[quality, low]** Every sparkline uses the token series even on the cost, time and calls tiles (render.ts:279-283). `generatedAt` is unused (render.ts:148).
8. **[security, low]** `p.day` is interpolated unescaped into SVG (render.ts:121, :124). `localStorage` is used without try/catch (render.ts:323, :330).
9. **[quality, low]** Latent `--series-0` invisible bar for any tool missing from `TOOL_ORDER` (render.ts:156). `fmt` and `compact` are duplicated formatters.
