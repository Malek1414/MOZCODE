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
  it("returns a symbol skeleton far smaller than the file", async () => {
    const r = await codeOutline(fixture("sample.ts"), "sample.ts");
    expect(r.degraded).toBe(false);
    expect(r.text).toContain("function add(a: number, b: number): number");
    expect(r.text).toContain("class Account");
    expect(r.meta.savedTokens).toBeGreaterThan(0);
    expect(r.meta.actualTokens).toBeLessThan(r.meta.baselineTokens);
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
  it("groups matches by enclosing symbol", async () => {
    const r = await codeSearch(join(here, "fixtures"), "balance");
    expect(r.text).toContain("Account");
    expect(r.meta.baselineTokens).toBeGreaterThan(0);
  });

  it("reports no matches cleanly", async () => {
    const r = await codeSearch(join(here, "fixtures"), "zzz_nonexistent_zzz");
    expect(r.text).toContain("No matches");
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
  });

  it("rejects an edit that would break the parse", async () => {
    const before = await fs.readFile(tmp, "utf8");
    const r = await codeEdit(tmp, "sample.ts", "add", "function add( {{{ broken");
    expect(r.degraded).toBe(true);
    expect(r.text).toContain("rejected");
    const after = await fs.readFile(tmp, "utf8");
    expect(after).toBe(before); // unchanged
  });
});
