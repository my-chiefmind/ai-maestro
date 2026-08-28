#!/usr/bin/env node
// @ts-check
/**
 * usage-report.mjs — `maestro usage`: what each ticket cost in time and tokens.
 *
 * Prints the same figures the cockpit's Value page shows, from the same aggregation
 * (scripts/usage-core.mjs), so a terminal answer and a dashboard answer can never disagree.
 * `--json` and `--csv` are the export half of that promise, and `--html` writes the
 * self-contained snapshot described in docs/USAGE.md.
 *
 * Transcript reading is OPT-IN: without `usage.scanTranscripts` in config.json (or
 * MAESTRO_USAGE_SCAN=1) only measured run telemetry is reported, and the header says so.
 */
import { writeFileSync } from "fs";
import { resolve, join } from "path";
import { buildUsageReport, usageToCsv, DIMENSIONS } from "./usage-core.mjs";
import { renderUsageSnapshot } from "./usage-snapshot.mjs";
import { buildPortfolioUsage, discoverProjects, projectsFromRegistry, PORTFOLIO_DIMENSIONS } from "./usage-portfolio.mjs";

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n, /** @type {any} */ d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (/** @type {string} */ n) => argv.includes(`--${n}`);

if (has("help") || argv[0] === "-h") {
  process.stdout.write(`
  maestro usage            time and tokens per ticket, by agent, model, runtime, stage and date

  Flags:
    --board <dir>          board directory (default: ./board)
    --all                  roll up every project instead of one board; needs --registry or
                             --discover. A repo nested inside another keeps its own tokens.
    --registry <file>      project list for --all (default: ./maestro-registry.json)
    --discover <dir>       ad-hoc --all: find Maestro projects under <dir>, no registry needed
    --json                 print the full report as JSON
    --csv [view]           print CSV: tickets (default) | ${DIMENSIONS.join(" | ")}
    --html <file>          write a self-contained snapshot page (aggregates only)
    --top <n>              rows to print in the table (default 20)
    --no-cache             re-read every transcript instead of using the mtime cache

  Across projects:
    maestro usage --discover ~/source          ad-hoc rollup, no registry file
    maestro usage --all --registry <file>      the shared registry format

  Reading Claude Code transcripts is opt-in — set "usage": { "scanTranscripts": true } in
  config.json, or pass MAESTRO_USAGE_SCAN=1. Nothing but aggregates is ever persisted.
`);
  process.exit(0);
}

