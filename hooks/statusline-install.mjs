// Self-installing statusline.
//
// Claude Code's `statusLine` is a SETTINGS field, not a plugin-manifest field —
// a plugin cannot declare one. So MOZCODE registers its own status line into the
// user's ~/.claude/settings.json on session start, which is the only mechanism
// available to a plugin.
//
// Rules, in order of importance:
//   1. Never clobber somebody else's status line. If a foreign one is present we
//      leave it completely alone and stay silent.
//   2. Keep our own entry pointing at the *current* plugin root. Plugins install
//      into a versioned cache directory, so an upgrade changes the absolute path
//      and a stale entry would silently run the old build (or nothing).
//   3. Never throw, and never write a settings file we could not parse — a hook
//      must not be able to corrupt a user's global config.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Marker identifying a status line as ours, independent of the absolute path. */
const MARKER = "mozcode";

/**
 * Re-run the status line every N seconds on top of Claude Code's event-driven
 * updates. Savings accrue mid-turn as tools run, so without this the line only
 * moves when an event happens to fire and reads as frozen between turns.
 */
const REFRESH_INTERVAL_SEC = 5;

export function defaultSettingsPath(home = os.homedir()) {
  return path.join(home, ".claude", "settings.json");
}

/** The status line command for a given plugin root. */
export function statusLineCommand(pluginRoot) {
  // Absolute, not ${CLAUDE_PLUGIN_ROOT}: that placeholder is only expanded in
  // plugin manifests and hooks, never in the user's settings.json.
  return `node --no-warnings "${path.join(pluginRoot, "dist", "statusline.js")}"`;
}

function isOurs(statusLine) {
  return (
    typeof statusLine?.command === "string" &&
    statusLine.command.includes(MARKER) &&
    statusLine.command.includes("statusline.js")
  );
}

/**
 * Decide what should happen, given the current settings object. Pure — all the
 * decision logic lives here so it can be tested without touching a real config.
 *
 * @returns {{action: "optout"|"foreign"|"install"|"update"|"current", settings?: object}}
 */
export function planStatusLine(settings, pluginRoot, env = {}) {
  if (env.MOZCODE_NO_STATUSLINE) return { action: "optout" };

  const existing = settings?.statusLine;
  if (existing && !isOurs(existing)) return { action: "foreign" };

  const command = statusLineCommand(pluginRoot);
  if (existing && existing.command === command) {
    if (existing.refreshInterval === REFRESH_INTERVAL_SEC) return { action: "current" };
  }

  const next = {
    ...settings,
    statusLine: {
      ...(existing && isOurs(existing) ? existing : {}),
      type: "command",
      command,
      refreshInterval: REFRESH_INTERVAL_SEC,
    },
  };
  return { action: existing ? "update" : "install", settings: next };
}

/**
 * Apply the plan to the user's settings file. Best-effort and non-throwing:
 * a status line is a convenience, and failing to install one must never break
 * session start.
 *
 * @returns {Promise<"optout"|"foreign"|"install"|"update"|"current"|"error">}
 */
export async function installStatusLine(settingsPath, pluginRoot, env = {}) {
  try {
    if (!pluginRoot) return "error";

    let settings = {};
    let raw;
    try {
      raw = await fs.readFile(settingsPath, "utf8");
    } catch {
      raw = undefined; // No settings file yet — we'll create one.
    }
    if (raw !== undefined) {
      try {
        settings = JSON.parse(raw);
      } catch {
        // Unparseable settings: refuse to touch it rather than risk clobbering
        // a file the user is mid-edit on.
        return "error";
      }
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        return "error";
      }
    }

    const plan = planStatusLine(settings, pluginRoot, env);
    if (!plan.settings) return plan.action;

    // Only install unprompted if the status line script is actually present.
    try {
      await fs.access(path.join(pluginRoot, "dist", "statusline.js"));
    } catch {
      return "error";
    }

    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    // Write via temp file + rename so a crash mid-write cannot truncate the
    // user's settings.
    const tmp = `${settingsPath}.mozcode-${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(plan.settings, null, 2) + "\n", "utf8");
    await fs.rename(tmp, settingsPath);
    return plan.action;
  } catch {
    return "error";
  }
}
