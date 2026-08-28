#!/usr/bin/env node
// @ts-check
/**
 * usage-core.mjs — the one aggregation the whole feature reports through.
 *
 * Two sources of truth feed it and they are never mixed up:
 *
 *   EXACT       run telemetry (scripts/telemetry-io.mjs) — measured start/end and, where the
 *               runtime reported them, real token counts.
 *   ESTIMATED   Claude Code transcripts, attributed to tickets by inference
 *               (scripts/usage-attribute.mjs) with a confidence and the evidence for it.
 *
 * A ticket worked both ways shows `timing: "mixed"`, and the estimated and exact figures stay
 * separately addressable all the way to the UI. What the dashboard must never do is present
 * an inference as a measurement, so nothing here averages the two into one unlabelled number.
 *
 * DOUBLE COUNTING is the failure mode this file is built to prevent. A `maestro run` writes a
 * telemetry record AND leaves a transcript behind. Both describe the same tokens. The
 * telemetry record carries the `sessionId`, so those sessions are excluded from the
 * transcript pass (`attribute(..., { exactSessions })`) and the measured figure wins. The
 * count of turns dropped that way is reported as `coverage.skippedExact` rather than being
 * silently swallowed.
 *
 * OPT-IN. Reading transcripts is off unless the project asks for it — `config.json`'s
 * `usage.scanTranscripts: true`, or `MAESTRO_USAGE_SCAN=1` for a one-off. Telemetry, which
 * this kit writes about its own runs, needs no opt-in. `report.enabled` says which halves ran
 * so a UI can explain an empty table instead of implying there was no work.
 *
 * TOKENS ONLY. Every counter here is a token count or a duration. There is deliberately no
 * price table: rates change, differ per account, and a subscription has no per-token price at
 * all — a dollar figure computed from today's list price and yesterday's tokens would be
 * confidently wrong. The record schema leaves room for cost to arrive later
 * (telemetry-io.mjs), which is a different thing from inventing it now.
 */
