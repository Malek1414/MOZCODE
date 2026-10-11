import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
  // Spawned servers write session pointers and metering entries; keep them out
  // of the developer's real ~/.mozcode dashboard and statusline.
  const home = mkdtempSync(join(tmpdir(), "mozcode-codex-compat-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

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
        env: { ...process.env, MOZCODE_HOME: home, MOZCODE_PROJECT: "", ...env },
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
  it("flags a code_edit that did not write the file as an error", async () => {
    const result = await callTool(
      root,
      "code_edit",
      { path: "test/fixtures/sample.ts", symbol: "noSuchSymbol", new_source: "function noSuchSymbol() {}" },
      { MOZCODE_PROJECT: root },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found/);
  }, 30_000);

  describe("code_edit stays inside the project", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mozcode-contain-"));
    const project = join(sandbox, "proj");
    const outsideFile = join(sandbox, "outside.ts");
    const original = "export function target() {\n  return 1;\n}\n";
    const edit = { symbol: "target", new_source: "export function target() {\n  return 2;\n}" };
    mkdirSync(project);
    // A sibling whose name starts with the project's must not count as inside.
    mkdirSync(join(sandbox, "proj-other"));
    afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

    const reset = () => {
      writeFileSync(outsideFile, original);
      writeFileSync(join(sandbox, "proj-other", "x.ts"), original);
      writeFileSync(join(project, "inside.ts"), original);
    };

    it("refuses ../, absolute, sibling-prefix and symlinked paths that leave the project", async () => {
      reset();
      symlinkSync(sandbox, join(project, "escape"));
      for (const p of ["../outside.ts", outsideFile, join(sandbox, "proj-other", "x.ts"), "escape/outside.ts"]) {
        const result = await callTool(project, "code_edit", { path: p, ...edit }, { MOZCODE_PROJECT: project });
        expect(result.isError, p).toBe(true);
        expect(result.text, p).toMatch(/outside the project/);
      }
      expect(readFileSync(outsideFile, "utf8")).toBe(original);
      expect(readFileSync(join(sandbox, "proj-other", "x.ts"), "utf8")).toBe(original);
    }, 60_000);

    it("still edits files inside the project", async () => {
      reset();
      const result = await callTool(project, "code_edit", { path: "inside.ts", ...edit }, { MOZCODE_PROJECT: project });
      expect(result.isError).toBe(false);
      expect(readFileSync(join(project, "inside.ts"), "utf8")).toContain("return 2;");
    }, 30_000);

    it("refuses absolute-path edits while the project is UNRESOLVED", async () => {
      reset();
      const result = await callTool(root, "code_edit", { path: outsideFile, ...edit });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/UNRESOLVED/);
      expect(readFileSync(outsideFile, "utf8")).toBe(original);
    }, 30_000);

    it("allows outside edits only with the explicit opt-out", async () => {
      reset();
      const result = await callTool(
        project,
        "code_edit",
        { path: outsideFile, ...edit },
        { MOZCODE_PROJECT: project, MOZCODE_ALLOW_EDIT_OUTSIDE_PROJECT: "1" },
      );
      expect(result.isError).toBe(false);
      expect(readFileSync(outsideFile, "utf8")).toContain("return 2;");
    }, 30_000);
  });
});
