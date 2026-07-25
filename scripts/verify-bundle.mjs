// Prove the bundle is self-contained: run it from a temp dir with NO node_modules
// and drive it over stdio. The CLIENT uses the project's SDK; the SERVER must not.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const tmp = await fs.mkdtemp(join(tmpdir(), "moz-bundle-"));
const home = await fs.mkdtemp(join(tmpdir(), "moz-home-"));

await fs.mkdir(join(tmp, "dist"));
await fs.mkdir(join(tmp, "grammars"));
await fs.mkdir(join(tmp, "proj"));
await fs.copyFile(join(root, "dist/server.js"), join(tmp, "dist/server.js"));
for (const f of await fs.readdir(join(root, "grammars"))) {
  if (f.endsWith(".wasm")) await fs.copyFile(join(root, "grammars", f), join(tmp, "grammars", f));
}
await fs.copyFile(join(root, "test/fixtures/sample.ts"), join(tmp, "proj/sample.ts"));

// Sanity: the temp tree must have no node_modules anywhere we control.
const hasNM = await fs.stat(join(tmp, "node_modules")).then(() => true, () => false);
if (hasNM) throw new Error("unexpected node_modules in temp dir");

const transport = new StdioClientTransport({
  command: "node",
  args: [join(tmp, "dist/server.js")],
  cwd: join(tmp, "proj"),
  env: { ...process.env, MOZCODE_HOME: home, NODE_PATH: "" },
});
const client = new Client({ name: "verify", version: "1.0.0" });
await client.connect(transport);

const text = (r) => r.content.map((c) => c.text).join("\n");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const outline = text(await client.callTool({ name: "code_outline", arguments: { path: "sample.ts" } }));
const read = text(await client.callTool({ name: "code_read", arguments: { path: "sample.ts", symbol: "add" } }));
await client.close();
await fs.rm(tmp, { recursive: true, force: true });
await fs.rm(home, { recursive: true, force: true });

const ok =
  names.length === 7 &&
  outline.includes("class Account") &&
  read.includes("function add") &&
  !read.includes("class Account");

console.log("tools:", names.join(", "));
console.log("outline ok:", outline.includes("class Account"));
console.log("read-by-symbol ok:", read.includes("function add") && !read.includes("class Account"));
console.log(ok ? "\n✅ BUNDLE SELF-CONTAINED — ran with no node_modules" : "\n❌ FAILED");
process.exit(ok ? 0 : 1);
