// Copy the grammar .wasm files and the web-tree-sitter runtime wasm into grammars/
// so the published package is self-contained.
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const outDir = join(process.cwd(), "grammars");
mkdirSync(outDir, { recursive: true });

const wasmSrc = dirname(require.resolve("tree-sitter-wasms/package.json"));
const grammars = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
];
for (const g of grammars) {
  copyFileSync(join(wasmSrc, "out", g), join(outDir, g));
}
console.log(`Copied ${grammars.length} grammars to grammars/`);
