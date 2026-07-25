import type { Summary } from "../metering/store.js";
import { computeMetrics, fmtDuration, fmtUsd, type KpiMetrics } from "./metrics.js";
import { SAIRA_FONT_FACE } from "./saira-font.js";

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}
function comma(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

const TOOL_ORDER = ["code_read", "code_outline", "code_search", "db_schema", "code_edit"];
const TOOL_LABELS: Record<string, string> = {
  code_read: "Symbol reads",
  code_outline: "Code outlines",
  code_search: "Smart search",
  db_schema: "DB schema",
  code_edit: "AST edits",
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ");
}

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
  return `<svg class="area-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative tokens saved by day" width="100%">${grid}
    <path d="${area}" fill="var(--series-1)" opacity="0.12"/><path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2"/>${dots}${xl}</svg>`;
}

function topFiles(rows: Summary["byFile"]): string {
  if (rows.length === 0) return `<p class="empty">No file activity yet.</p>`;
  const visible = rows.slice(0, 7);
  const max = Math.max(...visible.map((row) => row.saved), 1);
  return `<ol class="file-list">${visible
    .map((row, index) => {
      const width = Math.max(3, (row.saved / max) * 100);
      return `<li class="file-row">
        <span class="file-rank">${String(index + 1).padStart(2, "0")}</span>
        <div class="file-detail">
          <div class="file-meta"><span class="file-name" title="${esc(row.path)}">${esc(row.path)}</span><strong>${fmt(row.saved)}</strong></div>
          <div class="file-track"><span style="width:${width.toFixed(1)}%"></span></div>
        </div>
      </li>`;
    })
    .join("")}</ol>`;
}

