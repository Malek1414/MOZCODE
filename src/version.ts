/**
 * Single source of truth for MOZCODE's version.
 *
 * This string must stay in lockstep with package.json, .claude-plugin/plugin.json
 * and .codex-plugin/plugin.json — test/packaging.test.ts enforces that. It matters
 * more than it looks: Claude Code decides whether to re-copy a plugin into its
 * versioned cache by comparing this version, so shipping changed content under an
 * unchanged version means installed users silently keep running the old build.
 */
export const VERSION = "0.3.0";
