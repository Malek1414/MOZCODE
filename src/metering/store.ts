import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SavingsMeta } from "../tools/types.js";

export interface MeteringEntry {
  ts: string;
  session: string;
  project: string;
  tool: string;
  path?: string;
  baselineTokens: number;
  actualTokens: number;
  savedTokens: number;
}

/** Root for all MOZCODE state. Overridable via MOZCODE_HOME (used by tests). */
export function mozcodeHome(): string {
  return process.env.MOZCODE_HOME || path.join(os.homedir(), ".mozcode");
}

function meteringDir(): string {
  return path.join(mozcodeHome(), "metering");
}

function projectFile(project: string): string {
  const hash = crypto.createHash("sha1").update(project).digest("hex").slice(0, 12);
  const base = path.basename(project).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(meteringDir(), `${base}-${hash}.jsonl`);
}

/** Append one savings record. Never throws into the request path. */
export async function record(
  project: string,
  session: string,
  meta: SavingsMeta,
): Promise<void> {
  try {
    await fs.mkdir(meteringDir(), { recursive: true });
    const entry: MeteringEntry = {
      ts: new Date().toISOString(),
      session,
      project,
      tool: meta.tool,
      path: meta.path,
      baselineTokens: meta.baselineTokens,
      actualTokens: meta.actualTokens,
      savedTokens: meta.savedTokens,
    };
    await fs.appendFile(projectFile(project), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Metering is best-effort; a failure here must not break a tool call.
  }
}

/** Load all metering entries across every project. */
export async function loadEntries(): Promise<MeteringEntry[]> {
  const dir = meteringDir();
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: MeteringEntry[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MeteringEntry);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

export interface Summary {
  calls: number;
  totalBaseline: number;
  totalActual: number;
  totalSaved: number;
  avgReductionPct: number;
  projects: number;
  byTool: { tool: string; calls: number; saved: number }[];
  byDay: { day: string; saved: number }[];
  byFile: { path: string; calls: number; saved: number }[];
  bySession: { session: string; calls: number; baseline: number; actual: number; saved: number }[];
}

export function summarize(entries: MeteringEntry[], topFiles = 15): Summary {
  const byTool = new Map<string, { calls: number; saved: number }>();
  const byDay = new Map<string, number>();
  const byFile = new Map<string, { calls: number; saved: number }>();
  const bySession = new Map<string, { calls: number; baseline: number; actual: number; saved: number }>();
  const projects = new Set<string>();

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
    avgReductionPct: totalBaseline > 0 ? (totalSaved / totalBaseline) * 100 : 0,
    projects: projects.size,
    byTool: [...byTool.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.saved - a.saved),
    byDay: [...byDay.entries()].map(([day, saved]) => ({ day, saved })).sort((a, b) => a.day.localeCompare(b.day)),
    byFile: [...byFile.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.saved - a.saved).slice(0, topFiles),
    bySession: [...bySession.entries()].map(([session, v]) => ({ session, ...v })).sort((a, b) => b.saved - a.saved),
  };
}
