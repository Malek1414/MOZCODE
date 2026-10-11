import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { codeOutline } from "../src/tools/outline.js";
import { codeRead } from "../src/tools/read.js";
import { codeSearch } from "../src/tools/search.js";
import { codeEdit } from "../src/tools/edit.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => join(here, "fixtures", f);

describe("code_outline", () => {
  it("returns a symbol skeleton that lists signatures but omits bodies", async () => {
    const r = await codeOutline(fixture("sample.ts"), "sample.ts");
    expect(r.degraded).toBe(false);
    expect(r.text).toContain("function add(a: number, b: number): number");
    expect(r.text).toContain("class Account");
    // The skeleton is signatures only — implementation bodies are dropped.
    expect(r.text).not.toContain("return a + b");
    expect(r.text).not.toContain("this.balance += amount");
  });

  it("saves tokens on a realistically-sized file", async () => {
    // The outline win is proportional to body size: on a toy file the skeleton
    // can rival the source, but on a normal file dropping bodies saves a lot.
    const fn = (i: number) =>
      `export function op${i}(a: number, b: number): number {\n` +
      `  const scratch = a * ${i} + b;\n` +
      `  let acc = 0;\n` +
      `  for (let k = 0; k < scratch; k++) acc += (k % 7) * ${i};\n` +
      `  return acc + scratch;\n}\n`;
    const p = join(tmpdir(), `mozcode-outline-${Date.now()}.ts`);
    await fs.writeFile(p, Array.from({ length: 40 }, (_, i) => fn(i)).join("\n"));
    const r = await codeOutline(p, "big.ts");
    expect(r.degraded).toBe(false);
    expect(r.meta.actualTokens).toBeLessThan(r.meta.baselineTokens);
    expect(r.meta.savedTokens).toBeGreaterThan(0);
  });

  it("degrades gracefully on an unsupported language", async () => {
    const p = join(tmpdir(), `mozcode-${Date.now()}.md`);
    await fs.writeFile(p, "# hello\n\nsome text\n");
    const r = await codeOutline(p, "note.md");
    expect(r.degraded).toBe(true);
  });
});

describe("code_read", () => {
  it("returns a single symbol with context, not the whole file", async () => {
    const r = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "add" });
    expect(r.degraded).toBe(false);
    expect(r.text).toContain("function add");
    expect(r.text).not.toContain("class Account");
    expect(r.meta.savedTokens).toBeGreaterThan(0);
  });

  it("resolves dotted method names", async () => {
    const r = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "Account.deposit" });
    expect(r.text).toContain("deposit(amount");
  });

  it("returns an outline when no symbol is given", async () => {
    const r = await codeRead(fixture("sample.ts"), "sample.ts");
    expect(r.text).toContain("outline");
  });

  it("returns available symbols on a miss (degraded)", async () => {
    const r = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "doesNotExist" });
    expect(r.degraded).toBe(true);
    expect(r.text).toContain("not found");
    expect(r.text).toContain("add");
  });
});

describe("code_search", () => {
  it("groups matches by actionable qualified symbol names", async () => {
    const r = await codeSearch(join(here, "fixtures"), "balance");
    expect(r.text).toContain("Account.constructor");
    expect(r.text).toContain("Account.deposit");
    expect(r.text).toMatch(/Account\.deposit \[method L\d+-\d+; hit L\d+\]/);
    expect(r.text).not.toContain("[top-level]");
    expect(r.meta.baselineTokens).toBeGreaterThan(0);
  });

  it("uses the match offset to recognize exported declarations", async () => {
    const r = await codeSearch(join(here, "fixtures"), "function add");
    expect(r.text).toMatch(/  add \[function L\d+-\d+; hit L\d+\]/);
    expect(r.text).not.toContain("export function add");
  });

  it("reports no matches cleanly", async () => {
    const r = await codeSearch(join(here, "fixtures"), "zzz_nonexistent_zzz");
    expect(r.text).toContain("No matches");
  });
});

