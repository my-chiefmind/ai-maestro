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
    --json                 print the full report as JSON
    --csv [view]           print CSV: tickets (default) | ${DIMENSIONS.join(" | ")}
    --html <file>          write a self-contained snapshot page (aggregates only)
    --top <n>              rows to print in the table (default 20)
    --no-cache             re-read every transcript instead of using the mtime cache

  Reading Claude Code transcripts is opt-in — set "usage": { "scanTranscripts": true } in
  config.json, or pass MAESTRO_USAGE_SCAN=1. Nothing but aggregates is ever persisted.
`);
  process.exit(0);
}

const boardDir = resolve(flag("board", join(process.cwd(), "board")));
const report = buildUsageReport({ boardDir, useCache: !has("no-cache") });

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
process.stdout.write(`\n  ${report.project} — agent usage\n`);
process.stdout.write(`  ${report.dateRange.from?.slice(0, 10) || "—"} → ${report.dateRange.to?.slice(0, 10) || "—"}   `);
process.stdout.write(`transcripts: ${report.enabled.transcripts ? `on (${c.transcriptSessions} sessions)` : "off (opt-in)"}   telemetry: ${c.exactRuns} measured runs\n\n`);

process.stdout.write(`  ${pad("TICKET", 7)}${pad("CONF", 7)}${pad("TIMING", 10)}${rpad("TOKENS", 8)}${rpad("ACTIVE", 8)}${rpad("SPAN", 8)}  NAME\n`);
for (const t of report.tickets.slice(0, Number(flag("top", 20)))) {
  process.stdout.write(`  ${pad(t.id, 7)}${pad(t.confidence, 7)}${pad(t.timing, 10)}${rpad(M(t.metrics.tokens.total), 8)}${rpad(H(t.metrics.estimatedActiveMs + t.metrics.exactMs), 8)}${rpad(H(t.metrics.spanMs), 8)}  ${t.name.slice(0, 44)}\n`);
}

for (const d of DIMENSIONS) {
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