const useCache = !has("no-cache");
let report;
if (has("all") || flag("discover") || flag("registry")) {
  const discover = flag("discover");
  let projects;
  if (discover) {
    projects = discoverProjects(discover, { depth: Number(flag("depth", 2)) });
    if (!projects.length) {
      console.error(`✗ No Maestro projects found under ${resolve(discover)} — a project has board/data.json or maestro/board/data.json.`);
      process.exit(1);
    }
  } else {
    const registryPath = resolve(flag("registry", join(process.cwd(), "maestro-registry.json")));
    try {
      projects = projectsFromRegistry(registryPath);
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  Pass --registry <file>, or --discover <dir> to roll up without one.`);
      process.exit(1);
    }
  }
  report = buildPortfolioUsage({ projects, useCache });
} else {
  const boardDir = resolve(flag("board", join(process.cwd(), "board")));
  report = buildUsageReport({ boardDir, useCache });
}
const isPortfolio = report.kind === "portfolio";

if (has("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}
if (has("csv")) {
  const i = argv.indexOf("--csv");
  const next = argv[i + 1];
  const view = next && !next.startsWith("--") ? next : "tickets";
  process.stdout.write(usageToCsv(report, { view: /** @type {any} */ (view) }));
  process.exit(0);
}
const htmlOut = flag("html");
if (htmlOut) {
  writeFileSync(resolve(htmlOut), renderUsageSnapshot(report), "utf8");
  process.stdout.write(`✓ snapshot written to ${resolve(htmlOut)}\n`);
  process.exit(0);
}

const M = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const H = (/** @type {number} */ ms) => `${(ms / 3600000).toFixed(1)}h`;
const pad = (/** @type {any} */ v, /** @type {number} */ n) => String(v).padEnd(n);
const rpad = (/** @type {any} */ v, /** @type {number} */ n) => String(v).padStart(n);

const c = report.coverage;
const title = isPortfolio ? `portfolio — ${c.projectsRead} project(s)` : report.project;
process.stdout.write(`\n  ${title} — agent usage\n`);
process.stdout.write(`  ${report.dateRange.from?.slice(0, 10) || "—"} → ${report.dateRange.to?.slice(0, 10) || "—"}   `);
process.stdout.write(`transcripts: ${report.enabled.transcripts ? `on (${c.transcriptSessions} sessions)` : "off (opt-in)"}   telemetry: ${c.exactRuns} measured runs\n\n`);

if (isPortfolio) {
  process.stdout.write(`  ${pad("PROJECT", 22)}${rpad("TOKENS", 9)}${rpad("WORKING", 9)}${rpad("TURNS", 8)}${rpad("TIED", 6)}  TICKETS\n`);
  for (const p of report.projects) {
    if (!p.ok) { process.stdout.write(`  ${pad(p.name, 22)}${rpad("—", 9)}  ${p.error}\n`); continue; }
    const tied = p.totals.tokens.total ? ((p.totals.tokens.total - p.coverage.unassignedTokens) / p.totals.tokens.total) * 100 : 0;
    process.stdout.write(`  ${pad(p.name, 22)}${rpad(M(p.totals.tokens.total), 9)}${rpad(H(p.totals.estimatedActiveMs + p.totals.exactMs), 9)}${rpad(p.totals.turns, 8)}${rpad(`${tied.toFixed(0)}%`, 6)}  ${p.coverage.ticketsWithUsage}/${p.coverage.ticketsOnBoard}\n`);
  }
  process.stdout.write("\n");
}

process.stdout.write(`  ${pad("TICKET", 7)}${isPortfolio ? pad("PROJECT", 16) : ""}${pad("CONF", 7)}${rpad("TOKENS", 8)}${rpad("ACTIVE", 8)}${rpad("SPAN", 8)}  NAME\n`);
for (const t of report.tickets.slice(0, Number(flag("top", 20)))) {
  process.stdout.write(`  ${pad(t.id, 7)}${isPortfolio ? pad(String(t.project).slice(0, 15), 16) : ""}${pad(t.confidence, 7)}${rpad(M(t.metrics.tokens.total), 8)}${rpad(H(t.metrics.estimatedActiveMs + t.metrics.exactMs), 8)}${rpad(H(t.metrics.spanMs), 8)}  ${t.name.slice(0, 40)}\n`);
}

for (const d of (isPortfolio ? PORTFOLIO_DIMENSIONS : DIMENSIONS)) {
  const rows = /** @type {any[]} */ (report.breakdown[d]).slice(0, d === "date" ? 7 : 8);
  if (!rows.length) continue;
  process.stdout.write(`\n  BY ${d.toUpperCase()}\n`);
  for (const r of rows) {
    process.stdout.write(`  ${pad(r.key, 30)}${rpad(M(r.tokens.total), 8)}${rpad(H(r.estimatedActiveMs + r.exactMs), 8)}  ${r.turns} turns${r.runs ? `, ${r.runs} runs` : ""}\n`);
  }
}

const un = report.unassigned;
process.stdout.write(`\n  UNATTRIBUTED  ${M(un.tokens.total)} tokens over ${un.turns} turns${c.unassignedReasons ? ":" : ""}\n`);
for (const [reason, n] of Object.entries(c.unassignedReasons || {})) {
  process.stdout.write(`    ${pad(reason, 24)}${rpad(n, 6)} turns\n`);
}
process.stdout.write("\n");
