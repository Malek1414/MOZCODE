import type { Summary } from "../metering/store.js";

/** Compact number: 12345 -> "12.3k". */
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}
function comma(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// Fixed categorical order (dataviz slots 1–4), light / dark.
const TOOL_ORDER = ["code_read", "code_outline", "code_search", "code_edit"];
const SERIES_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300"];

/** Horizontal bar chart with direct value labels (relief rule). */
function barChart(rows: { label: string; value: number; colorVar: string }[]): string {
  if (rows.length === 0) return `<p class="empty">No data yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = 34;
  const labelW = 150;
  const barMax = 360;
  const width = labelW + barMax + 70;
  const height = rows.length * rowH + 8;
  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const w = Math.max(2, (r.value / max) * barMax);
      return `
      <text x="${labelW - 10}" y="${y + 15}" text-anchor="end" class="bar-label" data-full="${esc(r.label)}">${esc(r.label.length > 22 ? "…" + r.label.slice(-21) : r.label)}</text>
      <rect x="${labelW}" y="${y + 3}" width="${w}" height="18" rx="4" fill="var(${r.colorVar})"><title>${esc(r.label)}: ${comma(r.value)} tokens</title></rect>
      <text x="${labelW + w + 8}" y="${y + 15}" class="bar-value">${fmt(r.value)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" width="100%" style="max-width:${width}px">${bars}</svg>`;
}

/** Cumulative savings line/area over days. */
function lineChart(byDay: { day: string; saved: number }[]): string {
  if (byDay.length === 0) return `<p class="empty">No data yet.</p>`;
  let cum = 0;
  const pts = byDay.map((d) => ({ day: d.day, cum: (cum += d.saved) }));
  const w = 640;
  const h = 220;
  const pad = { l: 56, r: 16, t: 16, b: 34 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const maxY = Math.max(...pts.map((p) => p.cum), 1);
  const x = (i: number) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / maxY) * ih;

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const dots = pts
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="4" fill="var(--series-1)"><title>${p.day}: ${comma(p.cum)} cumulative</title></circle>`)
    .join("");
  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = pad.t + ih - f * ih;
      return `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" class="grid"/><text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" class="tick">${fmt(f * maxY)}</text>`;
    })
    .join("");
  const xlabels = pts
    .filter((_, i) => i === 0 || i === pts.length - 1 || pts.length <= 5)
    .map((p, _, arr) => {
      const idx = pts.indexOf(p);
      return `<text x="${x(idx).toFixed(1)}" y="${h - 12}" text-anchor="middle" class="tick">${p.day.slice(5)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" width="100%" style="max-width:${w}px">
    ${grid}
    <path d="${area}" fill="var(--series-1)" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2"/>
    ${dots}${xlabels}
  </svg>`;
}

function statTile(label: string, value: string, sub: string): string {
  return `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${label}</div><div class="tile-sub">${sub}</div></div>`;
}

export function renderDashboard(summary: Summary, generatedAt = new Date()): string {
  const toolRows = summary.byTool
    .slice()
    .sort((a, b) => TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool))
    .map((t) => ({
      label: t.tool,
      value: t.saved,
      colorVar: `--series-${(TOOL_ORDER.indexOf(t.tool) % 4) + 1}`,
    }));
  const fileRows = summary.byFile.map((f) => ({ label: f.path, value: f.saved, colorVar: "--series-1" }));

  const sessionRows = summary.bySession
    .slice(0, 20)
    .map(
      (s) => `<tr>
      <td class="mono">${esc(s.session.slice(0, 12))}</td>
      <td class="num">${comma(s.calls)}</td>
      <td class="num">${comma(s.baseline)}</td>
      <td class="num">${comma(s.actual)}</td>
      <td class="num good">${comma(s.saved)}</td>
      <td class="num">${s.baseline > 0 ? ((s.saved / s.baseline) * 100).toFixed(0) : "0"}%</td>
    </tr>`,
    )
    .join("");

  return `<div class="viz-root">
  <style>
    .viz-root{
      --surface-1:#fcfcfb; --page:#f9f9f7;
      --text-primary:#0b0b0b; --text-secondary:#52514e; --muted:#898781;
      --grid:#e1e0d9; --border:rgba(11,11,11,0.10); --good:#006300;
      --series-1:#2a78d6; --series-2:#1baf7a; --series-3:#eda100; --series-4:#008300;
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
      color:var(--text-primary); background:var(--page); min-height:100vh;
      margin:0; padding:32px; box-sizing:border-box;
    }
    @media (prefers-color-scheme: dark){
      .viz-root{
        --surface-1:#1a1a19; --page:#0d0d0d;
        --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781;
        --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --good:#0ca30c;
        --series-1:#3987e5; --series-2:#199e70; --series-3:#c98500; --series-4:#008300;
      }
    }
    :root[data-theme="dark"] .viz-root{ --surface-1:#1a1a19; --page:#0d0d0d; --text-primary:#fff; --text-secondary:#c3c2b7; --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --good:#0ca30c; --series-1:#3987e5; --series-2:#199e70; --series-3:#c98500; --series-4:#008300; }
    :root[data-theme="light"] .viz-root{ --surface-1:#fcfcfb; --page:#f9f9f7; --text-primary:#0b0b0b; --text-secondary:#52514e; --grid:#e1e0d9; --border:rgba(11,11,11,0.10); --good:#006300; --series-1:#2a78d6; --series-2:#1baf7a; --series-3:#eda100; --series-4:#008300; }
    .viz-root *{box-sizing:border-box}
    h1{font-size:22px;margin:0 0 2px}
    .sub{color:var(--muted);font-size:13px;margin:0 0 24px}
    .disclaimer{background:var(--surface-1);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12.5px;color:var(--text-secondary);margin-bottom:24px}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
    .tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
    .tile-value{font-size:30px;font-weight:650;letter-spacing:-0.02em}
    .tile-label{font-size:13px;color:var(--text-secondary);margin-top:4px}
    .tile-sub{font-size:11.5px;color:var(--muted);margin-top:2px}
    .card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
    .card h2{font-size:14px;margin:0 0 14px;font-weight:600}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    @media (max-width:820px){.grid-2{grid-template-columns:1fr}}
    .bar-label{fill:var(--text-secondary);font-size:12px}
    .bar-value{fill:var(--text-primary);font-size:12px;font-weight:600}
    .grid{stroke:var(--grid);stroke-width:1}
    .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
    .empty{color:var(--muted);font-size:13px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
    th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.03em}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
    td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary)}
    td.good{color:var(--good);font-weight:600}
    .foot{color:var(--muted);font-size:11.5px;margin-top:8px}
  </style>

  <h1>Terse — savings dashboard</h1>
  <p class="sub">Local · generated ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} · ${summary.projects} project${summary.projects === 1 ? "" : "s"}</p>

  <div class="disclaimer">
    <strong>All figures are estimates.</strong> Token counts use a ~4-chars/token heuristic and are diffed against a
    <em>counterfactual</em> baseline (what a naive whole-file read or plain grep would have returned) that cannot be directly observed.
    These numbers illustrate the mechanism; they are not a billing figure.
  </div>

  <div class="tiles">
    ${statTile("Estimated tokens saved", fmt(summary.totalSaved), `${comma(summary.totalSaved)} total`)}
    ${statTile("Tool calls intercepted", comma(summary.calls), "reads, outlines, searches, edits")}
    ${statTile("Avg payload reduction", summary.avgReductionPct.toFixed(0) + "%", "vs. naive baseline")}
    ${statTile("Baseline avoided", fmt(summary.totalBaseline), `${fmt(summary.totalActual)} actually returned`)}
  </div>

  <div class="card">
    <h2>Cumulative estimated savings over time</h2>
    ${lineChart(summary.byDay)}
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>Savings by tool</h2>
      ${barChart(toolRows)}
    </div>
    <div class="card">
      <h2>Top files by reduction</h2>
      ${barChart(fileRows)}
    </div>
  </div>

  <div class="card">
    <h2>Session log</h2>
    <table>
      <thead><tr><th>Session</th><th class="num">Calls</th><th class="num">Baseline</th><th class="num">Returned</th><th class="num">Saved</th><th class="num">Reduction</th></tr></thead>
      <tbody>${sessionRows || `<tr><td colspan="6" class="empty">No sessions recorded yet.</td></tr>`}</tbody>
    </table>
    <p class="foot">Terse is an open-source, clean-room implementation inspired by a public teardown of WOZCODE. It is not affiliated with Woz.</p>
  </div>
</div>`;
}
