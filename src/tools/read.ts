import { languageForPath } from "../ast/languages.js";
import { extractSymbols, resolveSymbol } from "../ast/engine.js";
import { readFileSafe } from "../util/files.js";
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

export async function codeRead(absPath: string, relPath: string, opts: ReadOptions = {}): Promise<ToolResult> {
  const source = await readFileSafe(absPath);
  const baseline = estimateTokens(source);
  const lang = languageForPath(absPath);
  const context = opts.contextLines ?? 3;

  // Unsupported language -> plain (numbered) whole-file read.
  if (!lang) {
    const numbered = source
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
      .join("\n");
    return {
      text: `${relPath} (whole file, unsupported for symbol extraction):\n${numbered}`,
      degraded: true,
      meta: makeMeta("code_read", relPath, baseline, estimateTokens(numbered)),
    };
  }

  const { symbols, hasError } = await extractSymbols(source, lang);

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
