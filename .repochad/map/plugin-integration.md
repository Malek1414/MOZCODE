# Area: Plugin packaging, hooks & host integration

This area connects the MOZCODE MCP server (`dist/server.js`, built from `src/server.ts`) to its two hosts, Claude Code and Codex. It contains:
- the manifests that tell each host how to launch the server,
- one SessionStart hook that steers the model toward the `code_*` tools and installs the savings status line on its own,
- a Codex installer script,
- prompt files (agents, slash commands and a skill).

This area contains no tool logic. Its job is to make the host start the server in the right directory, and then to make the model actually choose the token-saving tools. That routing is MOZCODE's version of WOZCODE's "nudge + Haiku-routed explorer" technique (inferred from README/commit `0218444 Add Haiku-routed agents + marketplace manifest`).

Files: 14 (6 JSON/config, 3 executable `.mjs`, 5 Markdown prompt files). Meaningful functions/handlers: 9.

---

## .claude-plugin/plugin.json
**Purpose:** The Claude Code plugin manifest. It declares one MCP server, `mozcode`, launched as `node --no-warnings ${CLAUDE_PLUGIN_ROOT}/dist/server.js` — `.claude-plugin/plugin.json:8-14`.
- **What:** Claude Code expands `${CLAUDE_PLUGIN_ROOT}` and spawns the bundle. The cwd is the user's workspace, which is what lets `src/server.ts:38-47` (`resolveProject`) treat cwd as the project.
- **How:** The manifest leaves out `hooks`, `commands` and `agents` on purpose, so Claude Code finds them by folder auto-discovery. `test/plugin-manifest.test.ts:11-19` enforces this (commit `dee4039 Fix Claude plugin auto-discovery manifest`).
- **Why:** This is the one-click install path (commit `e6c6d2f`). `version` "0.3.0" (`:3`) must match package.json, `.codex-plugin/plugin.json` and `src/version.ts`, and `test/packaging.test.ts:58` checks that.
- **Risks:** `"alwaysLoad": true` (`:12`) is a non-standard key. I could not confirm that Claude Code honours it, so it may be silently ignored.

## .claude-plugin/marketplace.json
**Purpose:** A single-plugin marketplace descriptor, so that `/plugin marketplace add Malek1414/MOZCODE` works — `.claude-plugin/marketplace.json:1-12`.
- **What/How:** It lists the plugin `mozcode` with `source: "./"` (`:8`), meaning the repo root is the plugin.
- **Risks:** It has no `version` field, so marketplace consumers rely on plugin.json alone. The description at `:9` advertises "Haiku-routed agents", but only the subagent's model is pinned (`model: haiku`); the decision to delegate to it exists only as prompt text in `agents/*.md`. Nothing enforces delegation.

## .codex-plugin/plugin.json
**Purpose:** The Codex plugin manifest. It points Codex at `./skills/` and `./.mcp.json`, and supplies UI metadata — `.codex-plugin/plugin.json:20-40`.
- **What:** `mcpServers: "./.mcp.json"` (`:21`) reuses the plain launch descriptor. `defaultPrompt` (`:34-38`) gives Codex starter prompts.
- **Why:** Commit `d38f437 Add Codex plugin`. Codex cannot expand `${CLAUDE_PLUGIN_ROOT}` (`scripts/install-codex.mjs:5-9`), so it needs a separate relative-path descriptor. `test/codex-compat.test.ts:30-38` checks that component paths are relative.
- **Risks:** None in the file itself. The real limitation is in `.mcp.json` (below).

## .mcp.json
**Purpose:** The host-neutral MCP launch descriptor that Codex uses (and Claude Code also uses, when someone opens this repo as a project): `node --no-warnings ./dist/server.js` with `cwd: "."` — `.mcp.json:3-8`.
- **What:** It starts the server relative to the plugin root.
- **How/Why:** Codex resolves `cwd "."` to the installed plugin root, not to the user's workspace (`scripts/install-codex.mjs:5-9`). The server detects that launch mode (`src/server.ts:44-46`, cwd === PLUGIN_ROOT) and refuses every tool except `moz_status` (`src/server.ts:232`), returning `UNRESOLVED_MESSAGE` (`src/server.ts:51-57`), which tells the user to run the installer. `test/codex-compat.test.ts:13-27,101-140` covers this.
- **Risks:** Out of the box, a Codex plugin install is non-functional until the user runs `scripts/install-codex.mjs`. That is a deliberate fail-closed choice, but it is still a first-run usability cliff.

