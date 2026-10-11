# Area: AST engine & tree-sitter loading

Paths: `src/ast/engine.ts` (239 lines), `src/ast/file-cache.ts` (92), `src/ast/languages.ts` (41), `src/ast/loader.ts` (76).

This is the core of MOZCODE's token-saving technique. It turns a source file into a flat list of `Symbol`s (name, kind, one-line signature, exact UTF-16 span, 1-based lines). Every `code_*` tool reads from that list, so `code_read` can return one function instead of the whole file. The layers, from the bottom up:

```
languages.ts  (extension -> LanguageId -> grammar .wasm filename)
     |
loader.ts     (WASM runtime init once, grammar Language cache, new Parser per call)
     |
engine.ts     (parse -> walk top-level CST -> Symbol[]; resolveSymbol)
     |
file-cache.ts (stat-keyed source + analysis memo, 64 MB LRU-ish)
     |
tools: read.ts, outline.ts, search.ts, edit.ts   (src/tools/*)
```

Callers (verified):
- `analyzeFile`: `src/tools/read.ts:24`, `src/tools/outline.ts:18`, `src/tools/edit.ts:14`, `src/tools/search.ts:97`
- `readCachedSource`: `src/tools/search.ts:50`
- `resolveSymbol`: `src/tools/read.ts:51`, `src/tools/edit.ts:22`
- `extractSymbols` (direct, uncached): `src/tools/edit.ts:32` (post-edit validation), `scripts/benchmark.ts:82`
- `invalidateFile`: `src/tools/edit.ts:39`
- `clearFileCache`: `scripts/benchmark-performance.ts:231-273` only
- `SUPPORTED_LANGUAGES`: `src/server.ts:14`, `test/packaging.test.ts:11`; `GRAMMAR_FILE`: `test/packaging.test.ts:11`
- Tests: `test/engine.test.ts` covers TS function/class/method extraction, qualified/bare resolution, Python class+method, and the syntax-error flag (`:14-78`). Nothing tests `file-cache.ts` or `loader.ts` path resolution directly. Integration coverage comes through `test/tools.test.ts` and `test/integration.test.ts`.

---

## src/ast/languages.ts

**Purpose:** a static registry that maps file extensions to the four supported tree-sitter grammars. An unknown extension means "no AST, fall back to a plain read".

- `type LanguageId`, `languages.ts:6`. The union `"typescript" | "tsx" | "javascript" | "python"`.
- `EXT_TO_LANGUAGE`, `languages.ts:8-19`
  - **What:** maps `.ts/.mts/.cts` to typescript, `.tsx` and `.jsx` to tsx, `.js/.mjs/.cjs` to javascript, and `.py/.pyi` to python.
  - **Why:** `.jsx` goes to the tsx grammar because the plain JS grammar handles JSX too, but tsx is the superset (inferred).
- `GRAMMAR_FILE`, `languages.ts:22-27`. Maps each LanguageId to the wasm filename in `grammars/` (or in `tree-sitter-wasms/out` in dev).
- `languageForPath(path) -> LanguageId | null`, `languages.ts:29-34`
  - **What/How:** lowercases the path, takes the substring from the last `.`, and looks it up. `.d.ts` resolves to typescript because only the last extension counts.
  - **Used by:** `file-cache.ts:74`, `search.ts:89`, `scripts/benchmark.ts`.
  - **Risks:** a dot in a directory name with an extensionless file (e.g. `foo.d/Makefile`) yields `.d/makefile`, which is not in the map and so returns null. That is harmless.
- `SUPPORTED_LANGUAGES`, `languages.ts:36-41`. Hand-duplicates the keys of `GRAMMAR_FILE`.
  - **Risks:** low. The two lists can drift. `Object.keys(GRAMMAR_FILE)` would remove the duplication, and `test/packaging.test.ts` partly guards against drift.

## src/ast/loader.ts

**Purpose:** locates the WASM assets in three deployment layouts, initialises the web-tree-sitter runtime exactly once, and memoises grammar `Language` objects.

- `fileDir()`, `loader.ts:13-15`. The directory of the running module, from `import.meta.url`. In the bundle that is `dist/`.
- `assetsDir() -> string`, `loader.ts:24-36`
  - **What:** returns the folder that holds the grammar wasm files.
  - **How:** walks up to 6 parents from `fileDir()` looking for `grammars/tree-sitter-typescript.wasm` (`:26-32`), then falls back to `require.resolve("tree-sitter-wasms/package.json")/../out` (`:34-35`).
  - **Why:** the same code must work as the esbuild bundle `dist/server.js`, as tsc output `dist/ast/loader.js`, and from `src/` under tsx or vitest (doc comment `:17-23`).
  - **Risks:** it does synchronous `fs.existsSync` probing and is recomputed on every call: once from `runtimeWasm()` and once per cold `loadLanguage()` (`:62`). This is cheap because it only runs on cold paths, but it is not memoised. If neither layout exists, `require.resolve` throws a raw MODULE_NOT_FOUND with no MOZCODE-specific message.
