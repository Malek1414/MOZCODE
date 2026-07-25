import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { GRAMMAR_FILE, type LanguageId } from "./languages.js";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const languageCache = new Map<LanguageId, Promise<Language>>();

function fileDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Directory holding the wasm assets (grammars + the web-tree-sitter runtime).
 * Works in three layouts:
 *   1. Bundled plugin:  <root>/dist/server.js  → <root>/grammars   (walk up)
 *   2. tsc build:       <root>/dist/ast/loader.js → <root>/grammars (walk up)
 *   3. Dev (no build):  fall back to the tree-sitter-wasms package.
 */
function assetsDir(): string {
  let dir = fileDir();
  for (let i = 0; i < 6; i++) {
    const g = path.join(dir, "grammars");
    if (fs.existsSync(path.join(g, GRAMMAR_FILE.typescript))) return g;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Dev fallback: grammars straight from the installed package.
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out");
}

/** Path to the web-tree-sitter runtime wasm — shipped alongside grammars, or resolved in dev. */
function runtimeWasm(): string {
  const shipped = path.join(assetsDir(), "tree-sitter.wasm");
  if (fs.existsSync(shipped)) return shipped;
  return require.resolve("web-tree-sitter/tree-sitter.wasm");
}

/** Initialize the tree-sitter WASM runtime exactly once. */
export async function initParser(): Promise<void> {
  if (!initPromise) {
    const rt = runtimeWasm();
    initPromise = Parser.init({
      locateFile: (name: string) => (name.endsWith(".wasm") ? rt : name),
    } as never);
  }
  return initPromise;
}

/** Load (and cache) a grammar Language by id. */
export async function loadLanguage(id: LanguageId): Promise<Language> {
  let cached = languageCache.get(id);
  if (!cached) {
    cached = (async () => {
      await initParser();
      return Language.load(path.join(assetsDir(), GRAMMAR_FILE[id]));
    })();
    languageCache.set(id, cached);
  }
  return cached;
}

/** A ready-to-use parser configured for the given language. */
export async function parserFor(id: LanguageId): Promise<Parser> {
  await initParser();
  const language = await loadLanguage(id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
