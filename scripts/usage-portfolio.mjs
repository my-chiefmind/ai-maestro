#!/usr/bin/env node
// @ts-check
/**
 * usage-portfolio.mjs — one usage picture across every Maestro-managed project.
 *
 * A single board answers "what did this ticket cost". This answers the question that follows:
 * across all the apps, where is the time and where are the tokens going — still per ticket,
 * because a portfolio total nobody can drill into is a number, not an answer.
 *
 * It is a MERGE, not a second aggregation. Each project is measured by the same
 * `buildUsageReport()` the single-board page and the CLI use, and this file only sums the
 * results. There is therefore no way for the portfolio total and a project's own page to
 * disagree about that project.
 *
 * NESTED PROJECTS ARE THE TRAP. Real portfolios contain a repo inside another repo — a group
 * checkout with its own board under a kit that also has one. Both match on a path prefix, so a
 * naive rollup counts the inner project twice and credits the outer with work it never did.
 * Every project is therefore reported with every OTHER project's roots as `excludeRoots`, and
 * ownership goes to the deepest matching root (see `ownsCwd` in usage-scan.mjs).
 *
 * A project that cannot be read is reported as a failed row, never dropped: a portfolio that
 * silently omits a board reads as "that project did no work".
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { buildUsageReport, rootsForBoard, DIMENSIONS } from "./usage-core.mjs";
import { readRegistry, expandHome, findKitDir } from "./registry.mjs";

/** The portfolio adds one dimension the single-board report cannot have. */
export const PORTFOLIO_DIMENSIONS = ["project", ...DIMENSIONS];

/**
 * A board holding nothing but starter placeholders has never been used. That is worth SAYING —
 * "this project exists and no work has been booked to it" is a real answer — so such a project
 * is flagged, not dropped. Hiding it would repeat the mistake the unattributed panel exists to
 * avoid: silence reading as zero.
 * @param {string} boardDir
 */
function isTemplateBoard(boardDir) {
  try {
    const data = JSON.parse(readFileSync(join(boardDir, "data.json"), "utf8"));
    const tickets = data?.tickets || [];
    return tickets.length > 0 && tickets.every((/** @type {any} */ t) => t?.sample === true);
  } catch { return false; }
}

/**
 * Find Maestro-managed projects under a directory, for an ad-hoc rollup with no registry file.
 * A project is a directory holding either `board/data.json` (the kit itself) or
 * `maestro/board/data.json` (the vendored layout `maestro setup` produces).
 *
 * Two things it must not do, both of which a first pass did:
 *
 *   - Register `<project>/maestro` as a project in its own right. It holds `board/data.json`,
 *     so it looks exactly like one, and you end up with 21 projects all called "maestro"
 *     sharing their parent's board and roots. The vendored kit dir is CONSUMED by the project
 *     that owns it and never walked into again.
 *   - Stop descending once a project is found. A project can legitimately contain another —
 *     a group checkout inside a kit — and skipping the subtree is how a nested board goes
 *     missing from the rollup entirely.
 *
 * @param {string} rootDir
 * @param {{ depth?: number }} [opts]
 * @returns {Array<{ name: string, path: string, kitDir: string, template: boolean }>}
 */
