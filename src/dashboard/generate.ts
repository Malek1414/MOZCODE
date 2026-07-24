import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadEntries, summarize, terseHome } from "../metering/store.js";
import { renderDashboard } from "./render.js";

function wrap(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terse — savings dashboard</title>
<style>html,body{margin:0;padding:0;background:#f9f9f7}@media(prefers-color-scheme:dark){html,body{background:#0d0d0d}}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Build the dashboard HTML from stored metering and write it to ~/.terse/dashboard.html. */
export async function generateDashboard(): Promise<{ path: string; totalSaved: number; calls: number }> {
  const summary = summarize(await loadEntries());
  const html = wrap(renderDashboard(summary));
  const out = path.join(terseHome(), "dashboard.html");
  await fs.mkdir(terseHome(), { recursive: true });
  await fs.writeFile(out, html, "utf8");
  return { path: out, totalSaved: summary.totalSaved, calls: summary.calls };
}

/** Best-effort open in the default browser. */
export function openInBrowser(target: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
  } catch {
    /* opening is best-effort */
  }
}
