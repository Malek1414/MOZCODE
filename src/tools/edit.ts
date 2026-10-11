import { promises as fs } from "node:fs";
import { extractSymbols, resolveSymbol, type Symbol } from "../ast/engine.js";
import { analyzeFile, invalidateFile, sourceTokensOf } from "../ast/file-cache.js";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "./types.js";
import { renderOutline } from "./outline.js";

/** Declaration modifiers that sit outside the AST span of the declaration they prefix. */
const MODIFIER_PREFIX = /^(?:(?:export|default|declare)\s+)*(?:export|default|declare)$/;

/**
 * Start offset for the splice. Exported/ambient declarations have their span on the
 * inner declaration, so "export function f" starts at "function". code_read shows the
 * whole line, so a model naturally sends new_source that repeats the modifier; widen
 * the span to the modifier in that case instead of producing "export export function".
 */
function spliceStart(source: string, sym: Symbol, newSource: string): number {
  const lineStart = source.lastIndexOf("\n", sym.startIndex - 1) + 1;
  const head = source.slice(lineStart, sym.startIndex);
  const modifiers = head.trim();
  if (!modifiers || !MODIFIER_PREFIX.test(modifiers)) return sym.startIndex;
  const next = newSource.trimStart();
  if (!next.startsWith(modifiers) || !/\s/.test(next.charAt(modifiers.length))) return sym.startIndex;
  return lineStart + (head.length - head.trimStart().length);
}

export async function codeEdit(
  absPath: string,
  relPath: string,
  symbolName: string,
  newSource: string,
): Promise<ToolResult> {
  const analysis = await analyzeFile(absPath);
  const { source, language, symbols, hasError: hadError, timedOut } = analysis;
  const baseline = sourceTokensOf(analysis); // the whole-file re-read this edit avoids

  if (!language || timedOut) {
    const why = language ? "the file is too large to parse in time" : "unsupported language";
    const text = `Cannot AST-edit ${relPath}: ${why}. Use the built-in Edit tool for this file.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  const found = resolveSymbol(symbols, symbolName);
  if (!found) {
    const outline = renderOutline(symbols, relPath);
    const text = `Symbol "${symbolName}" not found in ${relPath}. Available symbols:\n${outline}`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  // A bare name shared by several symbols (e.g. two classes' "constructor") is
  // ambiguous: refuse rather than silently rewrite whichever came first.
  if (found.qualifiedName !== symbolName) {
    const candidates = symbols.filter((s) => s.name === symbolName);
    if (candidates.length > 1) {
      const list = candidates.map((s) => `  ${s.qualifiedName} [${s.kind} L${s.startLine}-${s.endLine}]`).join("\n");
      const text = `Edit rejected: "${symbolName}" is ambiguous in ${relPath}. Use a qualified name:\n${list}\nFile left unchanged.`;
      return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
    }
  }

  // "const a = 1, b = 2" gives a and b the same statement span; replacing one
  // would silently delete the other.
  const siblings = symbols.filter(
    (s) => s !== found && s.startIndex === found.startIndex && s.endIndex === found.endIndex,
  );
  if (siblings.length > 0) {
    const names = siblings.map((s) => s.qualifiedName).join(", ");
    const text = `Edit rejected: "${found.qualifiedName}" shares its declaration statement with ${names}; replacing it would also overwrite them. Use the built-in Edit tool for this statement. File left unchanged.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  const start = spliceStart(source, found, newSource);
  const next = source.slice(0, start) + newSource + source.slice(found.endIndex);

  // Validate: don't write code that newly breaks the parse.
  const { hasError: breaksNow, symbols: after, timedOut: validationTimedOut } = await extractSymbols(next, language);
  if (validationTimedOut) {
    const text = `Edit rejected: the edited ${relPath} is too large to validate in time. Use the built-in Edit tool. File left unchanged.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }
  if (breaksNow && !hadError) {
    const text = `Edit rejected: replacing "${found.qualifiedName}" would introduce a syntax error. File left unchanged.`;
    return { text, degraded: true, meta: makeMeta("code_edit", relPath, 0, estimateTokens(text)) };
  }

  await fs.writeFile(absPath, next, "utf8");
  invalidateFile(absPath);

  const newLineCount = newSource.split("\n").length;
  const newEndLine = found.startLine + newLineCount - 1;
  let text = `Edited ${relPath} › ${found.qualifiedName} (${found.kind}). New span L${found.startLine}-${newEndLine}. No re-read needed.`;
  // The parse check cannot catch new_source that is only a body or the wrong
  // declaration (and is skipped entirely when the file already had errors), so
  // say when the edited symbol no longer exists. Renames and deletions land here too.
  if (!after.some((s) => s.qualifiedName === found.qualifiedName)) {
    const added = after
      .filter((s) => s.startIndex >= start && s.endIndex <= start + newSource.length)
      .map((s) => s.qualifiedName);
    text +=
      `\nWarning: ${relPath} no longer defines "${found.qualifiedName}"` +
      (added.length ? ` (new_source defines ${added.join(", ")})` : " (new_source defines no symbol)") +
      `. If you did not mean to rename or delete it, new_source must be the complete declaration.`;
  }
  return {
    text,
    degraded: false,
    meta: makeMeta("code_edit", relPath, baseline, estimateTokens(text)),
  };
}
