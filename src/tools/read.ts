import { resolveSymbol } from "../ast/engine.js";
import { analyzeFile, sourceTokensOf } from "../ast/file-cache.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";
import { renderOutline } from "./outline.js";

export interface ReadOptions {
  symbol?: string;
  contextLines?: number;
}

/** Expand a symbol span to include N context lines on each side. */
function withContext(source: string, startLine: number, endLine: number, context: number): string {
  const lines = source.split("\n");
  const from = Math.max(0, startLine - 1 - context);
  const to = Math.min(lines.length, endLine + context);
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`)
    .join("\n");
}

/**
 * Caps for the plain-text fallback. Logs, JSON dumps and bundles can be many
 * MB; returning them whole would cost more tokens than the built-in Read,
 * which itself stops at 2000 lines.
 */
export const PLAIN_READ_MAX_LINES = 2000;
export const PLAIN_READ_MAX_CHARS = 100_000;

/** Line-numbered head of a file, within PLAIN_READ_MAX_LINES and PLAIN_READ_MAX_CHARS. */
function numberedHead(source: string): { text: string; shownLines: number; totalLines: number; complete: boolean } {
  const lines = source.split("\n");
  const out: string[] = [];
  let chars = 0;
  let lineCut = false;
  for (let i = 0; i < lines.length && i < PLAIN_READ_MAX_LINES; i++) {
    let line = `${String(i + 1).padStart(4)}  ${lines[i]}`;
    if (chars + line.length > PLAIN_READ_MAX_CHARS) {
      // Always show something, even when the first line alone is over the cap (minified files).
      if (out.length > 0) break;
      line = line.slice(0, PLAIN_READ_MAX_CHARS) + " [line truncated]";
      lineCut = true;
    }
    out.push(line);
    chars += line.length + 1;
  }
  return {
    text: out.join("\n"),
    shownLines: out.length,
    totalLines: lines.length,
    complete: !lineCut && out.length === lines.length,
  };
}

const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 200;

/**
 * Normalize context_lines from untrusted tool input. A string ("2") would turn
 * `endLine + context` into string concatenation, a negative value would cut the
 * symbol short, and NaN would return nothing.
 */
function contextLinesOf(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_CONTEXT;
  return Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(n)));
}

export async function codeRead(absPath: string, relPath: string, opts: ReadOptions = {}): Promise<ToolResult> {
  const analysis = await analyzeFile(absPath);
  const { source, language, symbols, hasError, timedOut } = analysis;
  const baseline = sourceTokensOf(analysis);
  const context = contextLinesOf(opts.contextLines);

  // Unsupported language, or too large to parse in time -> plain (numbered) read.
  if (!language || timedOut) {
    const { text: numbered, shownLines, totalLines, complete } = numberedHead(source);
    const why = language ? "too large to parse for symbol extraction" : "unsupported for symbol extraction";
    const label = complete ? "whole file" : `first ${shownLines} of ${totalLines} lines, truncated`;
    const more = complete
      ? ""
      : `\n[truncated${totalLines > shownLines ? `: ${totalLines - shownLines} more lines` : ""}; use the built-in Read with an offset for the rest]`;
    return {
      text: `${relPath} (${label}, ${why}):\n${numbered}${more}`,
      degraded: true,
      meta: makeMeta("code_read", relPath, baseline, estimateTokens(numbered)),
    };
  }

  // No symbol requested -> collapsed-body outline (the map).
  if (!opts.symbol) {
    const text = renderOutline(symbols, relPath);
    return {
      text,
      degraded: hasError,
      meta: makeMeta("code_read", relPath, baseline, estimateTokens(text)),
    };
  }

  const found = resolveSymbol(symbols, opts.symbol);
  if (!found) {
    // Symbol miss -> return the outline so the model can retry with a real name.
    const outline = renderOutline(symbols, relPath);
    const text = `Symbol "${opts.symbol}" not found in ${relPath}. Available symbols:\n${outline}`;
    return {
      text,
      degraded: true,
      meta: makeMeta("code_read", relPath, baseline, estimateTokens(text)),
    };
  }

  const body = withContext(source, found.startLine, found.endLine, context);
  const text = `${relPath} › ${found.qualifiedName}  (${found.kind}, L${found.startLine}-${found.endLine}):\n${body}`;
  return {
    text,
    degraded: false,
    meta: makeMeta("code_read", relPath, baseline, estimateTokens(text)),
  };
}