export function discoverProjects(rootDir, opts = {}) {
  const maxDepth = opts.depth ?? 2;
  /** @type {Array<{ name: string, path: string, kitDir: string, template: boolean }>} */
  const found = [];
  const seen = new Set();
  const consumed = new Set();

  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (consumed.has(p)) continue;
      // The kit ships a starter board under starters/ as template content, not as work.
      if (p.includes(`${sep}starters${sep}`) || e.name === "starters") { if (depth < maxDepth) walk(p, depth + 1); continue; }
      const vendored = join(p, "maestro");
      const kitDir = existsSync(join(vendored, "board", "data.json")) ? vendored
        : existsSync(join(p, "board", "data.json")) ? p
          : null;
      if (kitDir && !seen.has(p)) {
        if (kitDir !== p) consumed.add(kitDir);
        seen.add(p);
        found.push({ name: e.name, path: p, kitDir, template: isTemplateBoard(join(kitDir, "board")) });
      }
      if (depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(resolve(expandHome(rootDir)), 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the project list from a registry file, in the shared format every other
 * cross-project command reads (scripts/registry.mjs).
 * @param {string} registryPath
 * @returns {Array<{ name: string, path: string, kitDir: string | null }>}
 */
export function projectsFromRegistry(registryPath) {
  const { projects } = readRegistry(registryPath);
  return projects.map((p) => ({ name: p.name, path: p.path, kitDir: findKitDir(p.path) }));
}

/** @typedef {import("./usage-core.mjs").buildUsageReport} _B */

const zero = () => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 0 },
  turns: 0, runs: 0, estimatedActiveMs: 0, exactMs: 0, spanMs: 0, firstTs: null, lastTs: null,
});

/** @param {any} a @param {any} b */
function mergeMetrics(a, b) {
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "thinking", "total"]) a.tokens[k] += b.tokens[k] || 0;
  a.turns += b.turns || 0;
  a.runs += b.runs || 0;
  a.estimatedActiveMs += b.estimatedActiveMs || 0;
  a.exactMs += b.exactMs || 0;
  if (b.firstTs != null && (a.firstTs === null || b.firstTs < a.firstTs)) a.firstTs = b.firstTs;
  if (b.lastTs != null && (a.lastTs === null || b.lastTs > a.lastTs)) a.lastTs = b.lastTs;
  a.spanMs = a.firstTs !== null && a.lastTs !== null ? a.lastTs - a.firstTs : 0;
  return a;
}

/** @param {Map<string, any>} into @param {any[]} rows */
function mergeBuckets(into, rows) {
  for (const r of rows || []) {
    let b = into.get(r.key);
    if (!b) into.set(r.key, (b = { key: r.key, ...zero() }));
    mergeMetrics(b, r);
  }
}

/**
 * @param {{
 *   projects: Array<{ name: string, path: string, kitDir: string | null }>,
 *   projectsDir?: string, cacheFile?: string, env?: NodeJS.ProcessEnv,
 *   useCache?: boolean, config?: any,
 * }} opts
 */
