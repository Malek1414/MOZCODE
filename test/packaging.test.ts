import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planStatusLine,
  installStatusLine,
  statusLineCommand,
} from "../hooks/statusline-install.mjs";
import { GRAMMAR_FILE, SUPPORTED_LANGUAGES } from "../src/ast/languages.js";
import { VERSION } from "../src/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * What a user actually receives on install. These files are committed on
 * purpose (see .gitignore) so the plugin runs with no build step and no
 * node_modules — if any goes missing, MOZCODE degrades to whole-file reads or
 * crashes on first parse, on the user's machine rather than in CI.
 */
describe("shipped assets", () => {
  it("ships a grammar for every supported language", async () => {
    for (const id of SUPPORTED_LANGUAGES) {
      const wasm = join(root, "grammars", GRAMMAR_FILE[id]);
      await expect(fs.access(wasm), `missing grammar for ${id}: ${wasm}`).resolves.toBeUndefined();
    }
  });

  it("ships the web-tree-sitter runtime wasm alongside the grammars", async () => {
    await expect(fs.access(join(root, "grammars", "tree-sitter.wasm"))).resolves.toBeUndefined();
  });

  it("ships both the server and the statusline bundles", async () => {
    await expect(fs.access(join(root, "dist", "server.js"))).resolves.toBeUndefined();
    await expect(fs.access(join(root, "dist", "statusline.js"))).resolves.toBeUndefined();
  });

  it("includes dist and grammars in the npm package payload", async () => {
    const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("grammars");
    expect(pkg.files).toContain("hooks");
  });
});

/**
 * Claude Code copies a plugin into a versioned cache directory and re-copies it
 * only when the manifest version changes. Shipping changed content under an
 * unchanged version means every installed user silently keeps the old build —
 * so the version is a release mechanism, not just a label, and the four places
 * that carry it must never drift apart.
 */
describe("version consistency", () => {
  const read = async (p: string) => JSON.parse(await fs.readFile(join(root, p), "utf8"));

  it("agrees across package.json, both plugin manifests, and src/version.ts", async () => {
    const [pkg, claudePlugin, codexPlugin] = await Promise.all([
      read("package.json"),
      read(".claude-plugin/plugin.json"),
      read(".codex-plugin/plugin.json"),
    ]);
    expect(pkg.version).toBe(VERSION);
    expect(claudePlugin.version).toBe(VERSION);
    expect(codexPlugin.version).toBe(VERSION);
  });

  it("carries the current version into the built bundle", async () => {
    // esbuild keeps `MOZCODE v${VERSION}` as a template and emits the constant
    // separately, so assert on the emitted constant rather than the rendered
    // string — this catches a stale dist/ that was never rebuilt after a bump.
    const bundle = await fs.readFile(join(root, "dist", "server.js"), "utf8");
    expect(bundle).toContain(`VERSION = "${VERSION}"`);
  });
});

describe("statusline self-install", () => {
  const pluginRoot = "/plugins/mozcode/1.2.3";
  const ourCommand = statusLineCommand(pluginRoot);

  it("installs into settings that have no status line", () => {
    const plan = planStatusLine({ model: "opus" }, pluginRoot);
    expect(plan.action).toBe("install");
    expect(plan.settings!.statusLine).toEqual({
      type: "command",
      command: ourCommand,
      refreshInterval: 5,
    });
    // Must preserve everything else in the user's settings.
    expect(plan.settings!.model).toBe("opus");
  });

  it("never clobbers a status line belonging to another tool", () => {
    const foreign = { type: "command", command: "node /somewhere/other-tool.js" };
    const plan = planStatusLine({ statusLine: foreign }, pluginRoot);
    expect(plan.action).toBe("foreign");
    expect(plan.settings).toBeUndefined();
  });

  it("repoints its own entry after a plugin version upgrade", () => {
    const stale = { type: "command", command: statusLineCommand("/plugins/mozcode/1.0.0") };
    const plan = planStatusLine({ statusLine: stale }, pluginRoot);
    expect(plan.action).toBe("update");
    expect(plan.settings!.statusLine.command).toBe(ourCommand);
  });

  it("is a no-op when already current, so sessions do not rewrite settings", () => {
    const current = { type: "command", command: ourCommand, refreshInterval: 5 };
    expect(planStatusLine({ statusLine: current }, pluginRoot).action).toBe("current");
  });

  it("respects the MOZCODE_NO_STATUSLINE opt-out", () => {
    const plan = planStatusLine({}, pluginRoot, { MOZCODE_NO_STATUSLINE: "1" });
    expect(plan.action).toBe("optout");
    expect(plan.settings).toBeUndefined();
  });

  it("sets a refreshInterval so the line updates between events", () => {
    const plan = planStatusLine({}, pluginRoot);
    expect(plan.settings!.statusLine.refreshInterval).toBeGreaterThanOrEqual(1);
  });
});

describe("statusline self-install (filesystem)", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mozcode-settings-"));
    settingsPath = join(dir, ".claude", "settings.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates settings.json when the user has none", async () => {
    const action = await installStatusLine(settingsPath, root);
    expect(action).toBe("install");
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(written.statusLine.command).toBe(statusLineCommand(root));
  });

  it("preserves unrelated settings when installing", async () => {
    await fs.mkdir(dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ model: "opus", env: { A: "1" } }), "utf8");

    await installStatusLine(settingsPath, root);
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.env).toEqual({ A: "1" });
    expect(written.statusLine).toBeDefined();
  });

  it("refuses to touch a settings file it cannot parse", async () => {
    await fs.mkdir(dirname(settingsPath), { recursive: true });
    const broken = '{ "model": "opus", ';
    await fs.writeFile(settingsPath, broken, "utf8");

    const action = await installStatusLine(settingsPath, root);
    expect(action).toBe("error");
    // The user's file must be byte-for-byte untouched.
    expect(await fs.readFile(settingsPath, "utf8")).toBe(broken);
  });

  it("does not install when the statusline bundle is missing", async () => {
    const action = await installStatusLine(settingsPath, join(dir, "not-a-plugin"));
    expect(action).toBe("error");
    await expect(fs.access(settingsPath)).rejects.toThrow();
  });

  it("leaves no temp files behind", async () => {
    await installStatusLine(settingsPath, root);
    const leftover = (await fs.readdir(dirname(settingsPath))).filter((f) => f.includes("tmp"));
    expect(leftover).toEqual([]);
  });
});
