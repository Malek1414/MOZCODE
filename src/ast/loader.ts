import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import { Parser, Language } from "web-tree-sitter";
import { GRAMMAR_FILE, type LanguageId } from "./languages.js";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const languageCache = new Map<LanguageId, Promise<Language>>();

/** Directory containing the grammar .wasm files. */
function grammarsDir(): string {
  // Preferred: the bundled grammars/ dir at the package root (production).
  const bundled = path.resolve(fileDir(), "..", "..", "grammars");
  if (fs.existsSync(path.join(bundled, GRAMMAR_FILE.typescript))) return bundled;
  // Fallback: resolve straight from the tree-sitter-wasms package (dev/test).
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out");
}

function fileDir(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

/** Initialize the tree-sitter WASM runtime exactly once. */
export async function initParser(): Promise<void> {
  if (!initPromise) {
    const runtimeWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    initPromise = Parser.init({
      locateFile: (name: string) =>
        name.endsWith(".wasm") ? runtimeWasm : name,
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
      const wasmPath = path.join(grammarsDir(), GRAMMAR_FILE[id]);
      return Language.load(wasmPath);
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
