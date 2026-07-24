import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractSymbols, resolveSymbol } from "../src/ast/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, "fixtures", f), "utf8");

describe("TypeScript extraction", () => {
  const src = read("sample.ts");

  it("finds top-level functions, classes, interfaces, types, consts", async () => {
    const { symbols, hasError } = await extractSymbols(src, "typescript");
    expect(hasError).toBe(false);
    const byName = (n: string) => symbols.find((s) => s.qualifiedName === n);

    expect(byName("add")?.kind).toBe("function");
    expect(byName("add")?.signature).toBe("function add(a: number, b: number): number");
    expect(byName("multiply")?.kind).toBe("function");
    expect(byName("Account")?.kind).toBe("class");
    expect(byName("User")?.kind).toBe("interface");
    expect(byName("UserId")?.kind).toBe("type");
    expect(byName("GREETING")?.kind).toBe("const");
    expect(byName("loadConfig")?.kind).toBe("function");
  });

  it("finds class methods with qualified names", async () => {
    const { symbols } = await extractSymbols(src, "typescript");
    const deposit = symbols.find((s) => s.qualifiedName === "Account.deposit");
    expect(deposit?.kind).toBe("method");
    expect(deposit?.container).toBe("Account");
    expect(deposit?.signature).toContain("deposit(amount: number)");
  });

  it("gives byte spans that slice back to the original source", async () => {
    const { symbols } = await extractSymbols(src, "typescript");
    const add = resolveSymbol(symbols, "add")!;
    const slice = src.slice(add.startIndex, add.endIndex);
    expect(slice.startsWith("function add")).toBe(true);
    expect(slice.trimEnd().endsWith("}")).toBe(true);
  });

  it("resolves dotted and bare symbol names", async () => {
    const { symbols } = await extractSymbols(src, "typescript");
    expect(resolveSymbol(symbols, "Account.deposit")?.name).toBe("deposit");
    expect(resolveSymbol(symbols, "deposit")?.container).toBe("Account");
    expect(resolveSymbol(symbols, "nope")).toBeNull();
  });
});

describe("Python extraction", () => {
  const src = read("sample.py");

  it("finds functions, classes, methods, and module constants", async () => {
    const { symbols, hasError } = await extractSymbols(src, "python");
    expect(hasError).toBe(false);
    const byName = (n: string) => symbols.find((s) => s.qualifiedName === n);

    expect(byName("add")?.kind).toBe("function");
    expect(byName("Account")?.kind).toBe("class");
    expect(byName("Account.deposit")?.kind).toBe("method");
    expect(byName("Account.is_empty")?.kind).toBe("method"); // decorated
    expect(byName("load_config")?.kind).toBe("function");
    expect(byName("GREETING")?.kind).toBe("variable");
  });

  it("captures decorators in the method span", async () => {
    const { symbols } = await extractSymbols(src, "python");
    const isEmpty = resolveSymbol(symbols, "is_empty")!;
    const slice = src.slice(isEmpty.startIndex, isEmpty.endIndex);
    expect(slice.startsWith("@property")).toBe(true);
  });
});

describe("error handling", () => {
  it("flags syntax errors without throwing", async () => {
    const { hasError } = await extractSymbols("function broken( {", "typescript");
    expect(hasError).toBe(true);
  });
});