## hooks/hooks.json
**Purpose:** Registers one `SessionStart` command hook, `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"`, with matcher `startup|resume` — `hooks/hooks.json:3-13`.
- **Why:** It injects the tool-preference nudge and keeps the status line installed (see below).
- **Risks (efficiency):** The matcher leaves out the `clear` and `compact` SessionStart sources. After `/clear`, or after an auto-compaction, the steering context is gone, and the model drifts back to the built-in Read/Grep for the rest of the session. That loses the main lever MOZCODE has for saving tokens. Adding `clear|compact` costs only one more short hook run.

## hooks/session-start.mjs
**Purpose:** The SessionStart hook script. It reads the hook payload, installs or refreshes the status line, and prints `hookSpecificOutput.additionalContext` telling the model to prefer MOZCODE's tools — `hooks/session-start.mjs:1-61`.

### top-level script (module body) — `hooks/session-start.mjs:9-61`
- **What:** stdin JSON `{cwd,...}` → stdout JSON `{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext}}`. Side effect: it may rewrite `~/.claude/settings.json` through `installStatusLine`.
- **How:**
  - reads fd 0 synchronously (`:11`), with cwd falling back to `process.cwd()` (`:15-21`);
  - takes pluginRoot from `CLAUDE_PLUGIN_ROOT`, or else `new URL("..", import.meta.url).pathname` (`:24`);
  - awaits `installStatusLine` inside try/catch (`:26-30`);
  - builds 7 fixed nudge lines (`:32-40`);
  - adds a one-time disclosure when it installed the status line, or when a foreign status line was found (`:44-52`).
- **Why:** WOZCODE-style steering. The model only saves tokens if it picks `code_outline`/`code_read`/`code_search`/`code_edit`/`db_schema` over Read/Grep (comment `:2-5`). The disclosure exists because "silently editing a user's config would not be acceptable" (`:42-43`).
- **Depends on:** `statusline-install.mjs` (`installStatusLine`, `defaultSettingsPath`). **Used by:** `hooks/hooks.json:9`.
- **Risks:**
  - `new URL(...).pathname` (`:24`) gives a percent-encoded path (spaces become `%20`) and `/C:/...` on Windows. `fileURLToPath` is the correct call. It only matters when `CLAUDE_PLUGIN_ROOT` is unset.
  - `readFileSync(0)` (`:11`) blocks forever if someone runs the script by hand from a TTY.
  - The action `"update"` (repointing after a plugin upgrade) is not disclosed. That is consistent with "tell once", but it is still a silent global-config write.
  - The script writes the user's global settings on every startup/resume, although it is a no-op when the entry is already current (`planStatusLine` → `"current"`).
  - No test runs the hook end to end. Only `statusline-install.mjs` is tested.

## hooks/statusline-install.mjs
**Purpose:** Installs MOZCODE's status line into `~/.claude/settings.json`. A plugin cannot declare `statusLine` in its manifest (`:3-6`), so this file does it safely: it never clobbers another tool's line, it repoints after a version upgrade, and it never throws (`:8-15`).

### `defaultSettingsPath(home = os.homedir())` — `hooks/statusline-install.mjs:30-32`
- **What/How:** Returns `<home>/.claude/settings.json`. **Used by:** `session-start.mjs:27`.

### `statusLineCommand(pluginRoot)` — `hooks/statusline-install.mjs:35-39`
- **What:** Returns the string `node --no-warnings "<pluginRoot>/dist/statusline.js"`.
- **Why:** The path must be absolute, because `${CLAUDE_PLUGIN_ROOT}` is not expanded inside settings.json (`:36-37`).
- **Risks:** pluginRoot is interpolated into a shell command line with no escaping. A root containing `"`, `$` or a backtick would break the command or inject into it. The source is the host-supplied env, so this is low risk.