import { existsSync, readFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { scanTranscripts, zeroUsage, addUsage, totalTokens } from "./usage-scan.mjs";
import { attribute, ticketIndex, DEFAULTS, rank } from "./usage-attribute.mjs";
import { readRuns } from "./telemetry-io.mjs";

export { totalTokens };

/** Dimensions the report breaks every total down by. Order is the UI's tab order. */
export const DIMENSIONS = ["model", "agent", "runtime", "stage", "date"];

/** @typedef {import("./usage-scan.mjs").Usage} Usage */

/**
 * @typedef {{
 *   tokens: Usage & { total: number },
 *   turns: number, runs: number,
 *   estimatedActiveMs: number, exactMs: number, spanMs: number,
 *   firstTs: number | null, lastTs: number | null,
 * }} Metrics
 */

/** @returns {Metrics} */
function zeroMetrics() {
  return {
    tokens: { ...zeroUsage(), total: 0 },
    turns: 0, runs: 0,
    estimatedActiveMs: 0, exactMs: 0, spanMs: 0,
    firstTs: null, lastTs: null,
  };
}

/**
 * @param {Metrics} m
 * @param {{ usage: Usage | null, ts: number, endTs?: number, exact: boolean, durationMs: number }} s
 */
function accumulate(m, s) {
  if (s.usage) {
    addUsage(m.tokens, s.usage);
    m.tokens.total = totalTokens(m.tokens);
  }
  if (s.exact) { m.runs++; m.exactMs += s.durationMs; }
  else { m.turns++; m.estimatedActiveMs += s.durationMs; }
  const end = s.endTs ?? s.ts;
  if (m.firstTs === null || s.ts < m.firstTs) m.firstTs = s.ts;
  if (m.lastTs === null || end > m.lastTs) m.lastTs = end;
  m.spanMs = m.firstTs !== null && m.lastTs !== null ? m.lastTs - m.firstTs : 0;
}

/**
 * A flat, source-agnostic observation. Both halves normalise into this so there is exactly
 * one aggregation loop and the two can never drift apart in how they're totalled.
 * @typedef {{
 *   ticketId: string | null, model: string, agent: string, runtime: string, stage: string,
 *   date: string, usage: Usage | null, ts: number, endTs?: number, durationMs: number,
 *   exact: boolean, confidence: string, evidence: string | null, sessionId: string,
 * }} Sample
 */

/** @param {number} ts */
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Is transcript scanning permitted? Opt-in, and the answer is reported to the UI rather than
 * being an invisible reason the numbers look thin.
 * @param {any} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function transcriptScanEnabled(config, env = process.env) {
  if (env.MAESTRO_USAGE_SCAN === "1" || env.MAESTRO_USAGE_SCAN === "true") return true;
  if (env.MAESTRO_USAGE_SCAN === "0" || env.MAESTRO_USAGE_SCAN === "false") return false;
  return config?.usage?.scanTranscripts === true;
}

/**
 * The repo roots whose sessions belong to this board. In a managed project the kit is
 * vendored at `<project>/maestro`, but the agent's cwd — and therefore the transcript
 * directory — is `<project>`, so the parent is included when that is the layout.
 * @param {string} boardDir
 * @returns {string[]}
 */
export function rootsForBoard(boardDir) {
  const projectDir = resolve(boardDir, "..");
  const roots = [projectDir];
  if (basename(projectDir) === "maestro") roots.push(dirname(projectDir));
  return roots;
}

/**
 * Build the report.
 *
 * @param {{
 *   boardDir: string,
 *   data?: any, archive?: any, config?: any,
 *   roots?: string[], projectsDir?: string, cacheFile?: string,
 *   env?: NodeJS.ProcessEnv, useCache?: boolean,
 *   tuning?: Partial<typeof DEFAULTS>,
 * }} opts
 */
export function buildUsageReport(opts) {
  const boardDir = opts.boardDir;
  const readJson = (/** @type {string} */ p) => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; }
  };
  const data = opts.data !== undefined ? opts.data : readJson(resolve(boardDir, "data.json"));
  const archive = opts.archive !== undefined ? opts.archive : readJson(resolve(boardDir, "archive.json"));
  const config = opts.config !== undefined ? opts.config : readJson(resolve(boardDir, "..", "config.json"));
  const index = ticketIndex(data, archive);
  const roots = opts.roots || rootsForBoard(boardDir);

  // ── Exact half ────────────────────────────────────────────────────────────────────────
  const { runs, skipped: telemetrySkipped } = readRuns(boardDir);
  /** @type {Sample[]} */
  const samples = [];
  const exactSessions = new Set();
  for (const r of runs) {
    if (r.sessionId) exactSessions.add(r.sessionId);
    const ts = Date.parse(r.startedAt);
    const endTs = r.endedAt ? Date.parse(r.endedAt) : ts;
    samples.push({
      ticketId: index.has(r.ticketId) ? r.ticketId : r.ticketId, // a run names its ticket; trust it
      model: r.modelId || r.model || "unknown",
      agent: r.agent || r.role || r.stage || "run",
      runtime: r.runtime || "unknown",
      stage: r.stage || r.role || "unknown",
      date: dayOf(ts),
      usage: r.usage || null,
      ts, endTs,
      durationMs: r.durationMs ?? Math.max(0, endTs - ts),
      exact: true,
      confidence: "exact",
      evidence: `telemetry:${r.runId}`,
      sessionId: r.sessionId || "",
    });
  }

  // ── Estimated half ────────────────────────────────────────────────────────────────────
  const scanning = transcriptScanEnabled(config, opts.env);
  let coverage = { turns: 0, attributed: 0, byConfidence: /** @type {Record<string, number>} */ ({}), unassignedReasons: /** @type {Record<string, number>} */ ({}), skippedExact: 0 };
  let scanStats = { sessions: 0, files: 0 };
  if (scanning) {
    const scan = scanTranscripts({
      roots,
      projectsDir: opts.projectsDir,
      cacheFile: opts.cacheFile,
      useCache: opts.useCache,
    });
    scanStats = { sessions: scan.sessions, files: scan.files };
    const attributed = attribute(scan.events, index, { ...opts.tuning, exactSessions });
    coverage = attributed.coverage;
    for (const t of attributed.turns) {
      samples.push({
        ticketId: t.ticketId,
        model: t.model,
        agent: t.agentType,
        runtime: "claude",
        stage: "unknown",
        date: dayOf(t.ts),
        usage: t.usage,
        ts: t.ts,
        durationMs: t.activeMs,
        exact: false,
        confidence: t.confidence,
        evidence: t.evidence,
        sessionId: t.sessionId,
      });
    }
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────────────────
  /** @type {Map<string, any>} */
  const tickets = new Map();
  const totals = zeroMetrics();
  const unassigned = zeroMetrics();
  /** @type {Map<string, Map<string, Metrics>>} */
  const global = new Map(DIMENSIONS.map((d) => [d, /** @type {Map<string, Metrics>} */ (new Map())]));
  /** @param {Map<string, Map<string, Metrics>>} m @param {string} d */
  const dim = (m, d) => {
    let g = m.get(d);
    if (!g) m.set(d, (g = new Map()));
    return g;
  };

  /** @param {Map<string, Metrics>} m @param {string} k @param {Sample} s */
  const into = (m, k, s) => {
    let b = m.get(k);
    if (!b) m.set(k, (b = zeroMetrics()));
    accumulate(b, s);
  };

  for (const s of samples) {
    accumulate(totals, s);
    for (const d of DIMENSIONS) into(dim(global, d), /** @type {any} */ (s)[d], s);

    if (!s.ticketId) { accumulate(unassigned, s); continue; }
    let row = tickets.get(s.ticketId);
    if (!row) {
      const meta = index.get(s.ticketId);
      row = {
        id: s.ticketId,
        onBoard: Boolean(meta),
        name: meta?.name || "",
        status: meta?.status || "",
        area: meta?.area || "",
        epicId: meta?.epicId || "",
        epicName: meta?.epicName || "",
        boardModel: meta?.model || "",
        agentPlan: meta?.agentPlan || [],
        executionMode: meta?.executionMode || "",
        swag: meta?.swag || "",
        priority: meta?.priority || "",
        archived: meta?.archived ?? false,
        doneAt: meta?.doneAt || null,
        metrics: zeroMetrics(),
        confidence: "unassigned",
        evidence: /** @type {Set<string>} */ (new Set()),
        breakdown: new Map(DIMENSIONS.map((d) => [d, /** @type {Map<string, Metrics>} */ (new Map())])),
        hasExact: false,
        hasEstimated: false,
        exactFirstTs: /** @type {number | null} */ (null),
        exactLastTs: /** @type {number | null} */ (null),
      };
      tickets.set(s.ticketId, row);
    }
    accumulate(row.metrics, s);
    if (s.exact) {
      // Cycle time is measured, so it is tracked only across measured runs: first stage start
      // to last stage end. Mixing in an inferred transcript timestamp would turn an exact
      // number into an estimate wearing an exact label.
      const end = s.endTs ?? s.ts;
      if (row.exactFirstTs === null || s.ts < row.exactFirstTs) row.exactFirstTs = s.ts;
      if (row.exactLastTs === null || end > row.exactLastTs) row.exactLastTs = end;
    }
    for (const d of DIMENSIONS) into(dim(row.breakdown, d), /** @type {any} */ (s)[d], s);
    if (s.evidence) row.evidence.add(s.evidence);
    if (rank(s.confidence) < rank(row.confidence)) row.confidence = s.confidence;
    if (s.exact) row.hasExact = true; else row.hasEstimated = true;
  }

  /** @param {Map<string, Metrics>} m */
  const listOf = (m) => [...m.entries()]
    .map(([key, metrics]) => ({ key, ...metrics }))
    .sort((a, b) => b.tokens.total - a.tokens.total || a.key.localeCompare(b.key));

  const ticketRows = [...tickets.values()].map((r) => ({
    ...r,
    evidence: [...r.evidence].sort(),
    timing: r.hasExact && r.hasEstimated ? "mixed" : r.hasExact ? "exact" : "estimated",
    cycleMs: r.exactFirstTs !== null && r.exactLastTs !== null ? r.exactLastTs - r.exactFirstTs : null,
    breakdown: Object.fromEntries(DIMENSIONS.map((d) => [d, listOf(dim(r.breakdown, d))])),
  })).sort((a, b) => b.metrics.tokens.total - a.metrics.tokens.total || a.id.localeCompare(b.id));

  const from = totals.firstTs, to = totals.lastTs;
  return {
    generatedAt: new Date().toISOString(),
    schema: 1,
    project: config?.project?.name || basename(resolve(boardDir, "..")),
    boardDir,
    roots,
    dateRange: { from: from ? new Date(from).toISOString() : null, to: to ? new Date(to).toISOString() : null },
    enabled: { transcripts: scanning, telemetry: true },
    coverage: {
      ...coverage,
      ticketsOnBoard: index.size,
      ticketsWithUsage: ticketRows.length,
      exactRuns: runs.length,
      telemetrySkippedLines: telemetrySkipped,
      transcriptFiles: scanStats.files,
      transcriptSessions: scanStats.sessions,
      unassignedTokens: unassigned.tokens.total,
      unassignedTurns: unassigned.turns,
    },
    totals,
    unassigned,
    tickets: ticketRows,
    breakdown: Object.fromEntries(DIMENSIONS.map((d) => [d, listOf(dim(global, d))])),
  };
}

