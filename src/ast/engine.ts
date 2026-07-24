import type { Node } from "web-tree-sitter";
import { parserFor } from "./loader.js";
import { type LanguageId } from "./languages.js";

export interface Symbol {
  /** Bare name, e.g. "deposit". */
  name: string;
  /** Dotted path including container, e.g. "Account.deposit". */
  qualifiedName: string;
  /** function | method | class | interface | type | enum | field | const | variable */
  kind: string;
  /** Declaration head without the body, e.g. "function add(a: number, b: number): number". */
  signature: string;
  /** UTF-16 offsets into the source (JS slice-compatible). */
  startIndex: number;
  endIndex: number;
  /** 1-based line numbers. */
  startLine: number;
  endLine: number;
  /** Nesting depth (0 = top level). */
  depth: number;
  /** Container qualifier, e.g. "Account", or null at top level. */
  container: string | null;
}

/** Collapse a declaration node to its head (drop the body). */
function signatureOf(node: Node, source: string, bodyStart?: number): string {
  const end = bodyStart ?? node.childForFieldName("body")?.startIndex ?? node.endIndex;
  let sig = source.slice(node.startIndex, end).trim();
  // Collapse whitespace/newlines in multi-line signatures.
  sig = sig.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
  // Drop a trailing "{" or "=>" left dangling.
  sig = sig.replace(/\s*(\{|=>)\s*$/, "").trim();
  return sig;
}

function nameFromField(node: Node): string | null {
  const n = node.childForFieldName("name");
  return n ? n.text : null;
}

function mkSymbol(
  node: Node,
  name: string,
  kind: string,
  signature: string,
  container: string | null,
  depth: number,
): Symbol {
  return {
    name,
    qualifiedName: container ? `${container}.${name}` : name,
    kind,
    signature,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    depth,
    container,
  };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript / TSX
// ---------------------------------------------------------------------------

function walkTsMembers(
  classBody: Node,
  source: string,
  className: string,
  out: Symbol[],
): void {
  for (const child of classBody.namedChildren) {
    if (!child) continue;
    if (child.type === "method_definition") {
      const name = nameFromField(child);
      if (name) out.push(mkSymbol(child, name, "method", signatureOf(child, source), className, 1));
    } else if (child.type === "public_field_definition") {
      const name = nameFromField(child);
      if (!name) continue;
      const value = child.childForFieldName("value");
      const isFn = value && (value.type === "arrow_function" || value.type === "function_expression");
      const sig = isFn && value ? signatureOf(child, source, value.childForFieldName("body")?.startIndex) : source.slice(child.startIndex, child.endIndex).replace(/\s*\n[\s\S]*$/, "").trim();
      out.push(mkSymbol(child, name, isFn ? "method" : "field", sig, className, 1));
    }
  }
}

function handleTsNode(node: Node, source: string, out: Symbol[]): void {
  switch (node.type) {
    case "export_statement":
    case "ambient_declaration": {
      for (const child of node.namedChildren) if (child) handleTsNode(child, source, out);
      return;
    }
    case "function_declaration":
    case "generator_function_declaration": {
      const name = nameFromField(node);
      if (name) out.push(mkSymbol(node, name, "function", signatureOf(node, source), null, 0));
      return;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = nameFromField(node);
      if (!name) return;
      out.push(mkSymbol(node, name, "class", signatureOf(node, source), null, 0));
      const body = node.childForFieldName("body");
      if (body) walkTsMembers(body, source, name, out);
      return;
    }
    case "interface_declaration": {
      const name = nameFromField(node);
      if (name) out.push(mkSymbol(node, name, "interface", signatureOf(node, source), null, 0));
      return;
    }
    case "type_alias_declaration": {
      const name = nameFromField(node);
      if (name) {
        const eq = source.indexOf("=", node.startIndex);
        const sig = source.slice(node.startIndex, eq > -1 ? eq : node.endIndex).trim();
        out.push(mkSymbol(node, name, "type", sig, null, 0));
      }
      return;
    }
    case "enum_declaration": {
      const name = nameFromField(node);
      if (name) out.push(mkSymbol(node, name, "enum", signatureOf(node, source), null, 0));
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      for (const decl of node.namedChildren) {
        if (!decl || decl.type !== "variable_declarator") continue;
        const name = nameFromField(decl);
        if (!name) continue;
        const value = decl.childForFieldName("value");
        const isFn = value && (value.type === "arrow_function" || value.type === "function_expression");
        if (isFn && value) {
          const sig = signatureOf(node, source, value.childForFieldName("body")?.startIndex);
          out.push(mkSymbol(node, name, "function", sig, null, 0));
        } else {
          const line = source.slice(node.startIndex, node.endIndex).split("\n")[0].replace(/;?\s*$/, "").trim();
          out.push(mkSymbol(node, name, "const", line, null, 0));
        }
      }
      return;
    }
  }
}

function extractTs(root: Node, source: string): Symbol[] {
  const out: Symbol[] = [];
  for (const child of root.namedChildren) if (child) handleTsNode(child, source, out);
  return out;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pySignature(node: Node, source: string): string {
  // For def/class, head runs up to the ":" that precedes the body block.
  const body = node.childForFieldName("body");
  const end = body ? source.lastIndexOf(":", body.startIndex) : node.endIndex;
  let sig = source.slice(node.startIndex, end > node.startIndex ? end : node.endIndex).trim();
  sig = sig.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
  return sig;
}

function handlePyNode(node: Node, source: string, out: Symbol[], container: string | null, depth: number, spanNode?: Node): void {
  switch (node.type) {
    case "decorated_definition": {
      // Keep the outer span (includes decorators) but name/kind from the inner def.
      const def = node.childForFieldName("definition");
      if (!def) return;
      handlePyNode(def, source, out, container, depth, node);
      return;
    }
    case "function_definition": {
      const name = nameFromField(node);
      if (name) out.push(mkSymbol(spanNode ?? node, name, container ? "method" : "function", pySignature(node, source), container, depth));
      return;
    }
    case "class_definition": {
      const name = nameFromField(node);
      if (!name) return;
      out.push(mkSymbol(spanNode ?? node, name, "class", pySignature(node, source), container, depth));
      const body = node.childForFieldName("body");
      if (body) for (const child of body.namedChildren) if (child) handlePyNode(child, source, out, name, depth + 1);
      return;
    }
    case "expression_statement": {
      // Top-level module constant: NAME = value
      if (depth !== 0) return;
      const assign = node.namedChildren[0];
      if (assign && assign.type === "assignment") {
        const target = assign.childForFieldName("left");
        if (target && target.type === "identifier") {
          const line = source.slice(node.startIndex, node.endIndex).split("\n")[0].trim();
          out.push(mkSymbol(node, target.text, "variable", line, null, 0));
        }
      }
      return;
    }
  }
}

function extractPy(root: Node, source: string): Symbol[] {
  const out: Symbol[] = [];
  for (const child of root.namedChildren) if (child) handlePyNode(child, source, out, null, 0);
  return out;
}

// ---------------------------------------------------------------------------

export interface ParseResult {
  symbols: Symbol[];
  /** True when the source contains a syntax error. */
  hasError: boolean;
}

/** Parse source and extract its top-level and member symbols. */
export async function extractSymbols(source: string, language: LanguageId): Promise<ParseResult> {
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  if (!tree) return { symbols: [], hasError: true };
  const root = tree.rootNode;
  const symbols = language === "python" ? extractPy(root, source) : extractTs(root, source);
  return { symbols, hasError: root.hasError };
}

/** Resolve a symbol by bare name or dotted qualified name. */
export function resolveSymbol(symbols: Symbol[], target: string): Symbol | null {
  const exact = symbols.find((s) => s.qualifiedName === target);
  if (exact) return exact;
  const bare = symbols.find((s) => s.name === target);
  return bare ?? null;
}
