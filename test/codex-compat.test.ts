import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Codex compatibility: plugin launch descriptor", () => {
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const server = mcp.mcpServers.mozcode;

  it("contains no host-specific variable that Codex would pass literally", () => {
    expect(JSON.stringify(mcp)).not.toMatch(/\$\{/);
  });

  it("uses the plugin-relative launch form Codex can resolve", () => {
    expect(server.cwd).toBe(".");
    expect(server.args).toContain("./dist/server.js");
    expect(existsSync(join(root, "dist", "server.js"))).toBe(true);
  });

  it("ships the absolute-path installer needed to preserve workspace cwd", () => {
    expect(existsSync(join(root, "scripts", "install-codex.mjs"))).toBe(true);
    const installer = readFileSync(join(root, "scripts", "install-codex.mjs"), "utf8");
    expect(installer).toContain("MOZCODE_TRUST_CWD=1");
  });
});

describe("Codex compatibility: plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));

  it("declares component paths relative to the plugin root", () => {
    for (const field of ["skills", "mcpServers"] as const) {
      expect(manifest[field], field).toMatch(/^\.\//);
    }
    expect(manifest.mcpServers).toBe("./.mcp.json");
  });
});

describe("project resolution guard", () => {
  const callTool = (
    cwd: string,
    name: string,
    args: Record<string, unknown>,
    env?: NodeJS.ProcessEnv,
  ) =>
    new Promise<{ text: string; isError: boolean }>((resolvePromise, reject) => {
      const child = spawn("node", ["--no-warnings", join(root, "dist", "server.js")], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MOZCODE_PROJECT: "", ...env },
      });
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      let buffer = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timed out waiting for tool result"));
      }, 20_000);

      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;

          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name, arguments: args },
            });
          } else if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolvePromise({
              text: message.result?.content?.[0]?.text ?? "",
              isError: Boolean(message.result?.isError),
            });
          }
        }
      });

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-compat-test", version: "1" },
        },
      });
    });

  it("refuses relative project work when launched in the plugin directory", async () => {
    const result = await callTool(root, "code_search", { query: "anything" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/could not determine which project/i);
    expect(result.text).toMatch(/install-codex\.mjs/);
  }, 30_000);

  it("keeps moz_status available so the launch problem is discoverable", async () => {
    const result = await callTool(root, "moz_status", {});
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/UNRESOLVED/);
  }, 30_000);

  it("uses the host cwd when launched from a real workspace", async () => {
    const result = await callTool(join(root, "src"), "code_search", {
      query: "resolveProject",
    });
    expect(result.isError).toBe(false);
    expect(result.text).not.toMatch(/could not determine which project/i);
  }, 30_000);

  it("honors MOZCODE_PROJECT as an explicit override", async () => {
    const result = await callTool(
      root,
      "code_search",
      { query: "resolveProject" },
      { MOZCODE_PROJECT: root },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/server\.ts/);
  }, 30_000);

  it("trusts cwd when the absolute-path Codex registration identifies itself", async () => {
    const result = await callTool(
      root,
      "code_search",
      { query: "resolveProject" },
      { MOZCODE_TRUST_CWD: "1" },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/server\.ts/);
  }, 30_000);
});
