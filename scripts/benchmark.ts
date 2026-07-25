/**
 * Real-data benchmark: run MOZCODE's tools over a real hand-written TypeScript
 * corpus (zod's source + this repo) and measure actual token reduction, so we can
 * compare the MEASURED mechanism against WOZCODE's published claims.
 *
 * Records real metering to MOZCODE_HOME so the dashboard reflects real numbers.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeOutline } from "../src/tools/outline.js";
import { codeRead } from "../src/tools/read.js";
import { codeSearch } from "../src/tools/search.js";
import { extractSymbols, type Symbol } from "../src/ast/engine.js";
import { languageForPath } from "../src/ast/languages.js";
import { estimateTokens } from "../src/util/tokens.js";
import { record } from "../src/metering/store.js";

const SESSION = "benchmark";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|py)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function largestTopLevel(symbols: Symbol[]): Symbol | null {
  const top = symbols.filter((s) => s.depth === 0);
  if (top.length === 0) return null;
  return top.reduce((a, b) => (b.endIndex - b.startIndex > a.endIndex - a.startIndex ? b : a));
}

async function main() {
  const root = process.cwd();
  const corpora = [
    { name: "zod", dir: join(root, "node_modules/zod/src") },
    { name: "mozcode/src", dir: join(root, "src") },
    { name: "mozcode/test", dir: join(root, "test") },
  ];

  const files = corpora.flatMap((c) => walk(c.dir).map((f) => ({ ...c, file: f })));
  console.log(`Corpus: ${files.length} real source files\n`);

  let fileTokTotal = 0;
  let outlineTokTotal = 0;
  let navMozTotal = 0; // outline + read one symbol per file
  const outlineRed: number[] = [];
  const symbolRed: number[] = [];
  let symFiles = 0;
  let outlineWins = 0;

  for (const { file } of files) {
    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    if (!src.trim()) continue;
    const lang = languageForPath(file);
    const fileTok = estimateTokens(src);
    fileTokTotal += fileTok;

    const o = await codeOutline(file, file);
    outlineTokTotal += o.meta.actualTokens;
    outlineRed.push(1 - o.meta.actualTokens / fileTok);
    if (o.meta.actualTokens < fileTok) outlineWins++;
    await record("bench:corpus", SESSION, o.meta);

    // Navigation model: outline the file, then read its main symbol.
    let navMoz = o.meta.actualTokens;
    if (lang) {
      const { symbols } = await extractSymbols(src, lang);
      const target = largestTopLevel(symbols);
      if (target) {
        const r = await codeRead(file, file, { symbol: target.qualifiedName });
        symbolRed.push(1 - r.meta.actualTokens / fileTok);
        symFiles++;
        navMoz += r.meta.actualTokens;
        await record("bench:corpus", SESSION, r.meta);
      }
    }
    // If a file must be read whole, MOZCODE can't beat it — cap the model there.
    navMozTotal += Math.min(navMoz, fileTok);
  }

  // Search: real queries across the corpus.
  const queries = ["parse", "ZodError", "function", "refine", "async"];
  let searchBaseline = 0, searchActual = 0;
  for (const q of queries) {
    const r = await codeSearch(join(root, "node_modules/zod/src"), q);
    searchBaseline += r.meta.baselineTokens;
    searchActual += r.meta.actualTokens;
    await record("bench:corpus", SESSION, r.meta);
  }

  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  console.log("── MEASURED on real code ──────────────────────────────");
  console.log(`Files                         ${files.length}`);
  console.log(`Total file tokens (naive Read)${fileTokTotal.toLocaleString().padStart(12)}`);
  console.log();
  console.log(`Outline vs whole file:`);
  console.log(`  token-weighted reduction    ${pct(1 - outlineTokTotal / fileTokTotal)}`);
  console.log(`  per-file mean / median      ${pct(outlineRed.reduce((a, b) => a + b, 0) / outlineRed.length)} / ${pct(median(outlineRed))}`);
  console.log(`  files where outline < file  ${pct(outlineWins / files.length)}`);
  console.log();
  console.log(`Read ONE main symbol vs whole file (${symFiles} files w/ symbols):`);
  console.log(`  per-file mean / median      ${pct(symbolRed.reduce((a, b) => a + b, 0) / symbolRed.length)} / ${pct(median(symbolRed))}`);
  console.log();
  console.log(`Navigation session (outline + read 1 symbol per file) vs reading each file whole:`);
  console.log(`  token-weighted reduction    ${pct(1 - navMozTotal / fileTokTotal)}`);
  console.log(`  tokens: ${navMozTotal.toLocaleString()} vs ${fileTokTotal.toLocaleString()}`);
  console.log();
  console.log(`Search (grouped-by-symbol vs raw grep lines), ${queries.length} queries:`);
  console.log(`  token-weighted reduction    ${pct(1 - searchActual / searchBaseline)}`);
  console.log(`  tokens: ${searchActual.toLocaleString()} vs ${searchBaseline.toLocaleString()}`);
}

main();