- `runtimeWasm() -> string`, `loader.ts:39-43`. Prefers `<assets>/tree-sitter.wasm` (committed in `grammars/`) and otherwise uses `require.resolve("web-tree-sitter/tree-sitter.wasm")`.
- `initParser(): Promise<void>`, `loader.ts:46-54`
  - **What/How:** `Parser.init({ locateFile })` is memoised in the module-level `initPromise`. `locateFile` redirects any `*.wasm` request to the resolved runtime. The options object is cast with `as never` (`:51`), which hides a typing mismatch.
  - **Risks (medium):** a rejected `initPromise` is cached forever. One transient failure (for example an EMFILE during startup) leaves every later AST call broken until the MCP server restarts. The same applies to `languageCache` entries (`:60-64`).
- `loadLanguage(id) -> Promise<Language>`, `loader.ts:57-67`. Caches the promise per id in `languageCache` before awaiting, so concurrent callers share one load. It calls `Language.load(path)`.
- `parserFor(id) -> Promise<Parser>`, `loader.ts:70-76`
  - **What:** returns a new `Parser` with the language set.
  - **How:** awaits init, then the cached language, then `new Parser(); parser.setLanguage(language)`.
  - **Why:** a fresh parser per call avoids sharing mutable parser state across concurrent async calls (inferred).
  - **Risks (HIGH, scale):** web-tree-sitter `Parser` and `Tree` objects live in the WASM heap and must be freed explicitly with `.delete()`. Nothing in `src/` ever calls `.delete()` (a grep for `.delete()` in `src` finds only Map deletes). Every `analyzeFile` miss and every `code_edit` validation therefore leaks one Parser plus one full Tree. A long-lived MCP session that touches thousands of files, or re-reads edited files, grows WASM linear memory, which never shrinks. Allocating a parser per call also adds overhead. A small pool, or one parser per language reused serially, plus `tree.delete()` in `extractSymbols`, fixes both problems.

## src/ast/engine.ts

**Purpose:** parses source with tree-sitter and extracts a flat, ordered list of declarations (with class members one level deep) in a language-specific way. It also resolves a user-supplied symbol name to one of them.

- `interface Symbol`, `engine.ts:5-24`. Fields: `name`, `qualifiedName` (`Container.name`), `kind`, `signature`, `startIndex`/`endIndex` (UTF-16 offsets that `String.slice` can use directly), `startLine`/`endLine` (1-based), `depth`, and `container`. Note that the name shadows the global `Symbol` inside importing modules.
- `signatureOf(node, source, bodyStart?)`, `engine.ts:27-35`
  - **What:** the declaration head without its body, e.g. `function add(a: number, b: number): number`.
  - **How:** slices the source from the node start to the `body` field start (or to an explicit `bodyStart`), collapses whitespace and newlines, and strips a trailing `{` or `=>`.
  - **Why:** the outline and search output show the signature instead of the code, which is the token-saving primitive.
- `nameFromField(node)`, `engine.ts:37-40`. Returns the text of the `name` field, or null.
- `mkSymbol(node, name, kind, signature, container, depth)`, `engine.ts:42-62`. Builds a `Symbol` from the node's span and positions (`row + 1`).
- `walkTsMembers(classBody, source, className, out)`, `engine.ts:68-88`
  - **What:** emits class members at depth 1. A `method_definition` becomes a method. A `public_field_definition` becomes a method when its value is an arrow or function expression and a field otherwise, with the signature taken from the field's first line.
  - **Risks (low/medium):** it ignores `abstract_method_signature`, `method_signature` (overloads), and static blocks. Interface members are never walked (`:112-116` emits only the interface itself), so `code_read Foo.bar` on an interface method falls back to the whole interface. Nested classes and object-literal methods are not indexed.
