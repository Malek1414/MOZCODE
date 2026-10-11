// Prove the bundles are self-contained: run them from a temp dir with NO
// node_modules and drive the server over stdio. The CLIENT uses the project's
// SDK; the SERVER and the status line must not.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_TOOLS = [
  "code_edit",
  "code_outline",
  "code_read",
  "code_search",
  "db_schema",
  "moz_dashboard",
  "moz_savings",
  "moz_status",
];

const tmp = await fs.mkdtemp(join(tmpdir(), "moz-bundle-"));
const home = await fs.mkdtemp(join(tmpdir(), "moz-home-"));
let client;
let ok = false;
try {
  await fs.mkdir(join(tmp, "dist"));
  await fs.mkdir(join(tmp, "grammars"));
  await fs.mkdir(join(tmp, "proj"));
  await fs.copyFile(join(root, "dist/server.js"), join(tmp, "dist/server.js"));
  await fs.copyFile(join(root, "dist/statusline.js"), join(tmp, "dist/statusline.js"));
  for (const f of await fs.readdir(join(root, "grammars"))) {
    if (f.endsWith(".wasm")) await fs.copyFile(join(root, "grammars", f), join(tmp, "grammars", f));
  }
  await fs.copyFile(join(root, "test/fixtures/sample.ts"), join(tmp, "proj/sample.ts"));

  // Sanity: the temp tree must have no node_modules anywhere we control.
  const hasNM = await fs.stat(join(tmp, "node_modules")).then(() => true, () => false);
  if (hasNM) throw new Error("unexpected node_modules in temp dir");

  const env = { ...process.env, MOZCODE_HOME: home, NODE_PATH: "" };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(tmp, "dist/server.js")],
    cwd: join(tmp, "proj"),
    env,
  });
  client = new Client({ name: "verify", version: "1.0.0" });
  await client.connect(transport);

  const text = (r) => r.content.map((c) => c.text).join("\n");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const outline = text(await client.callTool({ name: "code_outline", arguments: { path: "sample.ts" } }));
  const read = text(await client.callTool({ name: "code_read", arguments: { path: "sample.ts", symbol: "add" } }));

  const status = spawnSync(process.execPath, ["--no-warnings", join(tmp, "dist/statusline.js")], {
    cwd: join(tmp, "proj"),
    env,
    input: JSON.stringify({ cwd: join(tmp, "proj") }),
    encoding: "utf8",
    timeout: 10_000,
  });

  const toolsOk = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS);
  const outlineOk = outline.includes("class Account");
  const readOk = read.includes("function add") && !read.includes("class Account");
  const statusOk = status.status === 0 && status.stdout.includes("MOZCODE");
  ok = toolsOk && outlineOk && readOk && statusOk;

  console.log("tools:", names.join(", "), toolsOk ? "" : `(expected ${EXPECTED_TOOLS.join(", ")})`);
  console.log("outline ok:", outlineOk);
  console.log("read-by-symbol ok:", readOk);
  console.log("statusline ok:", statusOk);
} finally {
  await client?.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}

console.log(ok ? "\n✅ BUNDLES SELF-CONTAINED — ran with no node_modules" : "\n❌ FAILED");
process.exit(ok ? 0 : 1);