describe("code_read context_lines", () => {
  it("treats string, negative and NaN values sanely", async () => {
    const asString = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "add", contextLines: "1" as unknown as number });
    const asNumber = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "add", contextLines: 1 });
    expect(asString.text).toBe(asNumber.text);
    const negative = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "add", contextLines: -5 });
    expect(negative.text).toContain("return a + b;");
    const nan = await codeRead(fixture("sample.ts"), "sample.ts", { symbol: "add", contextLines: Number.NaN });
    expect(nan.text).toContain("return a + b;");
  });
});

describe("code_edit", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = join(tmpdir(), `mozcode-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    await fs.copyFile(fixture("sample.ts"), tmp);
  });

  it("replaces a symbol in place and leaves the file parseable", async () => {
    const r = await codeEdit(tmp, "sample.ts", "add", "function add(a: number, b: number): number {\n  return a + b + 0;\n}");
    expect(r.degraded).toBe(false);
    expect(r.text).toContain("No re-read needed");
    const content = await fs.readFile(tmp, "utf8");
    expect(content).toContain("return a + b + 0;");
    expect(content).toContain("class Account"); // rest of file intact
    const reread = await codeRead(tmp, "sample.ts", { symbol: "add", contextLines: 0 });
    expect(reread.text).toContain("return a + b + 0;");
  });

  it("rejects an edit that would break the parse", async () => {
    const before = await fs.readFile(tmp, "utf8");
    const r = await codeEdit(tmp, "sample.ts", "add", "function add( {{{ broken");
    expect(r.degraded).toBe(true);
    expect(r.text).toContain("rejected");
    const after = await fs.readFile(tmp, "utf8");
    expect(after).toBe(before); // unchanged
  });
  it("accepts new_source that repeats the export modifier shown by code_read", async () => {
    const r = await codeEdit(tmp, "sample.ts", "add", "export function add(a: number, b: number): number {\n  return b + a;\n}");
    expect(r.degraded).toBe(false);
    const content = await fs.readFile(tmp, "utf8");
    expect(content).toContain("export function add(a: number, b: number): number {\n  return b + a;\n}");
    expect(content).not.toContain("export export");
  });

  it("keeps the export modifier when new_source omits it", async () => {
    const r = await codeEdit(tmp, "sample.ts", "multiply", "const multiply = (a: number, b: number): number => a * b;");
    expect(r.degraded).toBe(false);
    expect(await fs.readFile(tmp, "utf8")).toContain("export const multiply = (a: number, b: number): number => a * b;");
  });

  it("refuses an ambiguous bare name instead of editing the first match", async () => {
    await fs.writeFile(tmp, "class A {\n  run(): number { return 1; }\n}\nclass B {\n  run(): number { return 2; }\n}\n");
    const before = await fs.readFile(tmp, "utf8");
    const r = await codeEdit(tmp, "x.ts", "run", "run(): number { return 3; }");
    expect(r.degraded).toBe(true);
    expect(r.text).toContain("ambiguous");
    expect(r.text).toContain("A.run");
    expect(r.text).toContain("B.run");
    expect(await fs.readFile(tmp, "utf8")).toBe(before);
    const ok = await codeEdit(tmp, "x.ts", "B.run", "run(): number { return 3; }");
    expect(ok.degraded).toBe(false);
    expect(await fs.readFile(tmp, "utf8")).toContain("return 1;");
  });

  it("refuses to overwrite sibling declarators in one statement", async () => {
    await fs.writeFile(tmp, "const a = 1, b = 2;\nexport const c = 3;\n");
    const before = await fs.readFile(tmp, "utf8");
    const r = await codeEdit(tmp, "x.ts", "a", "const a = 10;");
    expect(r.degraded).toBe(true);
    expect(r.text).toContain("shares its declaration statement with b");
    expect(await fs.readFile(tmp, "utf8")).toBe(before);
  });
});