- `handleTsNode(node, source, out)`, `engine.ts:90-150`
  - **What:** dispatches on CST node type for TS, TSX and JS top-level statements.
  - **How:**
    - `export_statement` and `ambient_declaration` recurse into their children (`:92-96`). As a result, the symbol span excludes the `export`/`declare` keyword, so `code_edit` replacements keep the export prefix. That is good, but it is undocumented.
    - Function and generator function declarations become functions (`:97-102`).
    - Class and abstract class declarations become a class plus their members (`:103-111`).
    - Interfaces become interfaces (`:112-116`).
    - A type alias becomes a type, with the signature cut at the first `=` after the node start (`:117-125`).
    - Enums become enums (`:126-130`).
    - A `lexical_declaration`/`variable_declaration` emits one symbol per declarator: kind function for an arrow or function value, otherwise const (`:131-148`).
  - **Risks:**
    - (medium, correctness) Multi-declarator statements: `mkSymbol(node, ...)` at `:141` and `:144` passes the whole statement node, not `decl`. With `const a = 1, b = () => 2;`, symbols `a` and `b` both span the entire statement. `code_edit a` then silently overwrites `b` too (`edit.ts:29` splices `[startIndex, endIndex)`).
    - (low) For a type alias, `source.indexOf("=")` matches the `=` in a generic default (`type Box<T = string> = ...`), giving the signature `type Box<T`.
    - (low) Coverage gaps: `export default function () {}` and `export default class {}` have no name and are dropped. `export =`, namespaces and modules (`internal_module`), `declare module "x" {}`, and CommonJS `module.exports = ...` and `exports.foo = function` (common in .js/.cjs) are not indexed. All of these fall back to a whole-file read upstream.
    - (low) All non-function variables are labelled `"const"`, even `let` and `var`.
- `extractTs(root, source)`, `engine.ts:152-156`. Applies `handleTsNode` to each named child of the program root.
- `pySignature(node, source)`, `engine.ts:162-169`. Takes the head up to the last `:` before the body block. That handles annotations such as `def f(x: int) -> Dict[str, int]:` because `lastIndexOf` searches backwards from the body.
- `handlePyNode(node, source, out, container, depth, spanNode?)`, `engine.ts:171-207`
  - **What/How:**
    - `decorated_definition` recurses into its definition but keeps the outer node as the span, so decorators are included in reads and edits (`:173-179`).
    - A `function_definition` becomes a method when it is inside a container and a function otherwise (`:180-184`).
    - A `class_definition` recurses into its body with `depth + 1` and `container = className` (`:185-192`). Nested classes therefore get `qualifiedName` `Inner.method`, not `Outer.Inner.method`, because the container is only the immediate class name.
    - A top-level `NAME = value` becomes a variable (`:193-205`).
  - **Risks (low):** the qualified names of nested classes lose the outer prefix, which can collide in `resolveSymbol`. Tuple and annotated-only assignments (`X: int`) and `if TYPE_CHECKING:` or `try:` blocks at module level are skipped.
- `extractPy(root, source)`, `engine.ts:209-213`.
- `interface ParseResult { symbols; hasError }`, `engine.ts:217-221`.
- `extractSymbols(source, language) -> Promise<ParseResult>`, `engine.ts:224-231`
  - **What:** parses the source and returns the symbols plus `root.hasError`.
  - **How:** `parserFor(language)`, then `parser.parse(source)`, then the language extractor. A null tree is reported as `hasError: true`.
  - **Why:** this single entry point backs every tool. `edit.ts:32` also uses it to reject edits that newly break the parse.
  - **Risks (HIGH, scale):** it never calls `tree.delete()` or `parser.delete()` (see loader.ts). There is no timeout or progress callback, so a pathological or huge file (for example a minified 5 MB bundle) blocks the single-threaded MCP event loop for the whole synchronous `parse()`. There is also no input size cap here or in file-cache.
- `resolveSymbol(symbols, target) -> Symbol | null`, `engine.ts:234-239`
  - **What/How:** returns the first exact `qualifiedName` match, otherwise the first bare `name` match.
  - **Risks (medium, correctness):** ambiguous bare names resolve silently to the first match in file order. With `class A { save() }` and `class B { save() }`, `code_edit save` edits `A.save` without warning. An overloaded TS function (several `function_declaration`s with the same name) resolves to the first overload signature, not the implementation. No candidate list or ambiguity error is returned.

## src/ast/file-cache.ts

**Purpose:** an in-process memo that avoids re-reading and re-parsing unchanged files across tool calls. This is the source of MOZCODE's warm-call responsiveness, which `scripts/benchmark-performance.ts` measures.

