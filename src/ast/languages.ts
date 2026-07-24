/**
 * Language registry: maps file extensions to tree-sitter grammar ids.
 * A language absent here falls back to a plain whole-file / line-range read.
 */

export type LanguageId = "typescript" | "tsx" | "javascript" | "python";

const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
  ".py": "python",
  ".pyi": "python",
};

/** Grammar wasm filenames, as shipped by tree-sitter-wasms. */
export const GRAMMAR_FILE: Record<LanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

export function languageForPath(path: string): LanguageId | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return EXT_TO_LANGUAGE[lower.slice(dot)] ?? null;
}

export const SUPPORTED_LANGUAGES: LanguageId[] = [
  "typescript",
  "tsx",
  "javascript",
  "python",
];