### `isOurs(statusLine)` — `hooks/statusline-install.mjs:41-47`
- **What:** True if `command` contains both `"mozcode"` and `"statusline.js"`.
- **Why:** It identifies MOZCODE's own entry across versioned cache paths (`MARKER`, `:21`).
- **Risks:** This is a substring heuristic. A user's own script at e.g. `~/mozcode-tools/statusline.js`, or any path with "mozcode" in it, counts as "ours" and gets overwritten on the next session. That breaks rule 1 at `:9-10`.

### `planStatusLine(settings, pluginRoot, env = {})` — `hooks/statusline-install.mjs:55-76`
- **What:** A pure decision function returning `optout | foreign | install | update | current`, plus the new settings object when a write is needed.
- **How:**
  - `MOZCODE_NO_STATUSLINE` opts out (`:56`);
  - a foreign entry is left alone (`:59`);
  - the result is `current` when the command and `refreshInterval` (5 s, `:28`) already match (`:62-64`);
  - otherwise it spreads the existing settings and our previous entry, then sets type/command/refreshInterval (`:66-75`).
- **Why:** Keeping the logic pure makes it testable without touching a real config (`:50-51`). The 5 s refresh exists because savings grow mid-turn while tools run (`:24-27`).
- **Used by:** `installStatusLine`. Tested in `test/packaging.test.ts:104-149`.
- **Risks:** Any truthy value of `MOZCODE_NO_STATUSLINE` opts out, including `"0"` and `"false"`. That is surprising, but harmless.

### `installStatusLine(settingsPath, pluginRoot, env = {})` — `hooks/statusline-install.mjs:85-129`
- **What:** It reads settings.json and refuses (`"error"`) when the file is unparseable or not an object (`:96-107`). It plans the change, then checks that `dist/statusline.js` exists (`:113-117`). It writes through a temp file plus `rename` (`:119-124`), and never throws (`:126-128`).
- **Why:** A hook must not be able to corrupt the user's global config (`:14-15`). Tested in `test/packaging.test.ts:151-205`.
- **Risks:**
  - **Symlinked settings:** `rename` over `~/.claude/settings.json` replaces a symlink (common for dotfile-managed configs) with a regular file. It also drops the original file mode, because the new file takes the umask default.
  - **Lost update:** The read-modify-write has no lock. If Claude Code, or a second session starting at the same time, writes settings.json between the read (`:92`) and the rename (`:124`), that write is lost.
  - **Temp-file leak:** If `writeFile` succeeds and `rename` fails, `${settingsPath}.mozcode-<pid>.tmp` is left behind, because the catch block (`:126`) does no cleanup.

## scripts/install-codex.mjs
**Purpose:** Registers MOZCODE as a user-level Codex MCP server by its absolute bundle path, with `MOZCODE_TRUST_CWD=1`, so that Codex starts it in the user's workspace — `scripts/install-codex.mjs:1-76`.

### top-level script — `scripts/install-codex.mjs:22-76`
- **What:** It checks `dist/server.js` and exits 1 if it is missing (`:25-31`), checks that the `codex` CLI exists (`:35-40`), then runs `codex mcp remove mozcode` (`:42-46`) and `codex mcp add mozcode --env MOZCODE_TRUST_CWD=1 -- node --no-warnings <abs>` (`:48-69`). Finally it prints next steps.
- **How:** It uses `execFileSync` with no shell (`:33`), so there is no shell-injection risk from the path.
- **Why:** This works around Codex's literal treatment of `${CLAUDE_PLUGIN_ROOT}` and its plugin-root cwd (`:5-13`, commit `b827622`). `MOZCODE_TRUST_CWD` tells `src/server.ts:43-46` not to flag the cwd as unresolved. Exposed as `npm run install:codex` (package.json) and shipped in `files`. `test/codex-compat.test.ts:23` checks that it ships.
- **Risks:**
  - **Non-atomic re-register:** it removes before it adds. If `add` fails (`:60-68`), the user is left with no `mozcode` registration at all.
  - **Windows:** `execFileSync("codex", ...)` without `shell: true` cannot run an npm `.cmd` shim, so on a working Windows install it reports "codex CLI is not on PATH" (`:38`) (inferred).
  - `MOZCODE_TRUST_CWD=1` also disables the guard if Codex is ever launched inside the plugin directory.

