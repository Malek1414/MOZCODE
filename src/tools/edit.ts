import { promises as fs } from "node:fs";
import { languageForPath } from "../ast/languages.js";
import { extractSymbols, resolveSymbol } from "../ast/engine.js";
import { readFileSafe } from "../util/files.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";
import { renderOutline } from "./outline.js";

export async function codeEdit(
  absPath: string,
  relPath: string,
  symbolName: string,
  newSource: string,
): Promise<ToolResult> {
  const source = await readFileSafe(absPath);
  const baseline = estimateTokens(source); // the whole-file re-read this edit avoids
  const lang = languageForPath(absPath);

  if (!lang) {
    const text = `Cannot AST-edit ${relPath}: unsupported language. Use the built-in Edit tool for this file.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  const { symbols, hasError: hadError } = await extractSymbols(source, lang);
  const found = resolveSymbol(symbols, symbolName);
  if (!found) {
    const outline = renderOutline(symbols, relPath);
    const text = `Symbol "${symbolName}" not found in ${relPath}. Available symbols:\n${outline}`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  const next = source.slice(0, found.startIndex) + newSource + source.slice(found.endIndex);

  // Validate: don't write code that newly breaks the parse.
  const { hasError: breaksNow } = await extractSymbols(next, lang);
  if (breaksNow && !hadError) {
    const text = `Edit rejected: replacing "${found.qualifiedName}" would introduce a syntax error. File left unchanged.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  await fs.writeFile(absPath, next, "utf8");

  const newLineCount = newSource.split("\n").length;
  const newEndLine = found.startLine + newLineCount - 1;
  const text = `Edited ${relPath} › ${found.qualifiedName} (${found.kind}). New span L${found.startLine}-${newEndLine}. No re-read needed.`;
  return {
    text,
    degraded: false,
    meta: makeMeta("code_edit", relPath, baseline, estimateTokens(text)),
  };
}