/** RFC4180-ish escaping: quote anything containing a comma, quote or newline. */
const csvCell = (/** @type {unknown} */ v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {string[]} header @param {unknown[][]} rows */
const csv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/**
 * Flatten a report to CSV. `view` picks which table — the same numbers the UI shows, so an
 * export and a screenshot can never disagree.
 * @param {ReturnType<typeof buildUsageReport>} report
 * @param {{ view?: "tickets" | "model" | "agent" | "runtime" | "stage" | "date" }} [opts]
 */
export function usageToCsv(report, opts = {}) {
  const view = opts.view || "tickets";
  if (view === "tickets") {
    return csv(
      ["ticket", "name", "status", "area", "epic", "board_model", "timing", "confidence",
       "input", "output", "cache_read", "cache_write", "thinking", "total_tokens",
       "turns", "runs", "estimated_active_minutes", "exact_run_minutes", "exact_cycle_hours", "span_hours",
       "models", "agents", "first", "last"],
      report.tickets.map((t) => [
        t.id, t.name, t.status, t.area, t.epicName || t.epicId, t.boardModel, t.timing, t.confidence,
        t.metrics.tokens.input, t.metrics.tokens.output, t.metrics.tokens.cacheRead,
        t.metrics.tokens.cacheWrite, t.metrics.tokens.thinking, t.metrics.tokens.total,
        t.metrics.turns, t.metrics.runs,
        (t.metrics.estimatedActiveMs / 60000).toFixed(1),
        (t.metrics.exactMs / 60000).toFixed(1),
        t.cycleMs === null ? "" : (t.cycleMs / 3600000).toFixed(2),
        (t.metrics.spanMs / 3600000).toFixed(1),
        t.breakdown.model.map((/** @type {any} */ m) => m.key).join(" | "),
        t.breakdown.agent.map((/** @type {any} */ m) => m.key).join(" | "),
        t.metrics.firstTs ? new Date(t.metrics.firstTs).toISOString() : "",
        t.metrics.lastTs ? new Date(t.metrics.lastTs).toISOString() : "",
      ]),
    );
  }
  const rows = /** @type {any[]} */ (report.breakdown[view] || []);
  return csv(
    [view, "input", "output", "cache_read", "cache_write", "thinking", "total_tokens",
     "turns", "runs", "estimated_active_minutes", "exact_minutes"],
    rows.map((r) => [
      r.key, r.tokens.input, r.tokens.output, r.tokens.cacheRead, r.tokens.cacheWrite,
      r.tokens.thinking, r.tokens.total, r.turns, r.runs,
      (r.estimatedActiveMs / 60000).toFixed(1), (r.exactMs / 60000).toFixed(1),
    ]),
  );
}
