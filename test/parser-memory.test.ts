import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractSymbols } from "../src/ast/engine.js";
import { parserFor } from "../src/ast/loader.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("parser memory", () => {
  it("shares one parser per language", async () => {
    expect(await parserFor("typescript")).toBe(await parserFor("typescript"));
    expect(await parserFor("python")).not.toBe(await parserFor("typescript"));
  });

  // The WASM heap never shrinks, so leaked parsers or trees show up as RSS that
  // grows with every parse (about 0.6 MB per parse of this file before the fix).
  it("does not grow memory with every parse", async () => {
    const src = readFileSync(join(here, "../src/db/schema.ts"), "utf8");
    for (let i = 0; i < 50; i++) await extractSymbols(src, "typescript");
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 400; i++) await extractSymbols(src, "typescript");
    const grownMb = (process.memoryUsage().rss - before) / 1048576;
    expect(grownMb).toBeLessThan(100);
  }, 30_000);
});
