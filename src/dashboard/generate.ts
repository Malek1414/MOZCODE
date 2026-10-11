import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadEntries, summarize, mozcodeHome } from "../metering/store.js";
import { renderDashboard } from "./render.js";

function wrap(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MOZCODE — savings dashboard</title>
<style>html,body{margin:0;padding:0;background:#eef2f7}@media(prefers-color-scheme:dark){html,body{background:#05070c}}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Build the dashboard HTML from stored metering and write it to ~/.mozcode/dashboard.html. */
export async function generateDashboard(): Promise<{ path: string; totalSaved: number; calls: number }> {
  const summary = summarize(await loadEntries());
  const html = wrap(renderDashboard(summary));
  const out = path.join(mozcodeHome(), "dashboard.html");
  await fs.mkdir(mozcodeHome(), { recursive: true });
  await fs.writeFile(out, html, "utf8");
  return { path: out, totalSaved: summary.totalSaved, calls: summary.calls };
}

/** Best-effort open in the default browser. */
export function openInBrowser(target: string): void {
  // explorer.exe opens a file with its default handler without going through a
  // shell, so a path with spaces or shell metacharacters stays one argument.
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
    // A missing opener (no xdg-open on a headless box) is reported as an async
    // 'error' event; unhandled, it would crash the MCP server.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opening is best-effort */
  }
}
