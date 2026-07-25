// Build a self-contained plugin: bundle the server into one JS file with all
// npm deps inlined, and ship the wasm assets (grammars + web-tree-sitter runtime)
// next to it — so the plugin runs with NO node_modules and NO build step on the
// user's machine.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();

// 1) Bundle the server + statusline (ESM, node) into single files.
rmSync(join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [
    join(root, "src/server.ts"),
    join(root, "src/statusline.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outdir: join(root, "dist"),
  sourcemap: false,
  logLevel: "info",
  banner: {
    // createRequire shim so any bundled CJS interop has a working require in ESM.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

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
