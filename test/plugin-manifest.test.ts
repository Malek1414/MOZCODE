import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ClaudePluginManifest {
  commands?: unknown;
  agents?: unknown;
  hooks?: unknown;
}

describe("Claude Code plugin manifest", () => {
  it("leaves hooks, commands, and agents to folder auto-discovery", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
    ) as ClaudePluginManifest;

    expect(manifest).not.toHaveProperty("commands");
    expect(manifest).not.toHaveProperty("agents");
    expect(manifest).not.toHaveProperty("hooks");
  });
});
