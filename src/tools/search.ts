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
  /**
   * Longest substring that must literally appear (verbatim) in any line the
   * pattern can match, e.g. "foo" for `foo\w+\(\)`. Lines failing a cheap
   * `includes()` check against this can never match the full regex, so it
   * lets the line-scan loop skip the RE2 matcher entirely for them. Left
   * undefined when no such substring could be proven (e.g. top-level
   * alternation, or a pattern with no literal run at all).
   */
  requiredLiteral?: string;
  /**
   * One required literal per top-level alternation branch, e.g.
   * `["TODO", "FIXME", "XXX"]` for `TODO|FIXME|XXX`: any line (or file) the
   * pattern can match must contain at least one of these. A single-branch
   * pattern yields a one-element array (same literal as `requiredLiteral`).
   * Undefined whenever any branch has no provable literal, same conservatism
   * as `requiredLiteral`. Drives the whole-buffer scan in `codeSearch`, which
   * never splits a file into lines at all when this is empty-of-hits.
   */
  requiredLiterals?: string[];
}

function skipClass(pattern: string, start: number): number {
  let i = start + 1; // past '['
  if (pattern[i] === "^") i++;
  if (pattern[i] === "]") i++; // leading ']' is a literal member
  const n = pattern.length;
  while (i < n && pattern[i] !== "]") {
    if (pattern[i] === "\\") i++;
    i++;
  }
  return i + 1; // past ']'
}

/**
 * Split a pattern into its top-level alternation branches (depth-0 `|`),
 * treating groups and character classes as opaque spans so a `|` nested
 * inside either doesn't count as a split point. A pattern with no top-level
 * `|` yields a single-element array (the whole pattern).
 */
