import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  isMeteringEntry,
  meteringDir,
  mozcodeHome,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  type MeteringEntry,
  type Summary,
} from "./store.js";

/**
 * Incremental totals over the metering ledger, for the status line.
 *
 * The status line is a fresh process on every prompt update. Re-reading and
 * JSON-parsing the whole all-time, all-project ledger each time made every
 * refresh O(lifetime entries). The ledger is append-only, so this keeps a small
 * rollup (totals per project and per session) together with how many bytes of
 * each ledger file it has consumed, and on each run parses only the new tail.
 * A file that shrank, was replaced, or no longer lines up on a record boundary
 * is recounted from the start, and a missing or unreadable rollup is rebuilt.
 */

export interface Totals {
  calls: number;
  baseline: number;
  actual: number;
  saved: number;
  /** tool -> [calls, savingCalls, saved] */
  tools: Record<string, [number, number, number]>;
}

export interface ProjectRollup {
  total: Totals;
  sessions: Record<string, Totals>;
  /** Session of the most recent entry (first one recorded on a timestamp tie). */
  latestTs: string;
  latestSession: string;
}

interface FileRollup {
  dev: number;
  ino: number;
  /** Bytes consumed; always just past a newline. */
  offset: number;
  projects: Record<string, ProjectRollup>;
}

interface RollupState {
  version: 1;
  files: Record<string, FileRollup>;
}

const VERSION = 1;

export function rollupPath(): string {
  return path.join(mozcodeHome(), "cache", "statusline-rollup.json");
}

function emptyTotals(): Totals {
  return { calls: 0, baseline: 0, actual: 0, saved: 0, tools: {} };
}

function addEntry(t: Totals, e: MeteringEntry): void {
  t.calls += 1;
  t.baseline += e.baselineTokens;
  t.actual += e.actualTokens;
  t.saved += e.savedTokens;
  const tool = (t.tools[e.tool] ??= [0, 0, 0]);
  tool[0] += 1;
  if (e.savedTokens > 0) tool[1] += 1;
  tool[2] += e.savedTokens;
}

export function mergeTotals(into: Totals, from: Totals): Totals {
  into.calls += from.calls;
  into.baseline += from.baseline;
  into.actual += from.actual;
  into.saved += from.saved;
  for (const [tool, [calls, saving, saved]] of Object.entries(from.tools)) {
    const t = (into.tools[tool] ??= [0, 0, 0]);
    t[0] += calls;
    t[1] += saving;
    t[2] += saved;
  }
  return into;
}

/** A Summary carrying what computeMetrics reads (totals and per-tool counts). */
export function totalsToSummary(t: Totals, projects = 0): Summary {
  return {
    calls: t.calls,
    totalBaseline: t.baseline,
    totalActual: t.actual,
    totalSaved: t.saved,
    avgReductionPct: t.baseline > 0 ? (t.saved / t.baseline) * 100 : 0,
    projects,
    byTool: Object.entries(t.tools)
      .map(([tool, [calls, savingCalls, saved]]) => ({ tool, calls, savingCalls, saved }))
      .sort((a, b) => b.saved - a.saved),
    byDay: [],
    byFile: [],
    bySession: [],
  };
}

function addLine(projects: Record<string, ProjectRollup>, line: string): void {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isMeteringEntry(parsed)) return;
  const e = parsed;
  const p = (projects[e.project] ??= { total: emptyTotals(), sessions: {}, latestTs: "", latestSession: "" });
  addEntry(p.total, e);
  addEntry((p.sessions[e.session] ??= emptyTotals()), e);
  if (e.ts > p.latestTs) {
    p.latestTs = e.ts;
    p.latestSession = e.session;
  }
}

async function readState(): Promise<RollupState> {
  try {
    const parsed = JSON.parse(await fs.readFile(rollupPath(), "utf8")) as RollupState;
    if (parsed && parsed.version === VERSION && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // Missing or corrupt: rebuild from the ledger.
  }
  return { version: VERSION, files: {} };
}

async function writeState(state: RollupState): Promise<void> {
  const file = rollupPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    await fs.writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    // Atomic replace: a concurrent reader sees the old or the new rollup, never half of one.
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Bring one ledger file's rollup up to date; returns null if the file cannot be read. */
async function updateFile(full: string, prev: FileRollup | undefined): Promise<{ next: FileRollup; changed: boolean } | null> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(full, "r");
  } catch {
    return null;
  }
  try {
    const stat = await fh.stat();
    let base = prev;
    if (base && (base.dev !== stat.dev || base.ino !== stat.ino || base.offset > stat.size)) base = undefined;
    if (base && base.offset > 0) {
      // The consumed prefix must still end on a record boundary; otherwise the
      // file was rewritten in place and the rollup no longer describes it.
      const probe = Buffer.alloc(1);
      await fh.read(probe, 0, 1, base.offset - 1);
      if (probe[0] !== 0x0a) base = undefined;
    }
    const start = base?.offset ?? 0;
    const next: FileRollup = base ?? { dev: stat.dev, ino: stat.ino, offset: 0, projects: {} };
    if (stat.size === start) return { next, changed: base !== prev };

    const buf = Buffer.alloc(stat.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    // Only consume complete records; a line being appended right now is picked up next time.
    const end = buf.lastIndexOf(0x0a, bytesRead - 1);
    if (end < 0) return { next, changed: base !== prev };
    for (const line of buf.toString("utf8", 0, end).split("\n")) addLine(next.projects, line);
    next.offset = start + end + 1;
    return { next, changed: true };
  } finally {
    await fh.close();
  }
}

/** Per-project totals over every ledger file, consuming only bytes appended since the last run. */
export async function loadRollup(): Promise<Record<string, ProjectRollup>> {
  const dir = meteringDir();
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return {};
  }
  const state = await readState();
  const files: Record<string, FileRollup> = {};
  let changed = Object.keys(state.files).some((name) => !names.includes(name));
  for (const name of names) {
    const updated = await updateFile(path.join(dir, name), state.files[name]);
    if (!updated) continue;
    files[name] = updated.next;
    changed ||= updated.changed;
  }
  if (changed) await writeState({ version: VERSION, files });

  // One project normally maps to one file, but merge in case it does not.
  const out: Record<string, ProjectRollup> = {};
  for (const file of Object.values(files)) {
    for (const [project, p] of Object.entries(file.projects)) {
      const into = (out[project] ??= { total: emptyTotals(), sessions: {}, latestTs: "", latestSession: "" });
      mergeTotals(into.total, p.total);
      for (const [session, t] of Object.entries(p.sessions)) mergeTotals((into.sessions[session] ??= emptyTotals()), t);
      if (p.latestTs > into.latestTs) {
        into.latestTs = p.latestTs;
        into.latestSession = p.latestSession;
      }
    }
  }
  return out;
}
