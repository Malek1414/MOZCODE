import * as path from "node:path";
import { RE2JS } from "re2js";
import { languageForPath } from "../ast/languages.js";
import { type Symbol } from "../ast/engine.js";
import { analyzeFile, readCachedSource } from "../ast/file-cache.js";
import { listSourceFiles, matchesGlob } from "../util/files.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";

const MAX_MATCHES = 200;
/** Files read concurrently by code_search. */
const READ_BATCH = 32;

interface RawMatch {
  file: string;
  line: number;
  text: string;
  offset: number; // char offset of the first match on the line
}

interface CompiledQuery {
  rx: RE2JS;
  /** Set when the query was searched as a literal string instead of a regex. */
  note?: string;
}

/**
 * Compile the model-supplied query with RE2 (linear-time matching), not V8's
 * backtracking RegExp: a pattern such as `(a+)+$` would otherwise freeze the
 * single-threaded stdio server for seconds or minutes per line. RE2 has no
 * lookaround or backreferences, so those queries (like invalid ones) are
 * searched as a literal string, and the result says so.
 */
export function compileQuery(query: string): CompiledQuery {
  try {
    return { rx: RE2JS.compile(query) };
  } catch {
    let validJs = false;
    try {
      new RegExp(query);
      validJs = true;
    } catch {
      // Not a regex in either dialect: a literal search is the intent.
    }
    return {
      rx: RE2JS.compile(RE2JS.quote(query)),
      note: validJs
        ? "Lookaround, backreferences and \\u escapes are not supported (linear-time regex engine), so the query was searched as a literal string."
        : undefined,
    };
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
  const { rx, note } = compileQuery(query);
  const files = (await listSourceFiles(root)).filter(
    (file) => !pathGlob || matchesGlob(path.isAbsolute(pathGlob) ? file : path.relative(root, file), pathGlob),
  );
  const matches: RawMatch[] = [];

  // Read files in parallel batches but scan them in walk order, so results and
  // the MAX_MATCHES cut-off stay deterministic. One stat+read at a time made a
  // cold search scale with per-file I/O latency times the file count.
  let batch: Promise<string | null>[] = [];
  const readBatch = (from: number) => {
    batch = files.slice(from, from + READ_BATCH).map((f) => readCachedSource(f).catch(() => null));
  };
  readBatch(0);
  for (let idx = 0; idx < files.length; idx++) {
    const slot = idx % READ_BATCH;
    if (slot === 0 && idx > 0) readBatch(idx);
    const file = files[idx];
    const source = await batch[slot];
    if (source === null) continue;
    let offset = 0;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = rx.matcher(lines[i]);
      if (m.find()) {
        matches.push({ file, line: i + 1, text: lines[i].trim(), offset: offset + m.start() });
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
    const text = `No matches for /${query}/${pathGlob ? ` in ${pathGlob}` : ""}.${note ? ` ${note}` : ""}`;
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
    const { symbols } = await analyzeFile(file);
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
      const locations = lines.map((line) => `L${line}`).join(",");
      parts.push(
        `  ${sym.qualifiedName} [${sym.kind} L${sym.startLine}-${sym.endLine}; ${count > 1 ? `${count} hits ` : "hit "}${locations}]`,
      );
    }
    for (const m of looseLines) parts.push(`  L${m.line}: ${m.text}`);
    blocks.push(`${rel}:\n${parts.join("\n")}`);
  }

  const truncated = matches.length >= MAX_MATCHES;
  const header = truncated
    ? `${MAX_MATCHES}+ matches for /${query}/ (TRUNCATED at ${MAX_MATCHES}; results are incomplete, narrow the query or path_glob), grouped by symbol:`
    : `${matches.length} match${matches.length > 1 ? "es" : ""} for /${query}/, grouped by symbol:`;
  const text = `${header}\n${note ? `${note}\n` : ""}${blocks.join("\n")}`;
  return {
    text,
    degraded: false,
    meta: makeMeta("code_search", undefined, baseline, estimateTokens(text)),
  };
}
