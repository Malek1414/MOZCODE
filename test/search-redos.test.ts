import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeSearch } from "../src/tools/search.js";

// code_search compiles a model-supplied query and runs it on the same event
// loop that serves stdio. A backtracking engine would let one pattern freeze
// the whole server, so matching must stay linear-time.
describe("code_search regex safety", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "mozcode-redos-"));
    await fs.writeFile(
      join(root, "evil.ts"),
      [
        `export const attack = "${"a".repeat(40)}!";`,
        "export function fooBar() { return 1; }",
        "export const emoji = \"😀 needle\";",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not hang on a catastrophic-backtracking pattern", async () => {
    // V8's RegExp needs minutes for (a+)+$ against 40 a's plus '!'.
    const started = Date.now();
    const r = await codeSearch(root, "(a+)+$");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.text).toMatch(/No matches/);
  });

  it("still supports ordinary regex syntax", async () => {
    const r = await codeSearch(root, "foo\\w+\\(\\)");
    expect(r.text).toContain("fooBar");
  });

  it("reports match offsets in UTF-16 units, so hits group under the right symbol", async () => {
    const r = await codeSearch(root, "needle");
    expect(r.text).toContain("emoji");
  });

  it("searches lookaround and backreference queries as literals and says so", async () => {
    const r = await codeSearch(root, "(?=foo)foo");
    expect(r.text).toMatch(/No matches/);
    expect(r.text).toMatch(/searched as a literal string/);
  });

  it("keeps treating an invalid regex as a literal", async () => {
    const r = await codeSearch(root, "fooBar(");
    expect(r.text).toContain("fooBar");
    expect(r.text).not.toMatch(/searched as a literal string/);
  });
});
