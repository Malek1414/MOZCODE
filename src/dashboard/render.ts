import type { Summary } from "../metering/store.js";
import { computeMetrics, fmtDuration, fmtUsd, type KpiMetrics } from "./metrics.js";
import { SAIRA_FONT_FACE } from "./saira-font.js";

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

const TOOL_ORDER = ["code_read", "code_outline", "code_search", "code_edit"];

/** Tiny sparkline for a KPI tile. */
function sparkline(values: number[], colorVar = "--series-1"): string {
  if (values.length < 2) return "";
  const w = 132;
  const h = 34;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - 3 - ((v - min) / range) * (h - 6);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="var(${colorVar})" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="var(${colorVar})" stroke-width="1.5"/>
  </svg>`;
}

/** Radial gauge (donut) for a 0–100% value. */
function gauge(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 46;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  return `<svg viewBox="0 0 120 120" class="gauge" role="img" aria-label="${clamped.toFixed(0)} percent">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--grid)" stroke-width="12"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--series-1)" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" transform="rotate(-90 60 60)"/>
    <text x="60" y="60" text-anchor="middle" dominant-baseline="central" class="gauge-value">${clamped.toFixed(0)}%</text>
  </svg>`;
}

function kpiTile(opts: {
  label: string;
  value: string;
  sub: string;
  colorVar: string;
  spark?: number[];
  gaugePct?: number;
  estimated: boolean;
}): string {
  const badge = opts.estimated ? `<span class="est" title="Derived estimate — see assumptions">est</span>` : "";
  const visual = opts.gaugePct !== undefined ? gauge(opts.gaugePct) : opts.spark ? sparkline(opts.spark, opts.colorVar) : "";
  return `<div class="kpi" style="--accent:var(${opts.colorVar})">
    <div class="kpi-head"><span class="kpi-dot"></span><span class="kpi-label">${opts.label}</span>${badge}</div>
    <div class="kpi-body">
      <div class="kpi-value">${opts.value}</div>
      <div class="kpi-visual">${visual}</div>
    </div>
    <div class="kpi-sub">${opts.sub}</div>
  </div>`;
}

function barChart(rows: { label: string; value: number; colorVar: string }[]): string {
  if (rows.length === 0) return `<p class="empty">No data yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = 34;
  const labelW = 130;
  const barMax = 320;
  const width = labelW + barMax + 70;
  const height = rows.length * rowH + 8;
  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const w = Math.max(2, (r.value / max) * barMax);
      return `<text x="${labelW - 10}" y="${y + 15}" text-anchor="end" class="bar-label">${esc(r.label.length > 20 ? "…" + r.label.slice(-19) : r.label)}</text>
      <rect x="${labelW}" y="${y + 3}" width="${w}" height="18" rx="4" fill="var(${r.colorVar})"><title>${esc(r.label)}: ${comma(r.value)}</title></rect>
      <text x="${labelW + w + 8}" y="${y + 15}" class="bar-value">${fmt(r.value)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" width="100%" style="max-width:${width}px">${bars}</svg>`;
}

function areaChart(byDay: { day: string; cumulative: number }[]): string {
  if (byDay.length === 0) return `<p class="empty">No data yet.</p>`;
  const w = 640;
  const h = 200;
  const pad = { l: 56, r: 16, t: 16, b: 30 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const maxY = Math.max(...byDay.map((p) => p.cumulative), 1);
  const x = (i: number) => pad.l + (byDay.length === 1 ? iw / 2 : (i / (byDay.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / maxY) * ih;
  const line = byDay.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(" ");
  const area = `${line} L${x(byDay.length - 1).toFixed(1)},${pad.t + ih} L${x(0).toFixed(1)},${pad.t + ih} Z`;
  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = pad.t + ih - f * ih;
      return `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" class="grid"/><text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" class="tick">${fmt(f * maxY)}</text>`;
    })
    .join("");
  const dots = byDay.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.cumulative).toFixed(1)}" r="3.5" fill="var(--series-1)"><title>${p.day}: ${comma(p.cumulative)}</title></circle>`).join("");
  const xl = byDay
    .filter((_, i) => i === 0 || i === byDay.length - 1 || byDay.length <= 5)
    .map((p) => `<text x="${x(byDay.indexOf(p)).toFixed(1)}" y="${h - 10}" text-anchor="middle" class="tick">${p.day.slice(5)}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" width="100%" style="max-width:${w}px">${grid}
    <path d="${area}" fill="var(--series-1)" opacity="0.12"/><path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2"/>${dots}${xl}</svg>`;
}

