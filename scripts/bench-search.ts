/**
 * heartgold benchmark for code_search: runs a fixed query set over a frozen
 * corpus, cold (file cache cleared) and warm, and prints
 *   HASH <sha256 of every result text>
 *   <elapsed seconds>
 * bench.py compares the hash with the original code's output.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { clearFileCache } from "../src/ast/file-cache.js";
import { codeSearch } from "../src/tools/search.js";

const corpus = process.argv[2];
if (!corpus) throw new Error("usage: bench-search.ts <corpus dir>");

const QUERIES: [string, string?][] = [
  ["function"],
  ["export async function \\w+"],
  ["interface \\w+Options"],
  ["querySelector"],
  ["Promise<void>"],
  ["readonly \\w+: number;"],
  ["throw new \\w*Error"],
  ["TODO|FIXME|XXX"],
  ["zzz_never_matches_anything"],
  ["\\bawait\\b", "src/**/*.ts"],
  ["import .* from", "vendor/mcp-sdk/**/*.js"],
  ["class \\w+ extends", "vendor/**"],
  ["(?i)websocket"],
  ["onmessage"],
  ["\\.prototype\\."],
  ["new Map<"],
];

const hash = createHash("sha256");
const start = performance.now();
for (let round = 0; round < 3; round++) {
  clearFileCache();
  for (const pass of ["cold", "warm"]) {
    for (const [q, glob] of QUERIES) {
      const r = await codeSearch(corpus, q, glob);
      if (round === 0) hash.update(`${pass}\u0000${q}\u0000${glob ?? ""}\u0000${r.text}\u0000`);
    }
  }
}
const seconds = (performance.now() - start) / 1000;
console.log(`HASH ${hash.digest("hex")}`);
console.log(seconds.toFixed(4));
