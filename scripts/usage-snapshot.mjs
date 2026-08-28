#!/usr/bin/env node
// @ts-check
/**
 * usage-snapshot.mjs — render a usage report as one self-contained, read-only HTML page.
 *
 * This is the SHAREABLE half of the feature, and it is deliberately a renderer, not a second
 * implementation: it takes the object `buildUsageReport()` already produced and formats it.
 * The cockpit's live Value page and this snapshot therefore cannot drift into disagreeing
 * about a number, because there is only one place a number is computed.
 *
 * What it may contain is constrained by the same rule as the cache: AGGREGATES ONLY. The
 * report object holds counts, durations, ticket ids and board metadata — no prompts, no
 * responses, no commands, no source. Nothing in here reaches past it for more.
 *
 * The page states its own provenance where a reader will see it: when it was generated, over
 * what range, from which project, how much of the work it could attribute — and, per row,
 * whether the figures were MEASURED from run telemetry or INFERRED from transcripts. A
 * snapshot that hid that distinction would be worse than no snapshot.
 *
 * No JavaScript, no network calls, no external assets beyond the font stylesheet.
 */

/** @param {unknown} s */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

/** @param {number} n */
export const fmtTokens = (n) => {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
};

/** @param {number} ms */
export const fmtDuration = (ms) => {
  if (!ms) return "—";
  const h = ms / 3600000;
  if (h >= 48) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60000;
  if (m >= 1) return `${m.toFixed(0)}m`;
  return `${Math.round(ms / 1000)}s`;
};

