import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("hooks.json", () => {
  it("re-injects the SessionStart nudge after /clear and compaction", () => {
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    const matcher: string = hooks.hooks.SessionStart[0].matcher;
    const sources = matcher.split("|");
    for (const source of ["startup", "resume", "clear", "compact"]) expect(sources).toContain(source);
  });
});

describe("Codex SessionStart hook", () => {
  it("is declared separately so Codex does not run the Claude Code hook", () => {
    const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest.hooks).toBe("./.codex-plugin/hooks.json");
    const hooks = JSON.parse(readFileSync(join(root, ".codex-plugin", "hooks.json"), "utf8"));
    const entry = hooks.hooks.SessionStart[0];
    for (const source of ["startup", "resume", "clear", "compact"]) expect(entry.matcher.split("|")).toContain(source);
    expect(entry.hooks[0].command).toContain("hooks/session-start.mjs");
    expect(entry.hooks[0].command).toContain("--host=codex");
  });

  it("never writes ~/.claude/settings.json and names Codex's tools", () => {
    const home = mkdtempSync(join(tmpdir(), "mozcode-codex-hook-"));
    try {
      const run = (args: string[]) =>
        spawnSync(process.execPath, ["--no-warnings", join(root, "hooks", "session-start.mjs"), ...args], {
          input: JSON.stringify({ cwd: "/work/project", source: "startup" }),
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: root, MOZCODE_NO_STATUSLINE: "" },
          encoding: "utf8",
        });
      const codex = run(["--host=codex"]);
      expect(codex.status).toBe(0);
      const ctx: string = JSON.parse(codex.stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain("/work/project");
      expect(ctx).toContain("apply_patch");
      expect(ctx).not.toContain("built-in Read");
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);

      // The Claude Code path still installs the status line.
      const claude = run([]);
      expect(claude.status).toBe(0);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("session-start plugin root fallback", () => {
  it("resolves its own directory when CLAUDE_PLUGIN_ROOT is unset, even with spaces in the path", () => {
    const base = mkdtempSync(join(tmpdir(), "mozcode hook "));
    try {
      const plugin = join(base, "plugin root");
      mkdirSync(join(plugin, "hooks"), { recursive: true });
      mkdirSync(join(plugin, "dist"), { recursive: true });
      for (const f of ["session-start.mjs", "statusline-install.mjs"]) {
        copyFileSync(join(root, "hooks", f), join(plugin, "hooks", f));
      }
      writeFileSync(join(plugin, "dist", "statusline.js"), "");
      const home = join(base, "home");
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.MOZCODE_NO_STATUSLINE;
      const r = spawnSync(process.execPath, ["--no-warnings", join(plugin, "hooks", "session-start.mjs")], {
        input: "{}",
        env,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.statusLine.command).toContain(join(plugin, "dist", "statusline.js"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
