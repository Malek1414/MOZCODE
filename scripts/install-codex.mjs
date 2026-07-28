#!/usr/bin/env node
/**
 * Register MOZCODE with Codex using an absolute server path.
 *
 * Codex does not expand ${CLAUDE_PLUGIN_ROOT} in plugin MCP arguments. A
 * plugin-relative path plus cwd "." starts successfully, but Codex resolves
 * that cwd to the installed plugin root rather than the user's workspace.
 * MOZCODE derives its project from cwd, so that launch mode cannot safely
 * service relative project paths.
 *
 * A user-level MCP registration with an absolute bundle path and no forced cwd
 * solves both problems: Node can find the bundle, and Codex starts it in the
 * workspace from which the session was launched.
 *
 * Safe to re-run; it replaces only the user-level MCP server named "mozcode".
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(pluginRoot, "dist", "server.js");

if (!existsSync(serverPath)) {
  console.error(
    `Could not find ${serverPath}.\n` +
      `Run \`npm run build\` in ${pluginRoot} first, or reinstall the plugin.`,
  );
  process.exit(1);
}

const run = (args) => execFileSync("codex", args, { encoding: "utf8", stdio: "pipe" });

try {
  run(["--version"]);
} catch {
  console.error("The `codex` CLI is not on PATH. Install Codex, then rerun this script.");
  process.exit(1);
}

try {
  run(["mcp", "remove", "mozcode"]);
} catch {
  // A missing user-level entry is expected on first install.
}

try {
  run([
    "mcp",
    "add",
    "mozcode",
    "--env",
    "MOZCODE_TRUST_CWD=1",
    "--",
    "node",
    "--no-warnings",
    serverPath,
  ]);
} catch (error) {
  const detail =
    typeof error === "object" && error && "stderr" in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`Failed to register MOZCODE with Codex:\n${detail}`);
  process.exit(1);
}

console.log(
  `MOZCODE registered with Codex.\n` +
    `  server: ${serverPath}\n\n` +
    `Future Codex sessions will launch it in their workspace. Restart any Codex\n` +
    `session that was already open, then verify with: codex mcp list`,
);
