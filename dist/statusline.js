#!/usr/bin/env node
import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// src/metering/store.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
function mozcodeHome() {
  return process.env.MOZCODE_HOME || path.join(os.homedir(), ".mozcode");
}
function meteringDir() {
  return path.join(mozcodeHome(), "metering");
}
function sessionsDir() {
  return path.join(mozcodeHome(), "sessions");
}
function sessionPointerFile(project) {
  const hash = crypto.createHash("sha1").update(project).digest("hex").slice(0, 12);
  return path.join(sessionsDir(), `${hash}.session`);
}
async function readCurrentSession(project) {
  try {
    const s = (await fs.readFile(sessionPointerFile(project), "utf8")).trim();
    return s || void 0;
  } catch {
    return void 0;
  }
}
async function loadEntries() {
  const dir = meteringDir();
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
  }
  return out;
}
function summarize(entries, topFiles = 15) {
  const byTool = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const byFile = /* @__PURE__ */ new Map();
  const bySession = /* @__PURE__ */ new Map();
  const projects = /* @__PURE__ */ new Set();
  let totalBaseline = 0;
  let totalActual = 0;
  let totalSaved = 0;
  for (const e of entries) {
    totalBaseline += e.baselineTokens;
    totalActual += e.actualTokens;
    totalSaved += e.savedTokens;
    projects.add(e.project);
    const t = byTool.get(e.tool) ?? { calls: 0, saved: 0 };
    t.calls += 1;
    t.saved += e.savedTokens;
    byTool.set(e.tool, t);
    const day = e.ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + e.savedTokens);
    if (e.path) {
      const f = byFile.get(e.path) ?? { calls: 0, saved: 0 };
      f.calls += 1;
      f.saved += e.savedTokens;
      byFile.set(e.path, f);
    }
    const s = bySession.get(e.session) ?? { calls: 0, baseline: 0, actual: 0, saved: 0 };
    s.calls += 1;
    s.baseline += e.baselineTokens;
    s.actual += e.actualTokens;
    s.saved += e.savedTokens;
    bySession.set(e.session, s);
  }
  return {
    calls: entries.length,
    totalBaseline,
    totalActual,
    totalSaved,
    avgReductionPct: totalBaseline > 0 ? totalSaved / totalBaseline * 100 : 0,
    projects: projects.size,
    byTool: [...byTool.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.saved - a.saved),
    byDay: [...byDay.entries()].map(([day, saved]) => ({ day, saved })).sort((a, b) => a.day.localeCompare(b.day)),
    byFile: [...byFile.entries()].map(([path2, v]) => ({ path: path2, ...v })).sort((a, b) => b.saved - a.saved).slice(0, topFiles),
    bySession: [...bySession.entries()].map(([session, v]) => ({ session, ...v })).sort((a, b) => b.saved - a.saved)
  };
}

// src/dashboard/metrics.ts
var DEFAULT_ASSUMPTIONS = {
  inputPricePerM: 3,
  costPerAvoidedCall: 4e-3,
  latencyPerCallS: 3.5,
  prefillSecPer1k: 0.05,
  searchCallFactor: 0.5,
  dbCallsAvoidedPerSchema: 9
};
function computeMetrics(summary, _entries, a = DEFAULT_ASSUMPTIONS) {
  const tokensSaved = summary.totalSaved;
  const editCalls = summary.byTool.find((t) => t.tool === "code_edit")?.calls ?? 0;
  const searchCalls = summary.byTool.find((t) => t.tool === "code_search")?.calls ?? 0;
  const dbSchemaCalls = summary.byTool.find((t) => t.tool === "db_schema")?.calls ?? 0;
  const callsSaved = Math.round(
    editCalls + searchCalls * a.searchCallFactor + dbSchemaCalls * a.dbCallsAvoidedPerSchema
  );
  const apiCostSaved = tokensSaved / 1e6 * a.inputPricePerM;
  const costSaved = apiCostSaved + callsSaved * a.costPerAvoidedCall;
  const timeSavedSec = callsSaved * a.latencyPerCallS + tokensSaved / 1e3 * a.prefillSecPer1k;
  let cum = 0;
  const cumulativeByDay = summary.byDay.map((d) => ({ day: d.day, cumulative: cum += d.saved }));
  return {
    tokensSaved,
    apiCostSaved,
    costSaved,
    callsSaved,
    timeSavedSec,
    efficiencyGainPct: summary.avgReductionPct,
    cumulativeByDay,
    assumptions: a
  };
}
function fmtDuration(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round(sec % 3600 / 60);
  return `${h}h ${m}m`;
}
function fmtUsd(v) {
  if (v > 0 && v < 1) return `$${v.toFixed(v < 0.01 ? 4 : 3)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// src/statusline.ts
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => data += c);
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 500);
  });
}
var BLUE = "\x1B[38;2;91;145;255m";
var RESET = "\x1B[0m";
var blue = (s) => `${BLUE}${s}${RESET}`;
function compact(n) {
  if (n < 1e3) return `${Math.round(n)}`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}
function segment(entries) {
  const m = computeMetrics(summarize(entries), entries);
  return `${fmtUsd(m.costSaved)} \xB7 ${compact(m.tokensSaved)} tokens \xB7 ${fmtDuration(
    m.timeSavedSec
  )} \xB7 ${m.callsSaved} roundtrips`;
}
async function main() {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(await readStdin() || "{}");
    cwd = input.cwd || input.workspace?.current_dir || cwd;
  } catch {
  }
  const all = await loadEntries();
  const forProject = all.filter((e) => e.project === cwd);
  let sessionId = await readCurrentSession(cwd);
  if (!sessionId && forProject.length) {
    sessionId = forProject.reduce((a, b) => a.ts >= b.ts ? a : b).session;
  }
  const sessionEntries = sessionId ? forProject.filter((e) => e.session === sessionId) : [];
  const line = `\u26A1 MOZCODE est. session: ${segment(sessionEntries)}  \u2502  all-time: ${segment(all)}`;
  process.stdout.write(blue(line));
}
main().catch(() => {
  process.stdout.write(blue("\u26A1 MOZCODE est. session: $0.00 \xB7 0 tokens \xB7 0s \xB7 0 roundtrips"));
});