- `interface FileAnalysis extends ParseResult`, `file-cache.ts:5-8`. Adds `source` and `language`.
- `CacheEntry { mtimeMs, size, source: Promise<string>, analysis?: Promise<FileAnalysis> }`, `file-cache.ts:10-15`. The entry stores promises, so concurrent callers share one in-flight read or parse.
- Module state: `files` Map, `MAX_CACHE_BYTES = 64 MiB`, and `cachedBytes` (`:17-19`).
- `remove(filePath)`, `file-cache.ts:21-26`. Deletes the entry and decrements `cachedBytes`.
- `trim(exceptPath)`, `file-cache.ts:28-33`
  - **How:** iterates the Map in insertion order (oldest first) and evicts until the total is under 64 MiB, skipping the entry it just added.
  - **Risks (low):** the budget counts only `stat.size` bytes of source. It ignores the UTF-16 string (about 2x for ASCII), the `FileAnalysis` symbols, and the leaked WASM trees. Real memory use can be several times 64 MiB. A single file above 64 MiB is still cached, because `exceptPath` is never evicted.
- `currentEntry(filePath) -> Promise<CacheEntry>`, `file-cache.ts:35-61`
  - **What:** `fs.stat` on every call. On an mtime and size match it refreshes the entry's LRU position (delete then set) and returns it. Otherwise it drops the stale entry, starts `fs.readFile(utf8)`, registers the entry, trims, awaits the read, and on a read error removes the entry and rethrows.
  - **Why:** detects external edits cheaply without file watchers (comment `:83`).
  - **Risks:**
    - (low) Staleness: an edit that keeps both size and mtime (coarse-mtime filesystems, or tools that restore mtime) is served stale.
    - (low) Stat/read race: the entry records the stat taken before the read. If the file changes in between, the cache holds the new content under the old mtime. That self-heals on the next call because the mtime then differs.
    - (low) No file-size guard before `readFile`. A `code_read` or `code_search` that hits a huge generated file loads all of it into memory.
- `readCachedSource(filePath) -> Promise<string>`, `file-cache.ts:64-66`. Used by the `code_search` grep pass for every candidate file (`search.ts:50`), so a search warms the source cache for the whole tree, up to the 64 MiB budget.
- `analyzeFile(filePath) -> Promise<FileAnalysis>`, `file-cache.ts:69-81`
  - **What/How:** lazily attaches a memoised `analysis` promise to the entry: await the source, `languageForPath`, then `extractSymbols`. An unsupported language returns empty symbols with `hasError: false`.
  - **Risks (low):** a rejected analysis promise stays cached on the entry until the file's mtime or size changes. A WASM load failure therefore persists for that file even if the loader later recovers.
- `invalidateFile(filePath)`, `file-cache.ts:84-86`. Called after `code_edit` writes (`edit.ts:39`).
- `clearFileCache()`, `file-cache.ts:89-92`. A benchmark hook that keeps the grammars loaded.

---

## Hot spots (ranked)

1. **HIGH / scale:** the WASM Parser and Tree are never freed. `parserFor` (`loader.ts:70-76`) creates a new Parser per call, and `extractSymbols` (`engine.ts:225-230`) never calls `tree.delete()` or `parser.delete()`. Every cache miss and every `code_edit` validation leaks into the non-shrinking WASM heap of a long-lived MCP server.
2. **MEDIUM / correctness:** in a multi-declarator `const`/`let`/`var`, every declarator symbol spans the whole statement (`engine.ts:141,144` pass `node`, not `decl`). `code_edit` on one name then silently rewrites its siblings.
3. **MEDIUM / correctness:** `resolveSymbol` (`engine.ts:234-239`) silently picks the first bare-name match, so methods with the same name in different classes, TS overloads, and Python nested classes can be read or edited ambiguously.
4. **MEDIUM / quality:** rejected promises are cached. `initPromise` (`loader.ts:47-52`) and `languageCache` (`:58-65`) never clear on failure, so one transient error disables AST features until restart. `entry.analysis` (`file-cache.ts:71-79`) also keeps a rejection, but only until the file's mtime/size changes or the entry is evicted (fact-check correction).
5. **MEDIUM / scale:** there is no size cap or timeout on read and parse (`file-cache.ts:49`, `engine.ts:226`). A huge or minified file blocks the single-threaded server during the synchronous `parse()`. The 64 MiB budget ignores UTF-16 doubling, symbol arrays, and WASM trees (`file-cache.ts:28-33`).
6. **LOW / correctness:** the type-alias signature is cut at the first `=`, which mangles generic defaults (`engine.ts:120-121`). Nested Python classes lose the outer qualifier (`engine.ts:190`).
7. **LOW / quality:** coverage gaps cause silent whole-file fallbacks. These include interface and abstract members, `export default` anonymous declarations, namespaces, and CommonJS `module.exports` (`engine.ts:68-150`). No unit tests cover `file-cache.ts` invalidation or eviction, or the multi-layout `assetsDir` resolution.