/** The four token classes, in the order they stack in every bar on the page. */
const CLASSES = /** @type {const} */ ([
  ["input", "Input"],
  ["output", "Output"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
]);

/**
 * A stacked proportion bar. Widths are percentages of the row's own total, so a small ticket
 * and a large one are compared by shape, and the absolute figure is in the column beside it.
 * @param {any} tokens
 */
function bar(tokens) {
  const total = tokens.total || 1;
  const segs = CLASSES
    .map(([k, label]) => ({ k, label, pct: ((tokens[k] || 0) / total) * 100 }))
    .filter((s) => s.pct > 0.05);
  return `<span class="bar" role="img" aria-label="${segs.map((s) => `${s.label} ${s.pct.toFixed(0)}%`).join(", ")}">${
    segs.map((s) => `<span class="seg seg--${s.k}" style="width:${s.pct.toFixed(2)}%"></span>`).join("")
  }</span>`;
}

/** @param {any[]} rows @param {string} label */
function dimensionPanel(rows, label) {
  if (!rows.length) return "";
  const max = rows[0].tokens.total || 1;
  return `<section class="panel">
  <h3>${esc(label)}</h3>
  <table class="dim">
    <tbody>
    ${rows.slice(0, 10).map((r) => `<tr>
      <th scope="row">${esc(r.key)}</th>
      <td class="num">${fmtTokens(r.tokens.total)}</td>
      <td class="num muted">${fmtDuration(r.estimatedActiveMs + r.exactMs)}</td>
      <td class="track"><span class="fill" style="width:${((r.tokens.total / max) * 100).toFixed(1)}%"></span></td>
    </tr>`).join("\n    ")}
    </tbody>
  </table>
</section>`;
}

/**
 * Renders either shape — a single board's report or a portfolio merged from several. They
 * share every field this uses; the portfolio adds `kind`, `projects` and a `project`
 * breakdown, which is why the parameter is typed loosely rather than pinned to one of them.
 * @param {any} report  from buildUsageReport() or buildPortfolioUsage()
 * @param {{ top?: number }} [opts]
 */
export function renderUsageSnapshot(report, opts = {}) {
  const top = opts.top ?? 40;
  // One renderer, two shapes: a single board, or a portfolio merged from several. The
  // portfolio adds a project column and a project breakdown and changes nothing else — a
  // second renderer would be a second place for the numbers to drift.
  const isPortfolio = report.kind === "portfolio";
  const c = report.coverage;
  const t = report.totals;
  const attributedTokens = t.tokens.total - report.unassigned.tokens.total;
  const pct = t.tokens.total ? (attributedTokens / t.tokens.total) * 100 : 0;
  const day = (/** @type {string | null} */ d) => (d ? d.slice(0, 10) : "—");

  const reasonLabels = /** @type {Record<string, string>} */ ({
    "no-ticket-in-session": "No ticket named anywhere in the session",
    "before-first-signal": "Before the session's first ticket signal",
    "signal-expired": "Signal went stale, several tickets in play",
  });

  const projectRows = isPortfolio ? (report.projects || []) : [];
  const rows = report.tickets.slice(0, top).map((/** @type {any} */ tk) => {
    const time = tk.metrics.estimatedActiveMs + tk.metrics.exactMs;
    return `<tr class="row row--${esc(tk.timing)}">
      <td class="id"><span class="stripe stripe--${esc(tk.timing)}" title="${tk.timing === "exact" ? "Measured from run telemetry" : tk.timing === "mixed" ? "Part measured, part inferred" : "Inferred from transcripts"}"></span>${esc(tk.id)}</td>
      ${isPortfolio ? `<td class="proj">${esc(tk.project || "—")}</td>` : ""}
      <td class="name"><span class="ttl">${esc(tk.name) || "<em>untitled</em>"}</span><span class="meta">${esc(tk.area || "—")} · ${esc(tk.status || "—")}${tk.boardModel ? ` · board model ${esc(tk.boardModel)}` : ""}</span></td>
      <td><span class="chip chip--${esc(tk.confidence)}">${esc(tk.confidence)}</span></td>
      <td class="num strong">${fmtTokens(tk.metrics.tokens.total)}</td>
      <td class="barcell">${bar(tk.metrics.tokens)}</td>
      <td class="num">${fmtDuration(time)}</td>
      <td class="num muted">${fmtDuration(tk.metrics.spanMs)}</td>
      <td class="num muted">${tk.metrics.turns || "—"}${tk.metrics.runs ? `<span class="runs">+${tk.metrics.runs}r</span>` : ""}</td>
      <td class="models">${tk.breakdown.model.slice(0, 3).map((/** @type {any} */ m) => `<span class="mdl">${esc(m.key.replace(/^claude-/, "").replace(/-\d{8}$/, ""))}</span>`).join("")}</td>
    </tr>`;
  }).join("\n");

  return `<title>Agent Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
:root {
  --ground: #f6f7f6;
  --panel: #ffffff;
  --edge: #dfe3e2;
  --edge-soft: #ecefee;
  --ink: #151b1c;
  --ink-2: #4a5556;
  --ink-3: #7c8788;
  --accent: #0e7c86;
  --accent-soft: #d7ecee;
  --ok: #3f7a41;
  --warn: #9a6b16;
  --crit: #a33a2b;
  --tok-input: #0e7c86;
  --tok-output: #16505c;
  --tok-cw: #7fb3b6;
  --tok-cr: #c4d6d5;
  --serif: "Instrument Serif", Georgia, serif;
  --sans: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0e1213;
    --panel: #151a1b;
    --edge: #262f30;
    --edge-soft: #1d2425;
    --ink: #e8eceb;
    --ink-2: #a3aeae;
    --ink-3: #74807f;
    --accent: #4fbcc4;
    --accent-soft: #123033;
    --ok: #6fae6f;
    --warn: #c9a24a;
    --crit: #d9776a;
    --tok-input: #4fbcc4;
    --tok-output: #2b7f8a;
    --tok-cw: #1f5259;
    --tok-cr: #21353a;
  }
}
:root[data-theme="dark"] {
  --ground: #0e1213;
  --panel: #151a1b;
  --edge: #262f30;
  --edge-soft: #1d2425;
  --ink: #e8eceb;
  --ink-2: #a3aeae;
  --ink-3: #74807f;
  --accent: #4fbcc4;
  --accent-soft: #123033;
  --ok: #6fae6f;
  --warn: #c9a24a;
  --crit: #d9776a;
  --tok-input: #4fbcc4;
  --tok-output: #2b7f8a;
  --tok-cw: #1f5259;
  --tok-cr: #21353a;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 72px; display: flex; flex-direction: column; gap: 32px; }
header { display: flex; flex-direction: column; gap: 6px; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(34px, 5vw, 52px); line-height: 1.04; margin: 0; text-wrap: balance; letter-spacing: -.01em; }
h1 em { font-style: italic; color: var(--ink-2); }
.sub { color: var(--ink-2); max-width: 62ch; margin: 4px 0 0; }
.provenance { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; }
.provenance b { font-weight: 500; color: var(--ink-2); }

.meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 1px; background: var(--edge); border: 1px solid var(--edge); border-radius: 3px; overflow: hidden; }
.meter { background: var(--panel); padding: 16px 18px; display: flex; flex-direction: column; gap: 3px; }
.meter .k { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.meter .v { font-family: var(--mono); font-size: 26px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.meter .n { font-size: 12.5px; color: var(--ink-3); }
.meter--accent .v { color: var(--accent); }

.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.key { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.sw--input { background: var(--tok-input); } .sw--output { background: var(--tok-output); }
.sw--cacheWrite { background: var(--tok-cw); } .sw--cacheRead { background: var(--tok-cr); }

.tablewrap { overflow-x: auto; border: 1px solid var(--edge); border-radius: 3px; background: var(--panel); }
table.ledger { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 940px; }
.ledger thead th { text-align: left; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; padding: 12px 10px; border-bottom: 1px solid var(--edge); white-space: nowrap; }
.ledger td { padding: 11px 10px; border-bottom: 1px solid var(--edge-soft); vertical-align: middle; }
.ledger tr:last-child td { border-bottom: 0; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.strong { font-weight: 700; }
.muted { color: var(--ink-3); }
.id { font-family: var(--mono); font-weight: 500; white-space: nowrap; position: relative; padding-left: 18px !important; }
.stripe { position: absolute; left: 4px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--accent); }
.stripe--estimated { background: repeating-linear-gradient(180deg, var(--ink-3) 0 3px, transparent 3px 6px); }
.stripe--mixed { background: linear-gradient(180deg, var(--accent) 0 50%, transparent 50%), repeating-linear-gradient(180deg, var(--ink-3) 0 3px, transparent 3px 6px); }
.name { min-width: 240px; }
.ttl { display: block; line-height: 1.3; }
.meta { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); margin-top: 2px; }
.chip { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 7px; border-radius: 2px; border: 1px solid; white-space: nowrap; }
.chip--exact { color: var(--ok); border-color: var(--ok); }
.chip--high { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.chip--medium { color: var(--warn); border-color: var(--warn); }
.chip--unassigned { color: var(--ink-3); border-color: var(--edge); }
.barcell { width: 132px; }
.bar { display: flex; height: 9px; width: 122px; border-radius: 2px; overflow: hidden; background: var(--edge-soft); }
.seg--input { background: var(--tok-input); } .seg--output { background: var(--tok-output); }
.seg--cacheWrite { background: var(--tok-cw); } .seg--cacheRead { background: var(--tok-cr); }
.runs { color: var(--ok); margin-left: 4px; }
.models { white-space: nowrap; }
.proj { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
.mdl { font-family: var(--mono); font-size: 10px; color: var(--ink-2); border: 1px solid var(--edge); border-radius: 2px; padding: 1px 5px; margin-right: 3px; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.panel { border: 1px solid var(--edge); border-radius: 3px; background: var(--panel); padding: 16px 18px; }
.panel h3 { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; margin: 0 0 10px; }
table.dim { width: 100%; border-collapse: collapse; font-size: 13px; }
.dim th { text-align: left; font-weight: 400; padding: 4px 8px 4px 0; }
.dim td { padding: 4px 0 4px 8px; }
.dim .track { width: 34%; }
.fill { display: block; height: 6px; border-radius: 2px; background: var(--accent); opacity: .55; }

.note { border-left: 2px solid var(--accent); padding: 2px 0 2px 16px; color: var(--ink-2); font-size: 14px; max-width: 72ch; }
.note strong { color: var(--ink); }
.reasons { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.reasons li { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px dotted var(--edge); padding-bottom: 4px; }
.reasons .num { color: var(--ink-2); }
footer { color: var(--ink-3); font-size: 12px; font-family: var(--mono); border-top: 1px solid var(--edge); padding-top: 14px; }
h2 { font-family: var(--serif); font-weight: 400; font-size: 26px; margin: 0 0 2px; letter-spacing: -.01em; }
.sec { display: flex; flex-direction: column; gap: 12px; }
.sechead p { margin: 0; color: var(--ink-2); font-size: 13.5px; max-width: 68ch; }
</style>
<div class="wrap">
  <header>
    <span class="eyebrow">${esc(isPortfolio ? `${projectRows.filter((/** @type {any} */ p) => p.ok).length} projects` : report.project)} · agent ledger</span>
    <h1>What each ticket <em>actually</em> cost</h1>
    <p class="sub">Time and tokens per ticket, broken down by agent, model, runtime and stage. Rows marked <strong>measured</strong> come from run telemetry; the rest are inferred from local session transcripts and labelled with how confident that inference is.</p>
    <div class="provenance">
      <span>Generated <b>${esc(report.generatedAt.replace("T", " ").slice(0, 16))}Z</b></span>
      <span>Range <b>${esc(day(report.dateRange.from))} → ${esc(day(report.dateRange.to))}</b></span>
      <span>Transcripts <b>${report.enabled.transcripts ? `${c.transcriptSessions} sessions, ${c.transcriptFiles} files` : "not scanned (opt-in)"}</b></span>
      <span>Measured runs <b>${c.exactRuns}</b></span>
      <span>Schema <b>v${report.schema}</b></span>
    </div>
  </header>

  <div class="meters">
    <div class="meter meter--accent"><span class="k">Total tokens</span><span class="v">${fmtTokens(t.tokens.total)}</span><span class="n">${fmtTokens(t.tokens.thinking)} reasoning</span></div>
    <div class="meter"><span class="k">Agent working time</span><span class="v">${fmtDuration(t.estimatedActiveMs + t.exactMs)}</span><span class="n">idle gaps excluded</span></div>
    <div class="meter"><span class="k">Tied to a ticket</span><span class="v">${pct.toFixed(0)}%</span><span class="n">${fmtTokens(attributedTokens)} of ${fmtTokens(t.tokens.total)}</span></div>
    <div class="meter"><span class="k">Tickets with usage</span><span class="v">${c.ticketsWithUsage}</span><span class="n">of ${c.ticketsOnBoard} on the board</span></div>
    <div class="meter"><span class="k">Turns</span><span class="v">${t.turns.toLocaleString("en-US")}</span><span class="n">${c.exactRuns} measured runs</span></div>
  </div>

  <section class="sec">
    <div class="sechead">
      <h2>The ledger</h2>
      <p>Sorted by total tokens. The stripe on each id says where the numbers came from: solid is measured, dashed is inferred, split is both.</p>
    </div>
    <div class="legend">
      ${CLASSES.map(([k, label]) => `<span class="key"><span class="sw sw--${k}"></span>${label}</span>`).join("")}
      <span class="key"><span class="stripe" style="position:static;width:3px;height:12px"></span>measured</span>
      <span class="key"><span class="stripe stripe--estimated" style="position:static;width:3px;height:12px"></span>inferred</span>
    </div>
    <div class="tablewrap">
      <table class="ledger">
        <thead><tr>
          <th>Ticket</th>${isPortfolio ? "<th>Project</th>" : ""}<th>Name</th><th>Confidence</th><th>Tokens</th><th>Mix</th>
          <th>Working</th><th>Elapsed</th><th>Turns</th><th>Models</th>
        </tr></thead>
        <tbody>
${rows || `<tr><td colspan="${isPortfolio ? 10 : 9}" class="muted" style="padding:24px">No usage recorded yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </section>

  ${isPortfolio ? `<section class="sec">
    <div class="sechead">
      <h2>By project</h2>
      <p>Each project measured by its own board, then summed. A repo nested inside another keeps its own tokens — ownership goes to the deepest matching root, never to both.</p>
    </div>
    <div class="tablewrap">
      <table class="ledger">
        <thead><tr><th>Project</th><th>Tokens</th><th>Mix</th><th>Working</th><th>Turns</th><th>Tickets w/ usage</th><th>Tied to a ticket</th><th>Top ticket</th></tr></thead>
        <tbody>
        ${projectRows.map((/** @type {any} */ p) => p.ok ? `<tr>
          <td class="id">${esc(p.name)}</td>
          <td class="num strong">${fmtTokens(p.totals.tokens.total)}</td>
          <td class="barcell">${bar(p.totals.tokens)}</td>
          <td class="num">${fmtDuration(p.totals.estimatedActiveMs + p.totals.exactMs)}</td>
          <td class="num muted">${p.totals.turns.toLocaleString("en-US")}</td>
          <td class="num muted">${p.coverage.ticketsWithUsage} / ${p.coverage.ticketsOnBoard}</td>
          <td class="num muted">${p.totals.tokens.total ? (((p.totals.tokens.total - p.coverage.unassignedTokens) / p.totals.tokens.total) * 100).toFixed(0) : 0}%</td>
          <td class="muted" style="font-size:12px">${p.topTicket ? `${esc(p.topTicket.id)} · ${fmtTokens(p.topTicket.total)}` : "—"}</td>
        </tr>` : `<tr><td class="id">${esc(p.name)}</td><td colspan="7" class="muted" style="font-size:12px">${esc(p.error || "could not be read")}</td></tr>`).join("\n        ")}
        </tbody>
      </table>
    </div>
  </section>` : ""}

  <section class="sec">
    <div class="sechead">
      <h2>Breakdowns</h2>
      <p>The same totals cut five ways. Tokens first, working time second.</p>
    </div>
    <div class="grid">
      ${isPortfolio ? dimensionPanel(/** @type {any[]} */ (report.breakdown.project), "By project") : ""}
      ${dimensionPanel(/** @type {any[]} */ (report.breakdown.model), "By model")}
      ${dimensionPanel(/** @type {any[]} */ (report.breakdown.agent), "By agent")}
      ${dimensionPanel(/** @type {any[]} */ (report.breakdown.runtime), "By runtime")}
      ${dimensionPanel(/** @type {any[]} */ (report.breakdown.stage), "By stage")}
      ${dimensionPanel(/** @type {any[]} */ (report.breakdown.date).slice(0, 10), "By date")}
    </div>
  </section>

  <section class="sec">
    <div class="sechead"><h2>What isn't counted</h2></div>
    <p class="note">
      <strong>${fmtTokens(report.unassigned.tokens.total)} tokens across ${report.unassigned.turns.toLocaleString("en-US")} turns</strong> could not be tied to a ticket.
      That is reported rather than distributed: spreading it across tickets would make every row above look precise and be wrong.
      The reasons matter differently — work that never named a ticket is a fact about how the work ran, not a limitation of the reading.
    </p>
    <ul class="reasons">
      ${Object.entries(c.unassignedReasons || {}).sort((a, b) => Number(b[1]) - Number(a[1])).map(([k, v]) => `<li><span>${esc(reasonLabels[k] || k)}</span><span class="num">${Number(v).toLocaleString("en-US")} turns</span></li>`).join("\n      ")}
    </ul>
  </section>

  <footer>
    Aggregates only — no prompts, responses, commands or source text are read into this page or persisted anywhere.
    Working time counts gaps between turns capped at 5 minutes; longer gaps are idle, not agent work. Reasoning tokens are a subset of output and are not added to the total.
    Token counts only: no cost is shown, because rates vary by account and a subscription has no per-token price.
  </footer>
</div>`;
}
