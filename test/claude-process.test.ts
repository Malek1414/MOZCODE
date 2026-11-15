import { describe, it, expect } from "vitest";
import { claudeAncestor, type ProcessInfo } from "../src/util/claude-process.js";

/** A fake process table: pid -> [ppid, command]. */
function table(rows: Record<number, [number, string]>) {
  return async (pid: number): Promise<ProcessInfo | undefined> => {
    const r = rows[pid];
    return r ? { ppid: r[0], command: r[1] } : undefined;
  };
}

describe("claudeAncestor", () => {
  it("finds Claude through an intermediate shell", async () => {
    const ps = table({
      300: [200, "/bin/sh -c /Users/me/.cache/statusline-tee.sh"],
      200: [100, "claude bg-spare --bg-spare /tmp/x.sock"],
      100: [1, "/sbin/launchd"],
    });
    expect(await claudeAncestor(300, ps)).toBe(200);
  });

  it("recognises the common ways Claude Code is launched", async () => {
    for (const command of [
      "claude",
      "claude --resume",
      "/Users/me/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --bg-spare /tmp/a",
      "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    ]) {
      expect(await claudeAncestor(50, table({ 50: [1, command] }))).toBe(50);
    }
  });

  it("does not mistake look-alike commands for Claude", async () => {
    const ps = table({
      50: [40, "node /Users/me/claude-mem/worker.js"],
      40: [30, "python claudette.py"],
      30: [1, "/sbin/launchd"],
    });
    expect(await claudeAncestor(50, ps)).toBeUndefined();
  });

  it("gives up when the process table cannot be read", async () => {
    expect(await claudeAncestor(50, async () => undefined)).toBeUndefined();
  });

  it("stops after maxDepth hops", async () => {
    const ps = table({ 5: [4, "a"], 4: [3, "b"], 3: [2, "claude"], 2: [1, "x"] });
    expect(await claudeAncestor(5, ps, 2)).toBeUndefined();
    expect(await claudeAncestor(5, ps, 3)).toBe(3);
  });
});
