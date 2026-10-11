import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchesGlob } from "../src/util/files.js";
import { codeSearch } from "../src/tools/search.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("matchesGlob", () => {
  it("matches project-relative globs", () => {
    expect(matchesGlob("src/tools/read.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/server.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/tools/read.ts", "src/tools/*.ts")).toBe(true);
    expect(matchesGlob("src/tools/read.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("test/tools.test.ts", "src/**/*.ts")).toBe(false);
  });

  it("matches a slash-free glob against the basename at any depth", () => {
    expect(matchesGlob("src/tools/read.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/tools/read.ts", "*.py")).toBe(false);
    expect(matchesGlob("src/tools/read.ts", "re?d.ts")).toBe(true);
  });

  it("does not over-match by suffix", () => {
    expect(matchesGlob("src/tools/read.ts", "ad.ts")).toBe(false);
    expect(matchesGlob("src/tools/read.ts", "src/tools/read.ts")).toBe(true);
  });

  it("treats a wildcard-free directory as a prefix", () => {
    expect(matchesGlob("src/tools/read.ts", "src/tools")).toBe(true);
    expect(matchesGlob("src/toolsx/read.ts", "src/tools")).toBe(false);
  });
});

describe("code_search path_glob", () => {
  it("restricts the search with a project-relative glob", async () => {
    const r = await codeSearch(root, "export async function codeSearch", "src/**/*.ts");
    expect(r.text).toContain("src/tools/search.ts");
    const none = await codeSearch(root, "export async function codeSearch", "scripts/**/*.ts");
    expect(none.text).toContain("No matches");
  });
});
