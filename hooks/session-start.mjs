#!/usr/bin/env node
// SessionStart hook: inject the working directory and steer the model toward
// MOZCODE's symbol-level tools over the built-in whole-file Read/Grep.
import { readFileSync } from "node:fs";

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

const context = [
  `MOZCODE is active in ${cwd}.`,
  `For SOURCE CODE files, prefer MOZCODE's tools to save tokens:`,
  `• code_outline / code_read (with a symbol) instead of the built-in Read — they return one symbol, not the whole file.`,
  `• code_search instead of Grep — it groups hits by enclosing function/class.`,
  `• code_edit to replace a whole function/class without re-reading the file.`,
  `• db_schema before database work — it maps SQLite/PostgreSQL structure in one metadata-only call.`,
  `Use the built-in Read/Edit only for non-code files or tiny in-line tweaks.`,
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
