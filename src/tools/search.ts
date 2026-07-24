import * as path from "node:path";
import { languageForPath } from "../ast/languages.js";
import { extractSymbols, type Symbol } from "../ast/engine.js";
import { listSourceFiles, matchesGlob, readFileSafe } from "../util/files.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";

const MAX_MATCHES = 200;

interface RawMatch {
  file: string;
  line: number;
  text: string;
  offset: number; // char offset of the line start
}

function buildRegex(query: string): RegExp {
  try {
    return new RegExp(query, "g");
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  }
}

/** Innermost symbol whose span contains the offset. */
function enclosing(symbols: Symbol[], offset: number): Symbol | null {
  let best: Symbol | null = null;
  for (const s of symbols) {
    if (offset >= s.startIndex && offset <= s.endIndex) {
      if (!best || s.endIndex - s.startIndex < best.endIndex - best.startIndex) best = s;
    }
  }
  return best;
}

export async function codeSearch(
  root: string,
  query: string,
  pathGlob?: string,
): Promise<ToolResult> {
  const rx = buildRegex(query);
  const files = await listSourceFiles(root);
  const matches: RawMatch[] = [];

  for (const file of files) {
    if (pathGlob && !matchesGlob(file, pathGlob)) continue;
    let source: string;
    try {
      source = await readFileSafe(file);
    } catch {
      continue;
    }
    let offset = 0;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      rx.lastIndex = 0;
      if (rx.test(lines[i])) {
        matches.push({ file, line: i + 1, text: lines[i].trim(), offset });
        if (matches.length >= MAX_MATCHES) break;
      }
      offset += lines[i].length + 1; // + newline
    }
    if (matches.length >= MAX_MATCHES) break;
  }

  // Baseline: what a plain grep would dump — every matching line.
  const baselineText = matches
    .map((m) => `${path.relative(root, m.file)}:${m.line}: ${m.text}`)
    .join("\n");
  const baseline = estimateTokens(baselineText) || 1;

  if (matches.length === 0) {
    const text = `No matches for /${query}/${pathGlob ? ` in ${pathGlob}` : ""}.`;
    return { text, degraded: false, meta: makeMeta("code_search", undefined, baseline, estimateTokens(text)) };
  }

  // Group matches by file; resolve enclosing symbols for supported files.
  const byFile = new Map<string, RawMatch[]>();
  for (const m of matches) {
    const arr = byFile.get(m.file) ?? [];
    arr.push(m);
    byFile.set(m.file, arr);
  }

  const blocks: string[] = [];
  for (const [file, fileMatches] of byFile) {
    const rel = path.relative(root, file);
    const lang = languageForPath(file);
    if (!lang) {
      // Unsupported: fall back to raw line matches.
      const lines = fileMatches.map((m) => `  L${m.line}: ${m.text}`);
      blocks.push(`${rel}:\n${lines.join("\n")}`);
      continue;
    }
    const source = await readFileSafe(file);
    const { symbols } = await extractSymbols(source, lang);
    const seen = new Map<string, { sym: Symbol; count: number; lines: number[] }>();
    const looseLines: RawMatch[] = [];
    for (const m of fileMatches) {
      const sym = enclosing(symbols, m.offset);
      if (!sym) {
        looseLines.push(m);
        continue;
      }
      const key = sym.qualifiedName;
      const entry = seen.get(key) ?? { sym, count: 0, lines: [] };
      entry.count += 1;
      entry.lines.push(m.line);
      seen.set(key, entry);
    }
    const parts: string[] = [];
    for (const { sym, count, lines } of seen.values()) {
      parts.push(`  ${sym.signature}   ⟨${sym.kind} L${sym.startLine}-${sym.endLine}, ${count} hit${count > 1 ? "s" : ""} @ ${lines.join(",")}⟩`);
    }
    for (const m of looseLines) parts.push(`  L${m.line}: ${m.text}  ⟨top-level⟩`);
    blocks.push(`${rel}:\n${parts.join("\n")}`);
  }

  const header = `${matches.length} match${matches.length > 1 ? "es" : ""} for /${query}/, grouped by enclosing symbol:`;
  const text = `${header}\n\n${blocks.join("\n\n")}`;
  return {
    text,
    degraded: false,
    meta: makeMeta("code_search", undefined, baseline, estimateTokens(text)),
  };
}
