import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/ast/engine.js");
});

describe("file cache", () => {
  it("retries analysis after a transient failure instead of caching the rejection", async () => {
    const real = await vi.importActual<typeof import("../src/ast/engine.js")>("../src/ast/engine.js");
    let calls = 0;
    vi.doMock("../src/ast/engine.js", () => ({
      ...real,
      extractSymbols: async (...args: Parameters<typeof real.extractSymbols>) => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return real.extractSymbols(...args);
      },
    }));
    const { analyzeFile } = await import("../src/ast/file-cache.js");
    const p = join(tmpdir(), `mozcode-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    await fs.writeFile(p, "export function f() { return 1; }\n");
    try {
      await expect(analyzeFile(p)).rejects.toThrow("transient");
      const ok = await analyzeFile(p);
      expect(ok.symbols.map((s) => s.name)).toContain("f");
    } finally {
      await fs.rm(p, { force: true });
    }
  });

  it("counts source tokens once per file version", async () => {
    const { analyzeFile, sourceTokensOf } = await import("../src/ast/file-cache.js");
    const { estimateTokens } = await import("../src/util/tokens.js");
    const p = join(tmpdir(), `mozcode-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    await fs.writeFile(p, "export const a = 1;\n");
    try {
      const first = await analyzeFile(p);
      expect(sourceTokensOf(first)).toBe(estimateTokens(first.source));
      expect(await analyzeFile(p)).toBe(first); // same version, same key
      await fs.writeFile(p, "export const a = 1;\nexport function longerName(x: number) { return x * 2; }\n");
      const second = await analyzeFile(p);
      expect(second).not.toBe(first);
      expect(sourceTokensOf(second)).toBe(estimateTokens(second.source));
      expect(sourceTokensOf(second)).toBeGreaterThan(sourceTokensOf(first));
    } finally {
      await fs.rm(p, { force: true });
    }
  });
});