## agents/moz-code.md
**Purpose:** Defines the main coding subagent. It lists all 8 MOZCODE tools plus the built-ins, with rules: read and search by symbol, edit by AST span, run `db_schema` once, and delegate scans to `moz-explore` — `agents/moz-code.md:1-29`.
- **Why:** Prompt-level token discipline, ported from WOZCODE's main-agent idea (inferred from commit `0218444`).
- **Risks:**
  - It sets no `model:`, so it inherits the session model.
  - The tool names (`mcp__mozcode__moz_status`, `moz_dashboard`) match `src/server.ts:197,208`. They will break silently if the server or plugin name changes; no test cross-checks agent tool lists against `TOOLS`.

## agents/moz-explore.md
**Purpose:** A read-only exploration subagent pinned to `model: haiku` (`:4`), with a restricted tool list (no Write, Edit or Bash, `:5`) — `agents/moz-explore.md:1-26`.
- **Why:** WOZCODE-style cost routing. Broad scans run on the cheaper model and return a `path:line` summary (`:22-26`).
- **Risks:** Read-only is enforced by the tool list (good). Delegation itself is only a suggestion inside `moz-code.md`; no hook routes Explore-type work here.

## commands/moz-dashboard.md, commands/moz-savings.md, commands/moz-status.md
**Purpose:** Slash commands that each tell the model to call one MCP tool and relay its output:
- `moz_dashboard` (`commands/moz-dashboard.md:5-7`),
- `moz_savings`, with a reminder that the numbers are estimates (`commands/moz-savings.md:5-7`),
- `moz_status` (`commands/moz-status.md:5`).
- **Risks:**
  - `moz-dashboard.md:5` hard-codes `~/.mozcode/dashboard.html`, but the real location honours `MOZCODE_HOME` (`src/metering/store.ts:19-21`). This is a documentation drift only.
  - Related, outside this area: the `moz_dashboard` reply always says "Opening in your browser", even with `open:false` (`src/server.ts:290-293`).

## skills/mozcode/SKILL.md
**Purpose:** The Codex/Claude skill (loaded through `.codex-plugin/plugin.json:20`). It describes the outline → search → read → edit workflow, the `db_schema` credential rule (pass the env-var name, never the URL), and the savings/status/dashboard tools — `skills/mozcode/SKILL.md:1-45`.
- **Why:** Codex has no SessionStart hook equivalent here, so the skill is the main way the nudge reaches Codex (inferred).
- **Risks:** Prompt-only, with no automated check that the tool names in it exist.

---

## Hot spots (ranked)
1. **The nudge is lost after `/clear` or compaction.** The `hooks/hooks.json:5` matcher is `startup|resume`. After a compaction the model stops preferring the `code_*` tools, which costs tokens in exactly the long sessions where savings matter most. (quality/efficiency, medium)
2. **The status-line installer replaces symlinked or permissioned settings.json.** `rename` at `hooks/statusline-install.mjs:122-124` turns a symlink into a regular file and resets the file mode. (quality, medium)
3. **The `isOurs` substring heuristic can overwrite a user's own status line** when its path contains "mozcode" and "statusline.js" (`hooks/statusline-install.mjs:41-47`). (quality, low)
4. **Unlocked read-modify-write of global settings** on every session start, so a concurrent write is lost; a temp file leaks if rename fails (`hooks/statusline-install.mjs:92-124`). (quality, low)
5. **Non-atomic Codex re-registration** (remove, then add) can leave no registration; on Windows, `execFileSync` without a shell cannot find a `codex.cmd` shim (`scripts/install-codex.mjs:33-69`). (quality, low)
6. **The `.mcp.json` Codex launch fails closed** until the installer runs (`.mcp.json:5-6` + `src/server.ts:232`). This is a first-run usability cliff. (quality, low)
7. **Unescaped pluginRoot in the shell command** written to settings.json (`hooks/statusline-install.mjs:38`). The source is trusted host env. (security, low)
8. **The session-start pluginRoot fallback uses `URL.pathname`**, so it breaks on paths with spaces and on Windows (`hooks/session-start.mjs:24`). (quality, low)
