import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("hooks.json", () => {
  it("re-injects the SessionStart nudge after /clear and compaction", () => {
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    const matcher: string = hooks.hooks.SessionStart[0].matcher;
    const sources = matcher.split("|");
    for (const source of ["startup", "resume", "clear", "compact"]) expect(sources).toContain(source);
  });
});
