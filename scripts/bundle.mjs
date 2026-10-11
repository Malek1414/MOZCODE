// Build a self-contained plugin: bundle the server into one JS file with all
// npm deps inlined, and ship the wasm assets (grammars + web-tree-sitter runtime)
// next to it — so the plugin runs with NO node_modules and NO build step on the
// user's machine.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Resolve from this script, not process.cwd(), so running it from another
// directory can't bundle into (or delete) some other dist/.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1) Bundle the server + statusline (ESM, node) into single files. Build into a
// staging dir and swap it in only on success: dist/ is committed and is what
// the plugin runs, so a failed build must not leave the plugin without it.
const staging = join(root, "dist.staging");
rmSync(staging, { recursive: true, force: true });
await build({
  entryPoints: [
    join(root, "src/server.ts"),
    join(root, "src/statusline.ts"),
  ],
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outdir: staging,
  sourcemap: false,
  logLevel: "info",
  banner: {
    // createRequire shim so any bundled CJS interop has a working require in ESM.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
}).catch((err) => {
  rmSync(staging, { recursive: true, force: true });
  throw err;
});
rmSync(join(root, "dist"), { recursive: true, force: true });
renameSync(staging, join(root, "dist"));

// 2) Ship the wasm assets alongside the bundle, in grammars/.
const outDir = join(root, "grammars");
mkdirSync(outDir, { recursive: true });

const wasmSrc = dirname(require.resolve("tree-sitter-wasms/package.json"));
const grammars = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
];
for (const g of grammars) copyFileSync(join(wasmSrc, "out", g), join(outDir, g));

// web-tree-sitter runtime wasm (needed by Parser.init).
const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
copyFileSync(runtime, join(outDir, "tree-sitter.wasm"));

console.log(`Bundled dist/server.js + ${grammars.length + 1} wasm assets in grammars/`);
