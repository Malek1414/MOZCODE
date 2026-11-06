import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeSearch, compileQuery } from "../src/tools/search.js";

// code_search skips the regex for lines missing a substring every match must
// contain. Escapes whose arguments look like text (\x41, \pL, \101, \Q..\E)
// must never be read as that text, or real matches silently disappear.
describe("code_search literal prefilter", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "mozcode-prefilter-"));
    await fs.writeFile(join(root, "a.ts"), ["export const Alpha = 1;", "export const café = 2;"].join("\n"));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    "\\x41lpha",
    "\\x{41}lpha",
    "caf\\x{e9}",
    "\\pLlpha",
    "\\p{Lu}lpha",
    "\\101lpha",
    "\\QAlpha\\E",
    "(?i)ALPHA",
    "Alph[a]",
    "Al(p)ha",
  ])("still finds the line for %s", async (query) => {
    const r = await codeSearch(root, query);
    expect(r.text).toMatch(/^1 match for /);
  });

  it("extracts a required literal only when it is plain text", () => {
    expect(compileQuery("export async function \\w+").requiredLiteral).toBe("export async function ");
    expect(compileQuery("\\.then\\(").requiredLiteral).toBe(".then(");
    expect(compileQuery("abc|def").requiredLiteral).toBeUndefined();
    expect(compileQuery("\\x41lpha").requiredLiteral).toBeUndefined();
    expect(compileQuery("(?i)alpha").requiredLiteral).toBeUndefined();
  });
});
