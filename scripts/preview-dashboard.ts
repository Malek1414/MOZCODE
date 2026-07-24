import { writeFileSync } from "node:fs";
import { renderDashboard } from "../src/dashboard/render.js";
import { summarize, type MeteringEntry } from "../src/metering/store.js";

const now = Date.now();
const tools = ["code_read", "code_read", "code_outline", "code_search", "code_edit"];
const files = [
  "src/server.ts", "src/ast/engine.ts", "src/tools/search.ts",
  "src/metering/store.ts", "README.md", "src/dashboard/render.ts",
];
const entries: MeteringEntry[] = [];
for (let d = 0; d < 6; d++) {
  for (let i = 0; i < 12; i++) {
    const tool = tools[(d + i) % tools.length];
    const base = 400 + ((i * 137 + d * 91) % 1600);
    const actual = tool === "code_search" ? Math.round(base * 0.3) : Math.round(base * (0.05 + (i % 4) * 0.04));
    entries.push({
      ts: new Date(now - (5 - d) * 86400000 + i * 60000).toISOString(),
      session: `sess-${d}`,
      project: "/Users/x/proj",
      tool,
      path: files[(i + d) % files.length],
      baselineTokens: base,
      actualTokens: actual,
      savedTokens: Math.max(0, base - actual),
    });
  }
}

const html =
  "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>html,body{margin:0}</style></head><body>" +
  renderDashboard(summarize(entries)) +
  "</body></html>";

const out = process.argv[2] || "dash-preview.html";
writeFileSync(out, html);
console.log("wrote", out);
