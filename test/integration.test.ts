import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "server.js");

describe("MCP server integration (stdio)", () => {
  let project: string;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    project = await fs.mkdtemp(join(tmpdir(), "mozcode-proj-"));
    home = await fs.mkdtemp(join(tmpdir(), "mozcode-home-"));
    await fs.copyFile(join(here, "fixtures", "sample.ts"), join(project, "sample.ts"));
    const db = new DatabaseSync(join(project, "app.sqlite"));
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
    db.close();

    const transport = new StdioClientTransport({
      command: "node",
      args: ["--no-warnings", serverPath],
      cwd: project,
      env: { ...process.env, MOZCODE_HOME: home } as Record<string, string>,
    });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it("lists all eight tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["code_edit", "code_outline", "code_read", "code_search", "db_schema", "moz_dashboard", "moz_savings", "moz_status"].sort(),
    );
  });

  it("advertises approval-safe annotations for Codex and other MCP clients", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ["code_read", "code_outline", "code_search", "moz_savings", "moz_status"]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    expect(byName.get("code_edit")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get("db_schema")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
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

  it("db_schema maps a live SQLite database", async () => {
    const r = await client.callTool({ name: "db_schema", arguments: { path: "app.sqlite" } });
    expect(text(r)).toContain("sqlite schema: 1 tables");
    expect(text(r)).toContain("users(id INTEGER PK");
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

  it("moz_savings reports accumulated savings", async () => {
    const r = await client.callTool({ name: "moz_savings", arguments: {} });
    expect(text(r)).toContain("saved");
  });

  it("moz_dashboard writes the HTML file", async () => {
    const r = await client.callTool({ name: "moz_dashboard", arguments: { open: false } });
    expect(text(r)).toContain("Dashboard written");
    const html = await fs.readFile(join(home, "dashboard.html"), "utf8");
    expect(html).toContain("MOZCODE — savings dashboard");
  });
});
