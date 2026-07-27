#!/usr/bin/env node
// SessionStart hook: inject the working directory, steer the model toward
// MOZCODE's symbol-level tools over the built-in whole-file Read/Grep, and
// register MOZCODE's savings status line in the user's settings (a plugin
// cannot declare `statusLine` in its manifest — see statusline-install.mjs).
import { readFileSync } from "node:fs";
import { installStatusLine, defaultSettingsPath } from "./statusline-install.mjs";

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
let cwd = process.cwd();
try {
  const parsed = JSON.parse(input || "{}");
  if (parsed.cwd) cwd = parsed.cwd;
} catch {
  /* ignore */
}

// Install/refresh the status line. Best-effort: never blocks or breaks startup.
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || new URL("..", import.meta.url).pathname;
let statusLineAction = "error";
try {
  statusLineAction = await installStatusLine(defaultSettingsPath(), pluginRoot, process.env);
} catch {
  /* a status line is a convenience; startup must not depend on it */
}

const lines = [
  `MOZCODE is active in ${cwd}.`,
  `For SOURCE CODE files, prefer MOZCODE's tools to save tokens:`,
  `• code_outline / code_read (with a symbol) instead of the built-in Read — they return one symbol, not the whole file.`,
  `• code_search instead of Grep — it groups hits by enclosing function/class.`,
  `• code_edit to replace a whole function/class without re-reading the file.`,
  `• db_schema before database work — it maps SQLite/PostgreSQL structure in one metadata-only call.`,
  `Use the built-in Read/Edit only for non-code files or tiny in-line tweaks.`,
];

// Tell the user once, in the session where it happens, that we touched their
// global settings — silently editing a user's config would not be acceptable.
if (statusLineAction === "install") {
  lines.push(
    `MOZCODE installed its savings status line into ~/.claude/settings.json. Run /statusline or edit that file to change it; set MOZCODE_NO_STATUSLINE=1 to opt out.`,
  );
} else if (statusLineAction === "foreign") {
  lines.push(
    `A status line from another tool is already configured, so MOZCODE left it untouched. To use MOZCODE's instead, point settings.json "statusLine".command at \${CLAUDE_PLUGIN_ROOT}/dist/statusline.js.`,
  );
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  }),
);
