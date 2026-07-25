import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record, loadEntries, summarize } from "../src/metering/store.js";
import { makeMeta } from "../src/tools/types.js";

describe("metering store", () => {
  let home: string;
  beforeEach(async () => {
    home = join(tmpdir(), `mozcode-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.MOZCODE_HOME = home;
  });
  afterEach(async () => {
    delete process.env.MOZCODE_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("records and reads back savings entries", async () => {
    await record("/proj/a", "sess1", makeMeta("code_read", "a.ts", 1000, 100));
    await record("/proj/a", "sess1", makeMeta("code_outline", "b.ts", 800, 200));
    const entries = await loadEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].savedTokens).toBe(900);
  });

  it("summarizes totals, tools, files, and sessions", async () => {
    await record("/proj/a", "s1", makeMeta("code_read", "a.ts", 1000, 100));
    await record("/proj/a", "s2", makeMeta("code_read", "a.ts", 500, 50));
    await record("/proj/b", "s2", makeMeta("code_search", undefined, 300, 60));

    const s = summarize(await loadEntries());
    expect(s.calls).toBe(3);
    expect(s.totalSaved).toBe(900 + 450 + 240);
    expect(s.projects).toBe(2);
    expect(s.byTool.find((t) => t.tool === "code_read")?.calls).toBe(2);
    expect(s.byFile[0].path).toBe("a.ts");
    expect(s.byFile[0].saved).toBe(1350);
    expect(s.avgReductionPct).toBeGreaterThan(80);
  });
});
