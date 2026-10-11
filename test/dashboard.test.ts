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
  entry({ tool: "db_schema", path: "app.sqlite", baselineTokens: 2000, actualTokens: 500, savedTokens: 1500 }),
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

  it("renders the responsive activity views and accessible controls", () => {
    const html = renderDashboard(summarize(dataset));
    expect(html).toContain("Top optimized files");
    expect(html).toContain("Session ledger");
    expect(html).toContain('aria-label="Toggle color theme"');
    expect(html).toContain('aria-label="Cumulative tokens saved by day"');
  });

  it("escapes every ledger-derived string (paths, tools, sessions, timestamps)", () => {
    // The ledger is a plain JSONL file; a tampered or hostile line must not be
    // able to inject markup into the dashboard opened in the user's browser.
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderDashboard(summarize([
      ...dataset,
      entry({ path: `src/${evil}.ts`, session: evil, project: `/p/${evil}` }),
      entry({ tool: evil, path: evil }),
      entry({ ts: "<b>x</b><img src=x onerror=alert(1)>" }),
    ]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x");
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
    expect(m.tokensSaved).toBe(900 + 600 + 240 + 1160 + 1500);
    // 1 edit + 0.5 * 1 search + 9 avoided DB discovery turns = 10.5 -> 11.
    expect(m.callsSaved).toBe(11);
    expect(m.apiCostSaved).toBeGreaterThan(0);
    expect(m.costSaved).toBeGreaterThanOrEqual(m.apiCostSaved);
    expect(m.timeSavedSec).toBeGreaterThan(0);
    expect(m.efficiencyGainPct).toBeGreaterThan(80);
  });

  it("does not count failed edits or empty searches as avoided round-trips", () => {
    const failed = [
      entry({ tool: "code_edit", baselineTokens: 0, actualTokens: 40, savedTokens: 0 }),
      entry({ tool: "code_edit", baselineTokens: 0, actualTokens: 35, savedTokens: 0 }),
      entry({ tool: "code_search", path: undefined, baselineTokens: 1, actualTokens: 10, savedTokens: 0 }),
      entry({ tool: "db_schema", baselineTokens: 0, actualTokens: 30, savedTokens: 0 }),
    ];
    expect(computeMetrics(summarize([...dataset, ...failed]), []).callsSaved).toBe(11);
    const none = computeMetrics(summarize(failed), []);
    expect(none.callsSaved).toBe(0);
    expect(none.costSaved).toBe(0);
    expect(none.timeSavedSec).toBe(0);
  });
});

describe("openInBrowser", () => {
  it("survives a missing opener binary instead of crashing the server", async () => {
    const { openInBrowser } = await import("../src/dashboard/generate.js");
    const savedPath = process.env.PATH;
    let uncaught: unknown;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on("uncaughtException", onUncaught);
    try {
      process.env.PATH = "/nonexistent-mozcode-bin";
      openInBrowser("/nonexistent/dashboard.html");
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.env.PATH = savedPath;
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toBeUndefined();
  });
});

describe("fmtDuration", () => {
  it("carries rounding into the next unit", async () => {
    const { fmtDuration } = await import("../src/dashboard/metrics.js");
    expect(fmtDuration(45.2)).toBe("45s");
    expect(fmtDuration(59.6)).toBe("1m 0s");
    expect(fmtDuration(119.6)).toBe("2m 0s");
    expect(fmtDuration(200)).toBe("3m 20s");
    expect(fmtDuration(3599.7)).toBe("1h 0m");
    expect(fmtDuration(7170)).toBe("2h 0m");
    expect(fmtDuration(4320)).toBe("1h 12m");
  });
});