export function renderDashboard(summary: Summary, generatedAt = new Date()): string {
  const m: KpiMetrics = computeMetrics(summary, []);
  const spark = m.cumulativeByDay.map((d) => d.cumulative);
  const a = m.assumptions;

  const toolRows = summary.byTool
    .slice()
    .sort((x, y) => TOOL_ORDER.indexOf(x.tool) - TOOL_ORDER.indexOf(y.tool))
    .map((t) => ({ label: t.tool, value: t.saved, colorVar: `--series-${(TOOL_ORDER.indexOf(t.tool) % 4) + 1}` }));

  const sessionRows = summary.bySession
    .slice(0, 20)
    .map(
      (s) => `<tr><td class="mono">${esc(s.session.slice(0, 12))}</td><td class="num">${comma(s.calls)}</td><td class="num">${comma(s.baseline)}</td><td class="num">${comma(s.actual)}</td><td class="num good">${comma(s.saved)}</td><td class="num">${s.baseline > 0 ? ((s.saved / s.baseline) * 100).toFixed(0) : "0"}%</td></tr>`,
    )
    .join("");

  return `<div class="viz-root">
  <style>
    ${SAIRA_FONT_FACE}
    .viz-root{
      --surface-1:#fcfcfb; --page:#f9f9f7; --raise:#ffffff;
      --text-primary:#0b0b0b; --text-secondary:#52514e; --muted:#898781;
      --grid:#e6e5df; --border:rgba(11,11,11,0.10); --good:#006300;
      --series-1:#2a78d6; --series-2:#1baf7a; --series-3:#eda100; --series-4:#008300;
      --series-5:#4a3aa7; --series-6:#e34948;
      font-family:'Saira',system-ui,-apple-system,"Segoe UI",sans-serif;
      color:var(--text-primary); background:var(--page); min-height:100vh; margin:0; padding:32px 34px; box-sizing:border-box;
    }
    @media (prefers-color-scheme: dark){
      .viz-root{ --surface-1:#1a1a19; --page:#0d0d0d; --raise:#222220; --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --good:#0ca30c;
        --series-1:#3987e5; --series-2:#199e70; --series-3:#c98500; --series-4:#008300; --series-5:#9085e9; --series-6:#e66767; }
    }
    :root[data-theme="dark"] .viz-root{ --surface-1:#1a1a19; --page:#0d0d0d; --raise:#222220; --text-primary:#fff; --text-secondary:#c3c2b7; --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --good:#0ca30c; --series-1:#3987e5; --series-2:#199e70; --series-3:#c98500; --series-4:#008300; --series-5:#9085e9; --series-6:#e66767; }
    :root[data-theme="light"] .viz-root{ --surface-1:#fcfcfb; --page:#f9f9f7; --raise:#fff; --text-primary:#0b0b0b; --text-secondary:#52514e; --grid:#e6e5df; --border:rgba(11,11,11,0.10); --good:#006300; --series-1:#2a78d6; --series-2:#1baf7a; --series-3:#eda100; --series-4:#008300; --series-5:#4a3aa7; --series-6:#e34948; }
    .viz-root *{box-sizing:border-box}
    .head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px}
    h1{font-size:26px;font-weight:800;letter-spacing:-0.01em;margin:0;text-transform:uppercase}
    .brandmark{font-weight:800;color:var(--series-1)}
    .sub{color:var(--muted);font-size:13px;margin:0 0 22px;font-weight:400}
    .disclaimer{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:11px 15px;font-size:12.5px;color:var(--text-secondary);margin-bottom:26px;font-weight:400}
    .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:26px}
    @media (max-width:980px){.kpis{grid-template-columns:repeat(2,1fr)}}
    @media (max-width:640px){.kpis{grid-template-columns:1fr}}
    .kpi{background:var(--surface-1);border:1px solid var(--border);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
    .kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
    .kpi-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .kpi-dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:0 0 auto}
    .kpi-label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary)}
    .est{margin-left:auto;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);border:1px solid var(--border);border-radius:5px;padding:1px 5px}
    .kpi-body{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px}
    .kpi-value{font-size:34px;font-weight:800;letter-spacing:-0.02em;line-height:1}
    .kpi-visual{flex:0 0 auto}
    .spark{width:132px;height:34px;display:block}
    .gauge{width:74px;height:74px;display:block}
    .gauge-value{font-size:24px;font-weight:800;fill:var(--text-primary)}
    .kpi-sub{font-size:11.5px;color:var(--muted);margin-top:10px;font-weight:400}
    .grid-2{display:grid;grid-template-columns:1.15fr 1fr;gap:18px;margin-bottom:20px}
    @media (max-width:900px){.grid-2{grid-template-columns:1fr}}
    .card{background:var(--surface-1);border:1px solid var(--border);border-radius:14px;padding:20px}
    .card h2{font-size:13px;margin:0 0 14px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em}
    .bar-label{fill:var(--text-secondary);font-size:12px}
    .bar-value{fill:var(--text-primary);font-size:12px;font-weight:700}
    .grid{stroke:var(--grid);stroke-width:1}
    .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
    .empty{color:var(--muted);font-size:13px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
    th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.03em}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
    td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary)}
    td.good{color:var(--good);font-weight:700}
    .assumptions{margin-top:18px;background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
    .assumptions h2{font-size:12px;text-transform:uppercase;letter-spacing:0.04em;margin:0 0 10px;color:var(--text-secondary)}
    .assumptions ul{margin:0;padding-left:18px;columns:2;font-size:12px;color:var(--text-secondary);font-weight:400}
    @media (max-width:640px){.assumptions ul{columns:1}}
    .assumptions li{margin:3px 0}
    .foot{color:var(--muted);font-size:11.5px;margin-top:14px;font-weight:400}
  </style>

  <div class="head">
    <h1><span class="brandmark">MOZCODE</span> — savings</h1>
    <span class="sub">Local · ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} · ${summary.projects} project${summary.projects === 1 ? "" : "s"} · ${comma(summary.calls)} calls</span>
  </div>

  <div class="disclaimer"><strong>All figures are estimates.</strong> Only <em>tokens saved</em> and <em>efficiency gain</em> are measured directly (input tokens MOZCODE did not send, vs. a naive whole-file read / plain grep). Cost, time, and LLM-calls figures are <em>derived</em> from those via the assumptions listed at the bottom. Not a billing figure.</div>

  <div class="kpis">
    ${kpiTile({ label: "Tokens saved", value: fmt(m.tokensSaved), sub: `${comma(m.tokensSaved)} input tokens not sent`, colorVar: "--series-1", spark, estimated: false })}
    ${kpiTile({ label: "Cost saved", value: fmtUsd(m.costSaved), sub: `incl. output of avoided round-trips`, colorVar: "--series-2", spark, estimated: true })}
    ${kpiTile({ label: "Time saved", value: fmtDuration(m.timeSavedSec), sub: `latency + prefill avoided`, colorVar: "--series-3", spark, estimated: true })}
    ${kpiTile({ label: "LLM calls saved", value: comma(m.callsSaved), sub: `re-reads & searches consolidated`, colorVar: "--series-5", spark, estimated: true })}
    ${kpiTile({ label: "API cost saved", value: fmtUsd(m.apiCostSaved), sub: `input tokens @ $${a.inputPricePerM.toFixed(2)}/M`, colorVar: "--series-4", spark, estimated: true })}
    ${kpiTile({ label: "Efficiency gain", value: "", sub: `avg payload reduction vs. baseline`, colorVar: "--series-1", gaugePct: m.efficiencyGainPct, estimated: false })}
  </div>

  <div class="grid-2">
    <div class="card"><h2>Cumulative tokens saved</h2>${areaChart(m.cumulativeByDay)}</div>
    <div class="card"><h2>Where the savings come from</h2>${barChart(toolRows)}</div>
  </div>

  <div class="card">
    <h2>Session log</h2>
    <table><thead><tr><th>Session</th><th class="num">Calls</th><th class="num">Baseline</th><th class="num">Returned</th><th class="num">Saved</th><th class="num">Reduction</th></tr></thead>
    <tbody>${sessionRows || `<tr><td colspan="6" class="empty">No sessions recorded yet.</td></tr>`}</tbody></table>
  </div>

  <div class="assumptions">
    <h2>Derivation assumptions (auditable)</h2>
    <ul>
      <li>Input price: <strong>$${a.inputPricePerM.toFixed(2)}</strong> / 1M tokens</li>
      <li>Cost per avoided round-trip: <strong>$${a.costPerAvoidedCall.toFixed(3)}</strong></li>
      <li>Latency per avoided round-trip: <strong>${a.latencyPerCallS}s</strong></li>
      <li>Prefill saved: <strong>${a.prefillSecPer1k}s</strong> / 1k tokens</li>
      <li>Search→call factor: <strong>${a.searchCallFactor}</strong></li>
      <li>Token estimate: <strong>~4 chars/token</strong></li>
    </ul>
    <p class="foot">MOZCODE is an open-source, clean-room implementation inspired by a public teardown of WOZCODE. Not affiliated with Woz. Typeface: Saira (OFL-1.1).</p>
  </div>
</div>`;
}
