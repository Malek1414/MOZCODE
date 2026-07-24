import { describe, it, expect } from "vitest";
import { renderDashboard } from "../src/dashboard/render.js";
import { summarize, type MeteringEntry } from "../src/metering/store.js";

function entry(over: Partial<MeteringEntry>): MeteringEntry {
  return {
    ts: "2026-07-24T10:00:00.000Z",
    session: "sess-abc123",
    project: "/proj/a",
    tool: "code_read",
    path: "src/a.ts",
    baselineTokens: 1000,
    actualTokens: 100,
    savedTokens: 900,
    ...over,
  };
}

describe("dashboard renderer", () => {
  it("renders stat tiles, charts, and the estimate disclaimer", () => {
    const s = summarize([
      entry({}),
      entry({ ts: "2026-07-25T10:00:00.000Z", tool: "code_outline", path: "src/b.ts", baselineTokens: 800, actualTokens: 200, savedTokens: 600 }),
      entry({ tool: "code_search", path: undefined, baselineTokens: 300, actualTokens: 60, savedTokens: 240, session: "sess-def456" }),
    ]);
    const html = renderDashboard(s);
    expect(html).toContain("Terse — savings dashboard");
    expect(html).toContain("estimates");
    expect(html).toContain("Savings by tool");
    expect(html).toContain("code_read");
    expect(html).toContain("<svg");
    expect(html).toContain("var(--series-1)");
    // top file bar present
    expect(html).toContain("src/a.ts");
  });

  it("handles an empty dataset without crashing", () => {
    const html = renderDashboard(summarize([]));
    expect(html).toContain("No data yet.");
    expect(html).toContain("No sessions recorded yet.");
  });
});
