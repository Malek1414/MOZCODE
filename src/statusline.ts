#!/usr/bin/env node
// Claude Code statusline: prints MOZCODE's estimated savings for the current
// session and all-time, on the line beneath the prompt. Claude Code invokes
// this on each update with a JSON blob on stdin (session_id, cwd, model, ...).
// We only need the project directory to scope "this session" to the active project.
//
// All figures are ESTIMATES against a naive-tool counterfactual — never billing.
import { loadEntries, summarize, readCurrentSession } from "./metering/store.js";
import { computeMetrics, fmtUsd, fmtDuration } from "./dashboard/metrics.js";
import type { MeteringEntry } from "./metering/store.js";
import * as path from "node:path";

/** Read the whole stdin stream (the JSON Claude Code hands the statusline). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");

    // Safety: never hang the statusline waiting on stdin. The timer is unref'd
    // and cleared on settle so it can never keep the event loop alive after the
    // line has been written — Claude Code reads this process until it EXITS, so
    // a lingering timer renders the statusline stale by the timer's full delay.
    let timer: NodeJS.Timeout | undefined;
    const done = (value: string) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => done(data), 500);
    timer.unref?.();

    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => done(data));
    process.stdin.on("error", () => done(data));
  });
}

// MOZCODE brand blue (--series-1 dark) as a 24-bit ANSI truecolor wrapper, so
// the statusline reads in MOZCODE's colour rather than the terminal default.
const BLUE = "\x1b[38;2;91;145;255m";
const RESET = "\x1b[0m";
const blue = (s: string) => `${BLUE}${s}${RESET}`;

/** Compact token/count formatting: 0, 942, 12.3k, 4.1M. */
function compact(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function segment(entries: MeteringEntry[]): string {
  const m = computeMetrics(summarize(entries), entries);
  return `${fmtUsd(m.costSaved)} · ${compact(m.tokensSaved)} tokens · ${fmtDuration(
    m.timeSavedSec,
  )} · ${m.callsSaved} roundtrips`;
}

/**
 * The project the MCP server meters under. Claude Code starts the server in the
 * launch directory (workspace.project_dir), while `cwd` follows the session
 * into subdirectories, so try the project dir first, then the cwd, then the
 * nearest ancestor of either that has recorded entries.
 */
async function resolveProject(candidates: string[], all: MeteringEntry[]): Promise<string> {
  const known = new Set(all.map((e) => e.project));
  for (const dir of candidates) {
    if (known.has(dir) || (await readCurrentSession(dir))) return dir;
  }
  for (const dir of candidates) {
    for (let p = path.dirname(dir); p !== path.dirname(p); p = path.dirname(p)) {
      if (known.has(p)) return p;
    }
  }
  return candidates[0];
}

async function main(): Promise<void> {
  const candidates: string[] = [];
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    for (const dir of [input.workspace?.project_dir, input.cwd, input.workspace?.current_dir]) {
      if (typeof dir === "string" && dir && !candidates.includes(dir)) candidates.push(dir);
    }
  } catch {
    /* no/invalid stdin — fall back to process cwd */
  }
  if (candidates.length === 0) candidates.push(process.cwd());

  const all = await loadEntries();
  const project = await resolveProject(candidates, all);

  // "This session" = the active metering session for this project. The server
  // publishes it on startup; if that's missing, fall back to the session of the
  // most recent entry recorded for this project.
  const forProject = all.filter((e) => e.project === project);
  let sessionId = await readCurrentSession(project);
  if (!sessionId && forProject.length) {
    sessionId = forProject.reduce((a, b) => (a.ts >= b.ts ? a : b)).session;
  }
  const sessionEntries = sessionId ? forProject.filter((e) => e.session === sessionId) : [];

  const line = `⚡ MOZCODE est. session: ${segment(sessionEntries)}  │  all-time: ${segment(all)}`;
  process.stdout.write(blue(line));
}

main().catch(() => {
  // A broken statusline must never surface an error to the user.
  process.stdout.write(blue("⚡ MOZCODE est. session: $0.00 · 0 tokens · 0s · 0 roundtrips"));
});
