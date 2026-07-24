import { languageForPath } from "../ast/languages.js";
import { extractSymbols, type Symbol } from "../ast/engine.js";
import { readFileSafe } from "../util/files.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";

/** Render a symbol list as a compact, indented outline. */
export function renderOutline(symbols: Symbol[], relPath: string): string {
  if (symbols.length === 0) return `${relPath}: (no top-level symbols found)`;
  const lines = symbols.map((s) => {
    const indent = "  ".repeat(s.depth);
    const loc = `L${s.startLine}-${s.endLine}`;
    return `${indent}${s.signature}   ⟨${s.kind} ${loc}⟩`;
  });
  return `${relPath}  —  outline (${symbols.length} symbols):\n${lines.join("\n")}`;
}

export async function codeOutline(absPath: string, relPath: string): Promise<ToolResult> {
  const source = await readFileSafe(absPath);
  const baseline = estimateTokens(source);
  const lang = languageForPath(absPath);

  if (!lang) {
    // Unsupported language: outline isn't possible; hand back a bounded head.
    const head = source.split("\n").slice(0, 40).join("\n");
    return {
      text: `${relPath}: unsupported language for AST outline. First 40 lines:\n${head}`,
      degraded: true,
      meta: makeMeta("code_outline", relPath, baseline, estimateTokens(head)),
    };
  }

  const { symbols, hasError } = await extractSymbols(source, lang);
  const text = renderOutline(symbols, relPath);
  return {
    text: hasError ? `${text}\n(note: file has syntax errors; outline may be partial)` : text,
    degraded: hasError,
    meta: makeMeta("code_outline", relPath, baseline, estimateTokens(text)),
  };
}