function splitTopLevelAlternation(pattern: string): string[] {
  const n = pattern.length;
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      i = skipClass(pattern, i);
      continue;
    }
    if (c === "(") {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const cc = pattern[i];
        if (cc === "\\") {
          i += 2;
          continue;
        }
        if (cc === "[") {
          i = skipClass(pattern, i);
          continue;
        }
        if (cc === "(") depth++;
        else if (cc === ")") depth--;
        i += 1;
      }
      continue;
    }
    if (c === "|") {
      parts.push(pattern.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(pattern.slice(start));
  return parts;
}

/**
 * Like `extractRequiredLiteral`, but for patterns with top-level alternation:
 * returns one required literal per branch (so a match requires at least one
 * of them present), or undefined if any branch has no provable literal.
 */
function extractRequiredLiterals(pattern: string): string[] | undefined {
  const branches = splitTopLevelAlternation(pattern);
  if (branches.length === 1) {
    const lit = extractRequiredLiteral(pattern);
    return lit === undefined ? undefined : [lit];
  }
  const literals: string[] = [];
  for (const branch of branches) {
    const lit = extractRequiredLiteral(branch);
    if (lit === undefined) return undefined;
    literals.push(lit);
  }
  return literals;
}

/**
 * Extract the longest substring that is unconditionally present (as plain
 * text) in anything the pattern matches. Conservative by construction: any
 * construct whose required contents aren't provably simple literal text
 * (groups, character classes, backreference-style escapes) is skipped as an
 * opaque span rather than parsed, and a top-level `|` aborts entirely, so a
 * wrong answer can only make the prefilter weaker, never incorrect.
 */
function extractRequiredLiteral(pattern: string): string | undefined {
  // An inline `(?i)`-style flag makes some or all of the match case
  // insensitive, so any literal text we'd extract can't be safely compared
  // with a case-sensitive `includes()`. Bail rather than get it wrong.
  if (/\(\?[a-zA-Z-]*i[a-zA-Z-]*[:)]/.test(pattern)) return undefined;
  const n = pattern.length;
  let best = "";
  let cur = "";
  const flush = () => {
    if (cur.length > best.length) best = cur;
    cur = "";
  };
  let i = 0;
  while (i < n) {
    const c = pattern[i];
    if (c === "\\") {
      const c2 = pattern[i + 1];
      if (c2 !== undefined && ".^$*+?()[]{}|\\/-".includes(c2)) {
        cur += c2;
      } else if (c2 !== undefined && "dDwWsSbBAzntrfv".includes(c2)) {
        flush(); // single-character class/assertion escape: not literal text
      } else {
        // \x41, \x{e9}, \pL, \p{Lu}, \101, \Q...\E and the like take arguments
        // that look like literal text but aren't; give up on the prefilter.
        return undefined;
      }
      i += 2;
      continue;
    }
    if (c === "[") {
      flush();
      i = skipClass(pattern, i);
      continue;
    }
    if (c === "(") {
      // Opaque: don't try to reason about alternation/backreferences/flags
      // inside groups, just skip the whole (possibly nested) span.
      flush();
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const cc = pattern[i];
        if (cc === "\\") {
          i += 2;
          continue;
        }
        if (cc === "[") {
          i = skipClass(pattern, i);
          continue;
        }
        if (cc === "(") depth++;
        else if (cc === ")") depth--;
        i += 1;
      }
      continue;
    }
    if (c === "|") {
      // Top-level alternation: no substring is common to every branch.
      return undefined;
    }
    if (c === "." || c === "^" || c === "$") {
      flush();
      i += 1;
      continue;
    }
    if (c === "*" || c === "+" || c === "?") {
      // Quantifies the char just added: it may occur zero times, so it
      // isn't actually required.
      if (cur.length > 0) cur = cur.slice(0, -1);
      flush();
      i += 1;
      continue;
    }
    if (c === "{") {
      const m = /^\{\d*(,\d*)?\}/.exec(pattern.slice(i));
      if (m) {
        if (cur.length > 0) cur = cur.slice(0, -1);
        flush();
        i += m[0].length;
        continue;
      }
      cur += c; // not a well-formed quantifier: literal brace
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  flush();
  return best.length > 0 ? best : undefined;
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
    return {
      rx: RE2JS.compile(query),
      requiredLiteral: extractRequiredLiteral(query),
      requiredLiterals: extractRequiredLiterals(query),
    };
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

/**
 * Resolve the enclosing (innermost containing) symbol for every match in a
 * file in one pass.
 *
 * `offsets` must be in non-decreasing order (true for a single file's matches,
 * since the line-scan loop walks the file top to bottom). Symbols are sorted
 * once by startIndex, then swept alongside the offsets with a stack of
 * currently-open spans: spans that ended before the current offset are popped
 * off the top, spans that have started are pushed on, and the answer for each
 * offset is the smallest-span entry still on the stack that contains it. Each
 * symbol is pushed and popped at most once, so this is O(matches + symbols)
 * per file instead of a linear symbol scan per match (O(matches * symbols)).
 *
 * The stack push/pop only tracks which spans *can* still contain a future
 * offset (cheap to get right); the final smallest-span pick re-checks
 * containment and scans the whole (tiny, nesting-depth-bounded) stack rather
 * than trusting the top, so it stays correct even for the degenerate case of
 * two non-nested symbols that touch at exactly the queried offset.
 *
 * Sweeping requires spans sorted by startIndex, but ties on span size must
 * still resolve the same way the original linear scan did: first match in
 * `symbols` wins. So candidates are tracked by their index into the original
 * (unsorted) `symbols` array, and a tie on size is broken by the smaller
 * index rather than by stack/sweep order.
 */
function enclosingSweep(symbols: Symbol[], offsets: number[]): (Symbol | null)[] {
  const order = symbols.map((_, i) => i);
  if (order.length > 1) order.sort((a, b) => symbols[a].startIndex - symbols[b].startIndex);
  const stack: number[] = [];
  let j = 0;
  const out: (Symbol | null)[] = new Array(offsets.length);
  for (let k = 0; k < offsets.length; k++) {
    const offset = offsets[k];
    while (stack.length > 0 && symbols[stack[stack.length - 1]].endIndex < offset) stack.pop();
    while (j < order.length && symbols[order[j]].startIndex <= offset) {
      const idx = order[j];
      j++;
      if (symbols[idx].endIndex >= offset) stack.push(idx);
    }
    let bestIdx = -1;
    for (const idx of stack) {
      const s = symbols[idx];
      if (offset >= s.startIndex && offset <= s.endIndex) {
        if (bestIdx === -1) {
          bestIdx = idx;
        } else {
          const best = symbols[bestIdx];
          const bestSize = best.endIndex - best.startIndex;
          const size = s.endIndex - s.startIndex;
          if (size < bestSize || (size === bestSize && idx < bestIdx)) bestIdx = idx;
        }
      }
    }
    out[k] = bestIdx === -1 ? null : symbols[bestIdx];
  }
  return out;
}

/**
 * Full line-by-line scan with no literal prefilter: the safe fallback.
 *
 * Walks the raw buffer with `indexOf('\n', ...)` instead of `source.split("\n")`,
 * so a file never pays for allocating (and GC'ing) an array of every one of its
 * lines up front — each line is sliced out one at a time, right before it's fed
 * to the matcher, and a MAX_MATCHES cutoff stops the walk without ever touching
 * the rest of the buffer. Mirrors `split("\n")`'s exact line boundaries,
 * including the trailing empty "line" a trailing newline produces.
 *
 * `rx.test(line)` runs the same unanchored search as a fresh matcher's first
 * `find()` but skips allocating a `Matcher` object; a `Matcher` (for `.start()`)
 * is only built on the rare line that actually matches.
 */
function scanAllLines(source: string, rx: RE2JS, file: string, matches: RawMatch[]): void {
  const n = source.length;
  let lineStart = 0;
  let lineNo = 1;
  for (;;) {
    let lineEnd = source.indexOf("\n", lineStart);
    const isLast = lineEnd === -1;
    if (isLast) lineEnd = n;
    const line = source.slice(lineStart, lineEnd);
    if (rx.test(line)) {
      const m = rx.matcher(line);
      m.find();
      matches.push({ file, line: lineNo, text: line.trim(), offset: lineStart + m.start() });
      if (matches.length >= MAX_MATCHES) return;
    }
    if (isLast) return;
    lineStart = lineEnd + 1;
    lineNo++;
  }
}

/**
 * Count '\n' characters in source[from, to) without allocating a substring
 * (used to track line numbers while skipping over untouched regions).
 */
function countNewlines(source: string, from: number, to: number): number {
  let count = 0;
  let p = source.indexOf("\n", from);
  while (p !== -1 && p < to) {
    count++;
    p = source.indexOf("\n", p + 1);
  }
  return count;
}

/**
 * Whole-buffer literal pruning: find every byte range in the raw file text
 * that could contain a match (i.e. contains at least one required literal)
 * before ever splitting the file into lines. Files or regions with no hit for
 * any literal never pay for split()'s per-line allocation or a per-line
 * `includes()` check — the win the plain whole-file skip couldn't give for a
 * large file with only a few scattered hits, or for an alternation query like
 * `TODO|FIXME` with no single literal common to every branch.
 *
 * Line numbers are derived incrementally (newlines counted only across the
 * gap since the last processed line, never from the top of the file), and
 * each candidate line is sliced directly out of `source` and fed to RE2
 * exactly once, mirroring the line-by-line scan's semantics. `rx.test(line)`
 * checks for a match without allocating a `Matcher`; one is only built (to
 * read `.start()`) on a line that actually matches.
 */
function scanWithRequiredLiterals(
  source: string,
  literals: string[],
  rx: RE2JS,
  file: string,
  matches: RawMatch[],
): void {
  let hits: number[];
  if (literals.length === 1) {
    hits = [];
    const lit = literals[0];
    let p = source.indexOf(lit);
    while (p !== -1) {
      hits.push(p);
      p = source.indexOf(lit, p + lit.length);
    }
  } else {
    hits = [];
    for (const lit of literals) {
      let p = source.indexOf(lit);
      while (p !== -1) {
        hits.push(p);
        p = source.indexOf(lit, p + lit.length);
      }
    }
    hits.sort((a, b) => a - b);
  }
  let pos = 0;
  let lineNo = 1;
  let lastLineEnd = -1;
  for (let hi = 0; hi < hits.length; hi++) {
    const h = hits[hi];
    if (h <= lastLineEnd) continue; // already covered by the previous line
    const searchFrom = h - 1;
    const nl = searchFrom < 0 ? -1 : source.lastIndexOf("\n", searchFrom);
    const lineStart = nl + 1;
    lineNo += countNewlines(source, pos, lineStart);
    pos = lineStart;
    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    const line = source.slice(lineStart, lineEnd);
    if (rx.test(line)) {
      const m = rx.matcher(line);
      m.find();
      matches.push({ file, line: lineNo, text: line.trim(), offset: lineStart + m.start() });
      if (matches.length >= MAX_MATCHES) return;
    }
    lastLineEnd = lineEnd;
  }
}

export async function codeSearch(
  root: string,
  query: string,
  pathGlob?: string,
  fileLimit?: number,
): Promise<ToolResult> {
  const { rx, note, requiredLiterals } = compileQuery(query);
  const { files, truncated: filesTruncated } = await listSourceFiles(root, {
    limit: fileLimit,
    include: pathGlob
      ? (file) => matchesGlob(path.isAbsolute(pathGlob) ? file : path.relative(root, file), pathGlob)
      : undefined,
  });
  const fileNote = filesTruncated
    ? `Only the first ${files.length} source files were searched (file limit reached); narrow path_glob to search the rest.`
    : undefined;
  const matches: RawMatch[] = [];

  // Read files in parallel batches but scan them in walk order, so results and
  // the MAX_MATCHES cut-off stay deterministic. One stat+read at a time made a
  // cold search scale with per-file I/O latency times the file count. The next
  // batch's reads are kicked off as soon as the current batch's reads start
  // (one batch ahead of the scan), so cold-read I/O latency overlaps with the
  // CPU-bound line scanning instead of the two serializing.
  const readBatch = (from: number): Promise<string | null>[] =>
    files.slice(from, from + READ_BATCH).map((f) => readCachedSource(f).catch(() => null));
  let batch = readBatch(0);
  let nextBatch = files.length > READ_BATCH ? readBatch(READ_BATCH) : null;
  for (let idx = 0; idx < files.length; idx++) {
    const slot = idx % READ_BATCH;
    if (slot === 0 && idx > 0) {
      batch = nextBatch!;
      const nextFrom = idx + READ_BATCH;
      nextBatch = nextFrom < files.length ? readBatch(nextFrom) : null;
    }
    const file = files[idx];
    const source = await batch[slot];
    if (source === null) continue;
    if (requiredLiterals !== undefined) {
      scanWithRequiredLiterals(source, requiredLiterals, rx, file, matches);
    } else {
      scanAllLines(source, rx, file, matches);
    }
    if (matches.length >= MAX_MATCHES) break;
  }

  // Baseline: what a plain grep would dump — every matching line.
  const baselineText = matches
    .map((m) => `${path.relative(root, m.file)}:${m.line}: ${m.text}`)
    .join("\n");
  const baseline = estimateTokens(baselineText) || 1;

  if (matches.length === 0) {
    const text = `No matches for /${query}/${pathGlob ? ` in ${pathGlob}` : ""}.${note ? ` ${note}` : ""}${fileNote ? ` ${fileNote}` : ""}`;
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
    // fileMatches is already in increasing offset order: matches are pushed by
    // the line-scan loop as it walks the file top to bottom.
    const enclosingSyms = enclosingSweep(symbols, fileMatches.map((m) => m.offset));
    for (let fi = 0; fi < fileMatches.length; fi++) {
      const m = fileMatches[fi];
      const sym = enclosingSyms[fi];
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
  const text = `${header}\n${note ? `${note}\n` : ""}${fileNote ? `${fileNote}\n` : ""}${blocks.join("\n")}`;
  return {
    text,
    degraded: false,
    meta: makeMeta("code_search", undefined, baseline, estimateTokens(text)),
  };
}
