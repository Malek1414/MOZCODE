import type { MeteringEntry, Summary } from "../metering/store.js";

/**
 * Assumptions used to derive dollar/time/call metrics from the one thing MOZCODE
 * measures directly (input tokens not sent). Every constant is surfaced in the
 * dashboard footnote so the numbers are auditable, and all derived figures are
 * ESTIMATES against a counterfactual — never a billing statement.
 */
export interface MetricAssumptions {
  /** USD per 1M input tokens (blended Claude input rate). */
  inputPricePerM: number;
  /** USD of output/overhead saved per avoided model round-trip. */
  costPerAvoidedCall: number;
  /** Seconds of latency per avoided model round-trip. */
  latencyPerCallS: number;
  /** Seconds of prompt prefill saved per 1k input tokens not sent. */
  prefillSecPer1k: number;
  /** Fraction of a search that would otherwise have been a separate round-trip. */
  searchCallFactor: number;
  /** Exploratory DB turns avoided by one whole-schema call. */
  dbCallsAvoidedPerSchema: number;
}

export const DEFAULT_ASSUMPTIONS: MetricAssumptions = {
  inputPricePerM: 3.0,
  costPerAvoidedCall: 0.004,
  latencyPerCallS: 3.5,
  prefillSecPer1k: 0.05,
  searchCallFactor: 0.5,
  dbCallsAvoidedPerSchema: 9,
};

export interface KpiMetrics {
  tokensSaved: number;
  apiCostSaved: number; // direct $ of un-sent input tokens
  costSaved: number; // api cost + output/overhead of avoided round-trips
  callsSaved: number; // model round-trips avoided
  timeSavedSec: number;
  efficiencyGainPct: number; // avg payload reduction vs. naive baseline
  /** Cumulative tokens-saved series for sparklines / area (by day). */
  cumulativeByDay: { day: string; cumulative: number }[];
  assumptions: MetricAssumptions;
}

export function computeMetrics(
  summary: Summary,
  _entries: MeteringEntry[],
  a: MetricAssumptions = DEFAULT_ASSUMPTIONS,
): KpiMetrics {
  const tokensSaved = summary.totalSaved;
  const editCalls = summary.byTool.find((t) => t.tool === "code_edit")?.calls ?? 0;
  const searchCalls = summary.byTool.find((t) => t.tool === "code_search")?.calls ?? 0;
  const dbSchemaCalls = summary.byTool.find((t) => t.tool === "db_schema")?.calls ?? 0;

  // Round-trips avoided: each AST-anchored edit avoids a re-read; each search
  // consolidates file-opening turns; each schema map replaces iterative discovery.
  const callsSaved = Math.round(
    editCalls + searchCalls * a.searchCallFactor + dbSchemaCalls * a.dbCallsAvoidedPerSchema,
  );

  const apiCostSaved = (tokensSaved / 1_000_000) * a.inputPricePerM;
  const costSaved = apiCostSaved + callsSaved * a.costPerAvoidedCall;
  const timeSavedSec = callsSaved * a.latencyPerCallS + (tokensSaved / 1000) * a.prefillSecPer1k;

  let cum = 0;
  const cumulativeByDay = summary.byDay.map((d) => ({ day: d.day, cumulative: (cum += d.saved) }));

  return {
    tokensSaved,
    apiCostSaved,
    costSaved,
    callsSaved,
    timeSavedSec,
    efficiencyGainPct: summary.avgReductionPct,
    cumulativeByDay,
    assumptions: a,
  };
}

/** Format seconds as "1h 12m", "3m 20s", or "45s". */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Format USD: $0.0123 for small, $12.34 otherwise. */
export function fmtUsd(v: number): string {
  if (v > 0 && v < 1) return `$${v.toFixed(v < 0.01 ? 4 : 3)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
