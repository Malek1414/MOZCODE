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
var PRIVATE_DIR_MODE = 448;
var PRIVATE_FILE_MODE = 384;
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
function isMeteringEntry(v) {
  if (!v || typeof v !== "object") return false;
  const e = v;
  return typeof e.ts === "string" && typeof e.session === "string" && typeof e.project === "string" && typeof e.tool === "string" && (e.path === void 0 || typeof e.path === "string") && Number.isFinite(e.baselineTokens) && Number.isFinite(e.actualTokens) && Number.isFinite(e.savedTokens);
}

// src/metering/rollup.ts
import { promises as fs2 } from "node:fs";
import * as path2 from "node:path";
var VERSION = 1;
function rollupPath() {
  return path2.join(mozcodeHome(), "cache", "statusline-rollup.json");
}
function emptyTotals() {
  return { calls: 0, baseline: 0, actual: 0, saved: 0, tools: {} };
}
function addEntry(t, e) {
  t.calls += 1;
  t.baseline += e.baselineTokens;
  t.actual += e.actualTokens;
  t.saved += e.savedTokens;
  const tool = t.tools[e.tool] ??= [0, 0, 0];
  tool[0] += 1;
  if (e.savedTokens > 0) tool[1] += 1;
  tool[2] += e.savedTokens;
}
function mergeTotals(into, from) {
  into.calls += from.calls;
  into.baseline += from.baseline;
  into.actual += from.actual;
  into.saved += from.saved;
  for (const [tool, [calls, saving, saved]] of Object.entries(from.tools)) {
    const t = into.tools[tool] ??= [0, 0, 0];
    t[0] += calls;
    t[1] += saving;
    t[2] += saved;
  }
  return into;
}
function totalsToSummary(t, projects = 0) {
  return {
    calls: t.calls,
    totalBaseline: t.baseline,
    totalActual: t.actual,
    totalSaved: t.saved,
    avgReductionPct: t.baseline > 0 ? t.saved / t.baseline * 100 : 0,
    projects,
    byTool: Object.entries(t.tools).map(([tool, [calls, savingCalls, saved]]) => ({ tool, calls, savingCalls, saved })).sort((a, b) => b.saved - a.saved),
    byDay: [],
    byFile: [],
    bySession: []
  };
}
function addLine(projects, line) {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isMeteringEntry(parsed)) return;
  const e = parsed;
  const p = projects[e.project] ??= { total: emptyTotals(), sessions: {}, latestTs: "", latestSession: "" };
  addEntry(p.total, e);
  addEntry(p.sessions[e.session] ??= emptyTotals(), e);
  if (e.ts > p.latestTs) {
    p.latestTs = e.ts;
    p.latestSession = e.session;
  }
}
async function readState() {
  try {
    const parsed = JSON.parse(await fs2.readFile(rollupPath(), "utf8"));
    if (parsed && parsed.version === VERSION && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
  }
  return { version: VERSION, files: {} };
}
async function writeState(state) {
  const file = rollupPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs2.mkdir(path2.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    await fs2.writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await fs2.rename(tmp, file);
  } catch {
    await fs2.rm(tmp, { force: true }).catch(() => {
    });
  }
}
async function updateFile(full, prev) {
  let fh;
  try {
    fh = await fs2.open(full, "r");
  } catch {
    return null;
  }
  try {
    const stat = await fh.stat();
    let base = prev;
    if (base && (base.dev !== stat.dev || base.ino !== stat.ino || base.offset > stat.size)) base = void 0;
    if (base && base.offset > 0) {
      const probe = Buffer.alloc(1);
      await fh.read(probe, 0, 1, base.offset - 1);
      if (probe[0] !== 10) base = void 0;
    }
    const start = base?.offset ?? 0;
    const next = base ?? { dev: stat.dev, ino: stat.ino, offset: 0, projects: {} };
    if (stat.size === start) return { next, changed: base !== prev };
    const buf = Buffer.alloc(stat.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const end = buf.lastIndexOf(10, bytesRead - 1);
    if (end < 0) return { next, changed: base !== prev };
    for (const line of buf.toString("utf8", 0, end).split("\n")) addLine(next.projects, line);
    next.offset = start + end + 1;
    return { next, changed: true };
  } finally {
    await fh.close();
  }
}
async function loadRollup() {
  const dir = meteringDir();
  let names;
  try {
    names = (await fs2.readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return {};
  }
  const state = await readState();
  const files = {};
  let changed = Object.keys(state.files).some((name) => !names.includes(name));
  for (const name of names) {
    const updated = await updateFile(path2.join(dir, name), state.files[name]);
    if (!updated) continue;
    files[name] = updated.next;
    changed ||= updated.changed;
  }
  if (changed) await writeState({ version: VERSION, files });
  const out = {};
  for (const file of Object.values(files)) {
    for (const [project, p] of Object.entries(file.projects)) {
      const into = out[project] ??= { total: emptyTotals(), sessions: {}, latestTs: "", latestSession: "" };
      mergeTotals(into.total, p.total);
      for (const [session, t] of Object.entries(p.sessions)) mergeTotals(into.sessions[session] ??= emptyTotals(), t);
      if (p.latestTs > into.latestTs) {
        into.latestTs = p.latestTs;
        into.latestSession = p.latestSession;
      }
    }
  }
  return out;
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
  const saving = (tool) => summary.byTool.find((t) => t.tool === tool)?.savingCalls ?? 0;
  const editCalls = saving("code_edit");
  const searchCalls = saving("code_search");
  const dbSchemaCalls = saving("db_schema");
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
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const mins = Math.round(sec / 60);
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
function fmtUsd(v) {
  if (v > 0 && v < 1) return `$${v.toFixed(v < 0.01 ? 4 : 3)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// src/statusline.ts
import * as path3 from "node:path";
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    let timer;
    const done = (value) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => done(data), 500);
    timer.unref?.();
    process.stdin.on("data", (c) => data += c);
    process.stdin.on("end", () => done(data));
    process.stdin.on("error", () => done(data));
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
function segment(totals) {
  const m = computeMetrics(totalsToSummary(totals ?? { calls: 0, baseline: 0, actual: 0, saved: 0, tools: {} }), []);
  return `${fmtUsd(m.costSaved)} \xB7 ${compact(m.tokensSaved)} tokens \xB7 ${fmtDuration(
    m.timeSavedSec
  )} \xB7 ${m.callsSaved} roundtrips`;
}
async function resolveProject(candidates, projects) {
  const known = new Set(Object.keys(projects));
  for (const dir of candidates) {
    if (known.has(dir) || await readCurrentSession(dir)) return dir;
  }
  for (const dir of candidates) {
    for (let p = path3.dirname(dir); p !== path3.dirname(p); p = path3.dirname(p)) {
      if (known.has(p)) return p;
    }
  }
  return candidates[0];
}
async function main() {
  const candidates = [];
  try {
    const input = JSON.parse(await readStdin() || "{}");
    for (const dir of [input.workspace?.project_dir, input.cwd, input.workspace?.current_dir]) {
      if (typeof dir === "string" && dir && !candidates.includes(dir)) candidates.push(dir);
    }
  } catch {
  }
  if (candidates.length === 0) candidates.push(process.cwd());
  const projects = await loadRollup();
  const project = await resolveProject(candidates, projects);
  const all = { calls: 0, baseline: 0, actual: 0, saved: 0, tools: {} };
  for (const p of Object.values(projects)) mergeTotals(all, p.total);
  const forProject = projects[project];
  let sessionId = await readCurrentSession(project);
  if (!sessionId && forProject?.latestSession) sessionId = forProject.latestSession;
  const sessionTotals = sessionId ? forProject?.sessions[sessionId] : void 0;
  const line = `\u26A1 MOZCODE est. session: ${segment(sessionTotals)}  \u2502  all-time: ${segment(all)}`;
  process.stdout.write(blue(line));
}
main().catch(() => {
  process.stdout.write(blue("\u26A1 MOZCODE est. session: $0.00 \xB7 0 tokens \xB7 0s \xB7 0 roundtrips"));
});