export function buildPortfolioUsage(opts) {
  const entries = opts.projects.filter((p) => p.kitDir);
  const notSetUp = opts.projects.filter((p) => !p.kitDir).map((p) => ({ name: p.name, path: p.path, ok: false, error: "not set up (no maestro kit dir)" }));

  // Every project's roots, so each report can exclude the others and a nested board keeps its
  // own tokens instead of being counted on both.
  // Keyed by PATH, never by name. Two groups can legitimately hold a project of the same
  // name, and a name-keyed map silently collapses them — every duplicate then inherits the
  // last one's roots, excludes its own work, and reports zero.
  const rootsByPath = new Map(entries.map((p) => [p.path, rootsForBoard(join(/** @type {string} */(p.kitDir), "board"))]));
  const allRoots = [...new Set([...rootsByPath.values()].flat())];

  /** @type {any[]} */
  const projectRows = [];
  /** @type {any[]} */
  const tickets = [];
  const totals = zero();
  const unassigned = zero();
  /** @type {Map<string, Map<string, any>>} */
  const breakdown = new Map(PORTFOLIO_DIMENSIONS.map((d) => [d, new Map()]));
  const coverage = {
    turns: 0, attributed: 0, exactRuns: 0, transcriptSessions: 0, transcriptFiles: 0,
    ticketsOnBoard: 0, ticketsWithUsage: 0, unassignedTokens: 0, unassignedTurns: 0,
    byConfidence: /** @type {Record<string, number>} */ ({}),
    unassignedReasons: /** @type {Record<string, number>} */ ({}),
    projectsRead: 0, projectsFailed: 0,
  };
  let scanning = false;

  for (const p of entries) {
    const boardDir = join(/** @type {string} */(p.kitDir), "board");
    const mine = rootsByPath.get(p.path) || [];
    const excludeRoots = allRoots.filter((r) => !mine.includes(r));
    let report;
    try {
      report = buildUsageReport({
        boardDir, roots: mine, excludeRoots,
        projectsDir: opts.projectsDir, cacheFile: opts.cacheFile,
        env: opts.env, useCache: opts.useCache,
        ...(opts.config !== undefined ? { config: opts.config } : {}),
      });
    } catch (e) {
      coverage.projectsFailed++;
      projectRows.push({ name: p.name, path: p.path, boardDir, ok: false, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    coverage.projectsRead++;
    scanning = scanning || report.enabled.transcripts;

    mergeMetrics(totals, report.totals);
    mergeMetrics(unassigned, report.unassigned);
    for (const d of DIMENSIONS) mergeBuckets(/** @type {Map<string, any>} */(breakdown.get(d)), /** @type {any[]} */ (report.breakdown[d] || []));
    // The project dimension exists only up here — a single board cannot produce it.
    mergeBuckets(/** @type {Map<string, any>} */(breakdown.get("project")), [{ key: p.name, ...report.totals }]);

    const c = report.coverage;
    coverage.turns += c.turns; coverage.attributed += c.attributed;
    coverage.exactRuns += c.exactRuns;
    coverage.transcriptSessions += c.transcriptSessions; coverage.transcriptFiles += c.transcriptFiles;
    coverage.ticketsOnBoard += c.ticketsOnBoard; coverage.ticketsWithUsage += c.ticketsWithUsage;
    coverage.unassignedTokens += c.unassignedTokens; coverage.unassignedTurns += c.unassignedTurns;
    for (const [k, v] of Object.entries(c.byConfidence || {})) coverage.byConfidence[k] = (coverage.byConfidence[k] || 0) + Number(v);
    for (const [k, v] of Object.entries(c.unassignedReasons || {})) coverage.unassignedReasons[k] = (coverage.unassignedReasons[k] || 0) + Number(v);

    for (const t of report.tickets) tickets.push({ ...t, project: p.name });

    projectRows.push({
      name: p.name, path: p.path, boardDir, ok: true,
      template: Boolean(/** @type {any} */ (p).template),
      totals: report.totals,
      dateRange: report.dateRange,
      coverage: {
        turns: c.turns, attributed: c.attributed, exactRuns: c.exactRuns,
        ticketsOnBoard: c.ticketsOnBoard, ticketsWithUsage: c.ticketsWithUsage,
        unassignedTokens: c.unassignedTokens,
      },
      topTicket: report.tickets[0] ? { id: report.tickets[0].id, name: report.tickets[0].name, total: report.tickets[0].metrics.tokens.total } : null,
    });
  }

  const listOf = (/** @type {Map<string, any>} */ m) => [...m.values()].sort((a, b) => b.tokens.total - a.tokens.total || a.key.localeCompare(b.key));

  return {
    generatedAt: new Date().toISOString(),
    schema: 1,
    kind: "portfolio",
    project: "portfolio",
    enabled: { transcripts: scanning, telemetry: true },
    dateRange: {
      from: totals.firstTs ? new Date(totals.firstTs).toISOString() : null,
      to: totals.lastTs ? new Date(totals.lastTs).toISOString() : null,
    },
    projects: [...projectRows, ...notSetUp].sort((a, b) => (b.totals?.tokens.total || 0) - (a.totals?.tokens.total || 0)),
    coverage,
    totals,
    unassigned,
    tickets: tickets.sort((a, b) => b.metrics.tokens.total - a.metrics.tokens.total),
    breakdown: Object.fromEntries(PORTFOLIO_DIMENSIONS.map((d) => [d, listOf(/** @type {Map<string, any>} */(breakdown.get(d)))])),
  };
}