export function renderDashboard(summary: Summary, generatedAt = new Date()): string {
  const m: KpiMetrics = computeMetrics(summary, []);
  const spark = m.cumulativeByDay.map((d) => d.cumulative);
  const a = m.assumptions;

  const toolRows = summary.byTool
    .slice()
    .sort((x, y) => TOOL_ORDER.indexOf(x.tool) - TOOL_ORDER.indexOf(y.tool))
    .map((t) => ({ label: toolLabel(t.tool), value: t.saved, colorVar: `--series-${(TOOL_ORDER.indexOf(t.tool) % 4) + 1}` }));

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
      --surface-1:#fff; --page:#f4f6f4; --raise:#fff;
      --text-primary:#101713; --text-secondary:#47534b; --muted:#78827b;
      --grid:#e5eae6; --border:rgba(16,23,19,.10); --good:#087a4f; --bar-track:#edf1ee;
      --series-1:#2367e8; --series-2:#00a979; --series-3:#e29a13; --series-4:#7457d9;
      --series-5:#7457d9; --series-6:#e34948; --shadow:0 18px 60px rgba(27,48,35,.07);
      font-family:'Saira',system-ui,-apple-system,"Segoe UI",sans-serif;
      color:var(--text-primary); min-height:100vh; margin:0; padding:26px; box-sizing:border-box;
      background:radial-gradient(circle at 8% 0%,rgba(35,103,232,.08),transparent 28rem),
        radial-gradient(circle at 100% 28%,rgba(0,169,121,.055),transparent 34rem),var(--page);
    }
    @media (prefers-color-scheme: dark){
      .viz-root{--surface-1:#151b17;--page:#0c100e;--raise:#151b17;--text-primary:#f4f8f5;--text-secondary:#b9c4bc;--muted:#7f8c83;--grid:#28312b;--border:rgba(237,248,240,.09);--good:#43d99e;--bar-track:#222b25;
        --series-1:#5b91ff;--series-2:#33d6a3;--series-3:#f0b64e;--series-4:#9d88f2;--series-5:#9d88f2;--series-6:#e66767;--shadow:0 22px 70px rgba(0,0,0,.28)}
    }
    :root[data-theme="dark"] .viz-root{--surface-1:#151b17;--page:#0c100e;--raise:#151b17;--text-primary:#f4f8f5;--text-secondary:#b9c4bc;--muted:#7f8c83;--grid:#28312b;--border:rgba(237,248,240,.09);--good:#43d99e;--bar-track:#222b25;--series-1:#5b91ff;--series-2:#33d6a3;--series-3:#f0b64e;--series-4:#9d88f2;--series-5:#9d88f2;--series-6:#e66767;--shadow:0 22px 70px rgba(0,0,0,.28)}
    :root[data-theme="light"] .viz-root{--surface-1:#fff;--page:#f4f6f4;--raise:#fff;--text-primary:#101713;--text-secondary:#47534b;--muted:#78827b;--grid:#e5eae6;--border:rgba(16,23,19,.10);--good:#087a4f;--bar-track:#edf1ee;--series-1:#2367e8;--series-2:#00a979;--series-3:#e29a13;--series-4:#7457d9;--series-5:#7457d9;--series-6:#e34948;--shadow:0 18px 60px rgba(27,48,35,.07)}
    .viz-root *{box-sizing:border-box}
    .shell{width:min(1380px,100%);margin:0 auto}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:4px 2px 22px}
    .brand{display:flex;align-items:center;gap:11px}.brand-icon{display:grid;grid-template-columns:repeat(2,9px);gap:3px;padding:9px;border-radius:11px;background:var(--text-primary);box-shadow:0 5px 20px rgba(0,0,0,.12)}.brand-icon i{width:9px;height:9px;border-radius:2px;background:var(--page)}.brand-icon i:first-child{background:var(--series-1)}.brand-icon i:last-child{background:var(--series-2)}
    .brandmark{font-size:19px;font-weight:800;letter-spacing:-.02em}.brand-sub{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.13em;font-weight:700}
    .actions{display:flex;align-items:center;gap:9px}.local-status{display:flex;align-items:center;gap:7px;border:1px solid var(--border);background:var(--surface-1);border-radius:999px;padding:8px 11px;font-size:10px;font-weight:700;color:var(--text-secondary)}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--series-2);box-shadow:0 0 0 4px color-mix(in srgb,var(--series-2) 16%,transparent)}
    .theme-toggle{width:36px;height:36px;border:1px solid var(--border);border-radius:50%;background:var(--surface-1);color:var(--text-primary);cursor:pointer;font:inherit;font-size:16px}
    .hero{display:flex;align-items:end;justify-content:space-between;gap:30px;padding:35px 38px;margin-bottom:14px;border:1px solid var(--border);border-radius:24px;background:linear-gradient(145deg,color-mix(in srgb,var(--series-1) 7%,var(--surface-1)),var(--surface-1) 58%);box-shadow:var(--shadow)}
    .eyebrow{font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:var(--series-1);margin:0 0 10px}.hero h1{font-size:clamp(34px,4vw,58px);line-height:.98;letter-spacing:-.045em;margin:0}.hero h1 span{color:var(--series-1)}
    .hero-meta{text-align:right}.hero-meta strong{display:block;font-size:clamp(32px,4vw,54px);line-height:1;letter-spacing:-.04em}.hero-meta span{font-size:11px;color:var(--muted)}
    .sub{color:var(--text-secondary);font-size:12px;line-height:1.45;margin:13px 0 0;max-width:610px}
    .disclaimer{display:grid;grid-template-columns:auto 1fr;gap:14px;background:color-mix(in srgb,var(--surface-1) 78%,transparent);border:1px solid var(--border);border-radius:13px;padding:12px 15px;font-size:11.5px;color:var(--text-secondary);margin:0 2px 26px}.disclaimer strong{white-space:nowrap;color:var(--text-primary)}
    .section-head{display:flex;align-items:end;justify-content:space-between;gap:15px;margin:0 2px 12px}.section-head h2{font-size:15px;margin:0}.section-head span{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-weight:700}
    .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:28px}
    @media (max-width:980px){.kpis{grid-template-columns:repeat(2,1fr)}}
    @media (max-width:640px){.kpis{grid-template-columns:1fr}}
    .kpi{background:var(--surface-1);border:1px solid var(--border);border-radius:18px;padding:18px 20px;position:relative;overflow:hidden;box-shadow:0 5px 22px rgba(27,48,35,.04)}
    .kpi::before{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--accent)}
    .kpi-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .kpi-dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:0 0 auto}
    .kpi-label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary)}
    .est{margin-left:auto;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--page);border:1px solid var(--border);border-radius:999px;padding:3px 6px}
    .kpi-body{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px}
    .kpi-value{font-size:34px;font-weight:800;letter-spacing:-0.02em;line-height:1}
    .kpi-visual{flex:0 0 auto}
    .spark{width:132px;height:34px;display:block}
    .gauge{width:74px;height:74px;display:block}
    .gauge-value{font-size:24px;font-weight:800;fill:var(--text-primary)}
    .kpi-sub{font-size:11.5px;color:var(--muted);margin-top:10px;font-weight:400}
    .grid-2{display:grid;grid-template-columns:1.15fr 1fr;gap:16px;margin-bottom:16px}
    @media (max-width:900px){.grid-2{grid-template-columns:1fr}}
    .card{background:var(--surface-1);border:1px solid var(--border);border-radius:18px;padding:21px;box-shadow:0 5px 22px rgba(27,48,35,.04);min-width:0}
    .card h2{font-size:13px;margin:0 0 14px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em}
    .area-chart{display:block;max-width:none}
    .bar-label{fill:var(--text-secondary);font-size:12px}
    .bar-value{fill:var(--text-primary);font-size:12px;font-weight:700}
    .grid{stroke:var(--grid);stroke-width:1}
    .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
    .empty{color:var(--muted);font-size:13px}.file-card{margin-bottom:16px}.file-list{list-style:none;padding:0;margin:0}.file-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}.file-row:last-child{border-bottom:0}.file-rank{font:600 9px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.file-detail{min-width:0;flex:1}.file-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px}.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)}.file-track{height:4px;border-radius:4px;background:var(--bar-track);margin-top:7px;overflow:hidden}.file-track span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--series-1),var(--series-2))}
    .table-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:10px 11px;border-bottom:1px solid var(--border);white-space:nowrap}
    th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.03em}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
    td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary)}
    td.good{color:var(--good);font-weight:700}
    .assumptions{margin-top:16px;background:color-mix(in srgb,var(--surface-1) 72%,transparent);border:1px solid var(--border);border-radius:16px;padding:17px 19px}
    .assumptions h2{font-size:12px;text-transform:uppercase;letter-spacing:0.04em;margin:0 0 10px;color:var(--text-secondary)}
    .assumptions ul{margin:0;padding-left:18px;columns:2;font-size:12px;color:var(--text-secondary);font-weight:400}
    @media (max-width:640px){.assumptions ul{columns:1}}
    .assumptions li{margin:3px 0}
    .foot{color:var(--muted);font-size:10px;margin-top:14px;font-weight:400;line-height:1.5}
    @media(max-width:680px){.viz-root{padding:14px}.local-status{display:none}.hero{display:block;padding:27px 23px;border-radius:20px}.hero-meta{text-align:left;margin-top:25px}.disclaimer{grid-template-columns:1fr}.disclaimer strong{white-space:normal}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style>

  <main class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div><div class="brandmark">MOZCODE</div><div class="brand-sub">Local intelligence</div></div>
    </div>
    <div class="actions">
      <span class="local-status"><i class="status-dot"></i>Local · private</span>
      <button class="theme-toggle" type="button" aria-label="Toggle color theme" title="Toggle color theme">◐</button>
    </div>
  </header>

  <section class="hero" aria-labelledby="dashboard-title">
    <div>
      <p class="eyebrow">Savings dashboard</p>
      <h1 id="dashboard-title">Less code.<br><span>More signal.</span></h1>
      <p class="sub">MOZCODE gives models the symbol they need instead of the whole file. This is the context kept out of your prompts.</p>
    </div>
    <div class="hero-meta"><strong>${fmt(m.tokensSaved)}</strong><span>tokens saved · ${comma(summary.calls)} optimized calls</span></div>
  </section>

  <aside class="disclaimer" aria-label="Measurement methodology"><strong>All figures are estimates.</strong><span>Tokens saved and efficiency are measured against a naive whole-file read or plain grep. Cost, time, and avoided calls are modelled from the disclosed assumptions below—not billing data.</span></aside>

  <div class="section-head"><h2>Impact snapshot</h2><span>01 · Metrics</span></div>
  <div class="kpis">
    ${kpiTile({ label: "Tokens saved", value: fmt(m.tokensSaved), sub: `${comma(m.tokensSaved)} input tokens not sent`, colorVar: "--series-1", spark, estimated: false })}
    ${kpiTile({ label: "Cost saved", value: fmtUsd(m.costSaved), sub: `incl. output of avoided round-trips`, colorVar: "--series-2", spark, estimated: true })}
    ${kpiTile({ label: "Time saved", value: fmtDuration(m.timeSavedSec), sub: `latency + prefill avoided`, colorVar: "--series-3", spark, estimated: true })}
    ${kpiTile({ label: "LLM calls saved", value: comma(m.callsSaved), sub: `re-reads & searches consolidated`, colorVar: "--series-5", spark, estimated: true })}
    ${kpiTile({ label: "API cost saved", value: fmtUsd(m.apiCostSaved), sub: `input tokens @ $${a.inputPricePerM.toFixed(2)}/M`, colorVar: "--series-4", spark, estimated: true })}
    ${kpiTile({ label: "Efficiency gain", value: "", sub: `avg payload reduction vs. baseline`, colorVar: "--series-1", gaugePct: m.efficiencyGainPct, estimated: false })}
  </div>

  <div class="section-head"><h2>Where the savings happen</h2><span>02 · Breakdown</span></div>
  <div class="grid-2">
    <div class="card"><h2>Cumulative tokens saved</h2>${areaChart(m.cumulativeByDay)}</div>
    <div class="card"><h2>Where the savings come from</h2>${barChart(toolRows)}</div>
  </div>

  <div class="card file-card">
    <h2>Top optimized files</h2>
    ${topFiles(summary.byFile)}
  </div>

  <div class="section-head"><h2>Recent activity</h2><span>03 · Sessions</span></div>
  <div class="card">
    <h2>Session ledger</h2>
    <div class="table-wrap"><table><thead><tr><th>Session</th><th class="num">Calls</th><th class="num">Baseline</th><th class="num">Returned</th><th class="num">Saved</th><th class="num">Reduction</th></tr></thead>
    <tbody>${sessionRows || `<tr><td colspan="6" class="empty">No sessions recorded yet.</td></tr>`}</tbody></table></div>
  </div>

  <div class="assumptions">
    <h2>Derivation assumptions (auditable)</h2>
    <ul>
      <li>Input price: <strong>$${a.inputPricePerM.toFixed(2)}</strong> / 1M tokens</li>
      <li>Cost per avoided round-trip: <strong>$${a.costPerAvoidedCall.toFixed(3)}</strong></li>
      <li>Latency per avoided round-trip: <strong>${a.latencyPerCallS}s</strong></li>
      <li>Prefill saved: <strong>${a.prefillSecPer1k}s</strong> / 1k tokens</li>
      <li>Search→call factor: <strong>${a.searchCallFactor}</strong></li>
      <li>DB discovery turns avoided per schema call: <strong>${a.dbCallsAvoidedPerSchema}</strong></li>
      <li>Token estimate: <strong>~4 chars/token</strong></li>
    </ul>
    <p class="foot">MOZCODE is an open-source, clean-room implementation inspired by a public teardown of WOZCODE. Not affiliated with Woz. Typeface: Saira (OFL-1.1).</p>
  </div>
  </main>
  <script>
    (() => {
      const button = document.querySelector(".theme-toggle");
      if (!(button instanceof HTMLButtonElement)) return;
      const saved = localStorage.getItem("mozcode-theme");
      if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
      button.addEventListener("click", () => {
        const current = document.documentElement.dataset.theme;
        const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
        const next = current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark");
        document.documentElement.dataset.theme = next;
        localStorage.setItem("mozcode-theme", next);
      });
    })();
  </script>
</div>`;
}
