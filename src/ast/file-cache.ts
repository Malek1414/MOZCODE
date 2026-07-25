import { promises as fs } from "node:fs";
import { extractSymbols, type ParseResult } from "./engine.js";
import { languageForPath, type LanguageId } from "./languages.js";

export interface FileAnalysis extends ParseResult {
  source: string;
  language: LanguageId | null;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  source: Promise<string>;
  analysis?: Promise<FileAnalysis>;
}

const files = new Map<string, CacheEntry>();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

function remove(filePath: string): void {
  const entry = files.get(filePath);
  if (!entry) return;
  cachedBytes -= entry.size;
  files.delete(filePath);
}

function trim(exceptPath: string): void {
  for (const filePath of files.keys()) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    if (filePath !== exceptPath) remove(filePath);
  }
}

async function currentEntry(filePath: string): Promise<CacheEntry> {
  const stat = await fs.stat(filePath);
  const cached = files.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Map insertion order doubles as a tiny LRU list.
    files.delete(filePath);
    files.set(filePath, cached);
    return cached;
  }

  remove(filePath);
  const entry: CacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    source: fs.readFile(filePath, "utf8"),
  };
  files.set(filePath, entry);
  cachedBytes += entry.size;
  trim(filePath);
  try {
    await entry.source;
    return entry;
  } catch (error) {
    if (files.get(filePath) === entry) remove(filePath);
    throw error;
  }
}

/** Read a source file once and reuse it until its mtime or size changes. */
export async function readCachedSource(filePath: string): Promise<string> {
  return (await currentEntry(filePath)).source;
}

/** Read and parse a source file once and reuse the AST-derived symbols while unchanged. */
export async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const entry = await currentEntry(filePath);
  if (!entry.analysis) {
    entry.analysis = (async () => {
      const source = await entry.source;
      const language = languageForPath(filePath);
      if (!language) return { source, language, symbols: [], hasError: false };
      const parsed = await extractSymbols(source, language);
      return { source, language, ...parsed };
    })();
  }
  return entry.analysis;
}

/** Invalidate after an in-process edit; external edits are detected by stat metadata. */
export function invalidateFile(filePath: string): void {
  remove(filePath);
}

/** Benchmark/test hook: simulate a cold process without reloading tree-sitter grammars. */
export function clearFileCache(): void {
  files.clear();
  cachedBytes = 0;
}
