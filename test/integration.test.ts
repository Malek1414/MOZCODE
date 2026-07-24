import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "server.js");

describe("MCP server integration (stdio)", () => {
  let project: string;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    project = await fs.mkdtemp(join(tmpdir(), "terse-proj-"));
    home = await fs.mkdtemp(join(tmpdir(), "terse-home-"));
    await fs.copyFile(join(here, "fixtures", "sample.ts"), join(project, "sample.ts"));

    const transport = new StdioClientTransport({
      command: "node",
      args: ["--no-warnings", serverPath],
      cwd: project,
      env: { ...process.env, TERSE_HOME: home } as Record<string, string>,
    });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it("lists all seven tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["code_edit", "code_outline", "code_read", "code_search", "terse_dashboard", "terse_savings", "terse_status"].sort(),
    );
  });

  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

  it("code_outline returns a symbol skeleton", async () => {
    const r = await client.callTool({ name: "code_outline", arguments: { path: "sample.ts" } });
    expect(text(r)).toContain("class Account");
    expect(text(r)).toContain("function add");
  });

  it("code_read extracts a single symbol", async () => {
    const r = await client.callTool({ name: "code_read", arguments: { path: "sample.ts", symbol: "add" } });
    expect(text(r)).toContain("function add");
    expect(text(r)).not.toContain("class Account");
  });

  it("code_search groups by enclosing symbol", async () => {
    const r = await client.callTool({ name: "code_search", arguments: { query: "balance" } });
    expect(text(r)).toContain("Account");
  });

  it("code_edit rewrites a symbol and persists to disk", async () => {
    const r = await client.callTool({
      name: "code_edit",
      arguments: { path: "sample.ts", symbol: "add", new_source: "function add(a: number, b: number): number {\n  return a + b + 1;\n}" },
    });
    expect(text(r)).toContain("No re-read needed");
    const onDisk = await fs.readFile(join(project, "sample.ts"), "utf8");
    expect(onDisk).toContain("return a + b + 1;");
  });

  it("terse_savings reports accumulated savings", async () => {
    const r = await client.callTool({ name: "terse_savings", arguments: {} });
    expect(text(r)).toContain("saved");
  });

  it("terse_dashboard writes the HTML file", async () => {
    const r = await client.callTool({ name: "terse_dashboard", arguments: { open: false } });
    expect(text(r)).toContain("Dashboard written");
    const html = await fs.readFile(join(home, "dashboard.html"), "utf8");
    expect(html).toContain("Terse — savings dashboard");
  });
});
