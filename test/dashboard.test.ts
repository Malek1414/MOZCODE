import { describe, it, expect } from "vitest";
import { renderDashboard } from "../src/dashboard/render.js";
import { summarize, type MeteringEntry } from "../src/metering/store.js";
import { computeMetrics } from "../src/dashboard/metrics.js";

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

const dataset = [
  entry({}),
  entry({ ts: "2026-07-25T10:00:00.000Z", tool: "code_outline", path: "src/b.ts", baselineTokens: 800, actualTokens: 200, savedTokens: 600 }),
  entry({ tool: "code_search", path: undefined, baselineTokens: 300, actualTokens: 60, savedTokens: 240, session: "sess-def456" }),
  entry({ tool: "code_edit", path: "src/a.ts", baselineTokens: 1200, actualTokens: 40, savedTokens: 1160 }),
];

describe("six-metric dashboard renderer", () => {
  it("renders all six KPI labels", () => {
    const html = renderDashboard(summarize(dataset));
    for (const label of ["Tokens saved", "Cost saved", "Time saved", "LLM calls saved", "API cost saved", "Efficiency gain"]) {
      expect(html).toContain(label);
    }
  });

  it("embeds the Saira font and MOZCODE brand", () => {
    const html = renderDashboard(summarize(dataset));
    expect(html).toContain("@font-face");
    expect(html).toContain("'Saira'");
    expect(html).toContain("MOZCODE");
  });

  it("shows the estimate disclaimer and auditable assumptions", () => {
    const html = renderDashboard(summarize(dataset));
    expect(html).toContain("All figures are estimates");
    expect(html).toContain("assumptions");
    expect(html).toContain("$3.00"); // input price assumption surfaced
  });

  it("renders the efficiency gauge and a sparkline", () => {
    const html = renderDashboard(summarize(dataset));
    expect(html).toContain('class="gauge"');
    expect(html).toContain('class="spark"');
  });

  it("handles an empty dataset without crashing", () => {
    const html = renderDashboard(summarize([]));
    expect(html).toContain("No data yet.");
    expect(html).toContain("No sessions recorded yet.");
  });
});

describe("metric derivations", () => {
  it("derives cost, calls, and time from tokens with stated assumptions", () => {
    const m = computeMetrics(summarize(dataset), []);
    expect(m.tokensSaved).toBe(900 + 600 + 240 + 1160);
    // 1 edit + 0.5 * 1 search = 1.5 -> rounds to 2 (banker? Math.round(1.5)=2)
    expect(m.callsSaved).toBe(2);
    expect(m.apiCostSaved).toBeGreaterThan(0);
    expect(m.costSaved).toBeGreaterThanOrEqual(m.apiCostSaved);
    expect(m.timeSavedSec).toBeGreaterThan(0);
    expect(m.efficiencyGainPct).toBeGreaterThan(80);
  });
});
