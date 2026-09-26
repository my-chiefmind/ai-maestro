#!/usr/bin/env node
// @ts-check
/**
 * usage-core.mjs — the one aggregation the whole feature reports through.
 *
 * Two sources of truth feed it and they are never mixed up:
 *
 *   EXACT       run telemetry (scripts/telemetry-io.mjs) — measured start/end and, where the
 *               runtime reported them, real token counts.
 *   ESTIMATED   Claude Code and Codex transcripts, attributed to tickets by inference
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
import { createHash } from "crypto";
import { scanTranscripts, zeroUsage, addUsage, totalTokens } from "./usage-scan.mjs";
import { attribute, ticketIndex, DEFAULTS, rank } from "./usage-attribute.mjs";
import { readRuns } from "./telemetry-io.mjs";
import { readApplicationUsage } from "./application-usage.mjs";

export { totalTokens };

/** Dimensions the report breaks every total down by. Order is the UI's tab order. */
export const DIMENSIONS = ["model", "agent", "runtime", "provider", "stage", "date"];
export const APPLICATION_DIMENSIONS = ["project", ...DIMENSIONS, "provenance"];

/** Public contract for the joint, daily usage rows consumed by companion applications. */
export const USAGE_SLICE_SCHEMA = 1;
export const USAGE_SLICE_DIMENSIONS = Object.freeze([
  "projectKey", "ticketId", "scope", "provider", "model", "runtime", "provenance", "date",
]);

/**
 * Stable, path-free identity for a project. The path is input only; it never appears in output.
 * @param {string} path
 */
export function opaqueProjectKey(path) {
  return `project_${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 12)}`;
}

/** @param {string} boardDir */
function projectPathForBoard(boardDir) {
  const kitDir = resolve(boardDir, "..");
  return basename(kitDir) === "maestro" ? dirname(kitDir) : kitDir;
}

/** @typedef {import("./usage-scan.mjs").Usage} Usage */

/**
 * @typedef {{
 *   tokens: Usage & { total: number },
 *   turns: number, runs: number, applicationCalls?: number, usageRuns: number, unavailableUsageRuns: number,
 *   estimatedActiveMs: number, exactMs: number, spanMs: number,
 *   firstTs: number | null, lastTs: number | null,
 * }} Metrics
 */

/** @returns {Metrics} */
function zeroMetrics() {
  return {
    tokens: { ...zeroUsage(), total: 0 },
    turns: 0, runs: 0, usageRuns: 0, unavailableUsageRuns: 0,
    estimatedActiveMs: 0, exactMs: 0, spanMs: 0,
    firstTs: null, lastTs: null,
  };
}

/** Complete, fixed-order metrics contract for public usage-slice rows. */
function zeroSliceMetrics() {
  const metrics = zeroMetrics();
  return {
    tokens: metrics.tokens,
    turns: 0, runs: 0, applicationCalls: 0, usageRuns: 0, unavailableUsageRuns: 0,
    estimatedActiveMs: 0, exactMs: 0, spanMs: 0, firstTs: null, lastTs: null,
  };
}

/**
 * @param {Metrics} m
 * @param {{ usage: Usage | null, ts: number, endTs?: number, exact: boolean, application?: boolean, durationMs: number }} s
 */
function accumulate(m, s) {
  if (s.usage) {
    addUsage(m.tokens, s.usage);
    m.tokens.total = totalTokens(m.tokens);
  }
  if (s.application) {
    m.applicationCalls = (m.applicationCalls || 0) + 1;
    if (s.usage) m.usageRuns++;
    return; // token-only ledger: timestamps classify by date but never manufacture elapsed time
  }
  else if (s.exact) {
    m.runs++; m.exactMs += s.durationMs;
    if (s.usage) m.usageRuns++; else m.unavailableUsageRuns++;
  }
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
 *   ticketId: string | null, project: string, projectKey: string, model: string, agent: string, runtime: string, provider: string, provenance: string, stage: string,
 *   date: string, usage: Usage | null, ts: number, endTs?: number, durationMs: number,
 *   exact: boolean, application?: boolean, confidence: string, evidence: string | null, sessionId: string,
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
 *   roots?: string[], excludeRoots?: string[], projectsDir?: string, codexHome?: string, cacheFile?: string,
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
  const project = config?.project?.name || basename(resolve(boardDir, ".."));
  const projectKey = opaqueProjectKey(projectPathForBoard(boardDir));
  const roots = opts.roots || rootsForBoard(boardDir);
  // Other projects' roots, so a repo nested inside this one keeps its own tokens. See
  // ownsCwd() in usage-scan.mjs — without this a portfolio rollup double-counts.
  const excludeRoots = opts.excludeRoots || [];

  // ── Exact half ────────────────────────────────────────────────────────────────────────
  const { runs, skipped: telemetrySkipped } = readRuns(boardDir);
  /** @type {Sample[]} */
  const samples = [];
  const exactSessions = new Set();
  for (const r of runs) {
    if (r.sessionId) exactSessions.add(`${r.runtime || "unknown"}:${r.sessionId}`);
    const ts = Date.parse(r.startedAt);
    const endTs = r.endedAt ? Date.parse(r.endedAt) : ts;
    samples.push({
      ticketId: index.has(r.ticketId) ? r.ticketId : r.ticketId, // a run names its ticket; trust it
      project, projectKey,
      model: r.modelId || r.model || "unknown",
      agent: r.agent || r.role || r.stage || "run",
      runtime: r.runtime || "unknown",
      provider: r.provider || "unknown",
      provenance: "orchestration",
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
      excludeRoots,
      projectsDir: opts.projectsDir,
      codexHome: opts.codexHome,
      cacheFile: opts.cacheFile,
      useCache: opts.useCache,
    });
    scanStats = { sessions: scan.sessions, files: scan.files };
    const attributed = attribute(scan.events, index, { ...opts.tuning, exactSessions });
    coverage = attributed.coverage;
    for (const t of attributed.turns) {
      samples.push({
        ticketId: t.ticketId,
        project, projectKey,
        model: t.model,
        agent: t.agentType,
        runtime: t.runtime || "claude",
        provider: t.provider || "unknown",
        provenance: "orchestration",
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

  // ── Application half ─────────────────────────────────────────────────────────────────
  // These are exact provider counters for product/API calls, but they are not agent runs or
  // transcript turns and carry no duration. Keeping that distinction prevents token ingestion
  // from manufacturing working time.
  const application = readApplicationUsage(boardDir);
  const dimensions = application.events.length ? APPLICATION_DIMENSIONS : DIMENSIONS;
  for (const event of application.events) {
    const ts = Date.parse(event.timestamp);
    samples.push({
      ticketId: event.ticketId, project: event.project, projectKey, model: event.model,
      agent: "application", runtime: "application", provider: event.provider,
      provenance: "application", stage: event.operation, date: dayOf(ts),
      usage: event.usage, ts, durationMs: 0, exact: false, application: true,
      confidence: "application", evidence: `application:${event.eventId}`, sessionId: "",
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────────────────
  /** @type {Map<string, any>} */
  const tickets = new Map();
  const totals = zeroMetrics();
  const unassigned = zeroMetrics();
  const projectOnly = zeroMetrics();
  /** @type {Map<string, any>} */
  const usageSlices = new Map();
  /** @type {Map<string, Map<string, Metrics>>} */
  const global = new Map(dimensions.map((d) => [d, /** @type {Map<string, Metrics>} */ (new Map())]));
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
    for (const d of dimensions) into(dim(global, d), /** @type {any} */ (s)[d], s);

    // This row is built in the canonical sample pass. Reconstructing it from independent
    // one-dimensional breakdowns would invent false provider/model/runtime intersections.
    const sliceDimensions = {
      projectKey: s.projectKey,
      ticketId: s.ticketId,
      scope: s.ticketId ? "ticket" : s.application ? "project-only" : "unassigned",
      provider: s.provider || "unknown",
      model: s.model || "unknown",
      runtime: s.runtime || "unknown",
      provenance: s.provenance || "unknown",
      date: s.date || "unknown",
    };
    const sliceKey = JSON.stringify(USAGE_SLICE_DIMENSIONS.map((d) => /** @type {any} */ (sliceDimensions)[d]));
    let slice = usageSlices.get(sliceKey);
    if (!slice) {
      slice = { ...sliceDimensions, project: s.project, metrics: zeroSliceMetrics() };
      usageSlices.set(sliceKey, slice);
    }
    accumulate(slice.metrics, s);

    if (!s.ticketId) {
      accumulate(s.application ? projectOnly : unassigned, s);
      continue;
    }
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
        breakdown: new Map(dimensions.map((d) => [d, /** @type {Map<string, Metrics>} */ (new Map())])),
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
    for (const d of dimensions) into(dim(row.breakdown, d), /** @type {any} */ (s)[d], s);
    if (s.evidence) row.evidence.add(s.evidence);
    if (s.application) row.confidence = row.confidence === "unassigned" ? "application" : row.confidence;
    else if (rank(s.confidence) < rank(row.confidence === "application" ? "unassigned" : row.confidence)) row.confidence = s.confidence;
    if (s.application) row.hasApplication = true; else if (s.exact) row.hasExact = true; else row.hasEstimated = true;
  }

  /** @param {Map<string, Metrics>} m */
  const listOf = (m) => [...m.entries()]
    .map(([key, metrics]) => ({ key, ...metrics }))
    .sort((a, b) => b.tokens.total - a.tokens.total || a.key.localeCompare(b.key));

  const ticketRows = [...tickets.values()].map((r) => ({
    ...r,
    evidence: [...r.evidence].sort(),
    timing: r.hasApplication && (r.hasExact || r.hasEstimated) ? "mixed" : r.hasApplication ? "application" : r.hasExact && r.hasEstimated ? "mixed" : r.hasExact ? "exact" : "estimated",
    cycleMs: r.exactFirstTs !== null && r.exactLastTs !== null ? r.exactLastTs - r.exactFirstTs : null,
    breakdown: Object.fromEntries(dimensions.map((d) => [d, listOf(dim(r.breakdown, d))])),
  })).sort((a, b) => b.metrics.tokens.total - a.metrics.tokens.total || a.id.localeCompare(b.id));

  const from = totals.firstTs, to = totals.lastTs;
  const sliceSort = ["projectKey", "scope", "ticketId", "date", "provider", "model", "runtime", "provenance"];
  const sliceRows = [...usageSlices.values()].sort((a, b) => {
    for (const dimension of sliceSort) {
      const compared = String(a[dimension] ?? "").localeCompare(String(b[dimension] ?? ""));
      if (compared) return compared;
    }
    return 0;
  });
  return {
    generatedAt: new Date().toISOString(),
    schema: 1,
    project,
    dateRange: { from: from ? new Date(from).toISOString() : null, to: to ? new Date(to).toISOString() : null },
    enabled: { transcripts: scanning, telemetry: true },
    coverage: {
      ...coverage,
      ticketsOnBoard: index.size,
      ticketsWithUsage: ticketRows.length,
      exactRuns: runs.length,
      telemetrySkippedLines: telemetrySkipped,
      ...(application.events.length || application.skipped ? { applicationCalls: application.events.length, applicationSkippedLines: application.skipped } : {}),
      transcriptFiles: scanStats.files,
      transcriptSessions: scanStats.sessions,
      unassignedTokens: unassigned.tokens.total,
      unassignedTurns: unassigned.turns,
    },
    totals,
    unassigned,
    ...(application.events.length ? { projectOnly } : {}),
    tickets: ticketRows,
    usageSlices: {
      schema: USAGE_SLICE_SCHEMA,
      dimensions: [...USAGE_SLICE_DIMENSIONS],
      rows: sliceRows,
    },
    breakdown: Object.fromEntries(dimensions.map((d) => [d, listOf(dim(global, d))])),
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
 * @param {{ view?: "tickets" | "model" | "agent" | "runtime" | "provider" | "stage" | "date" | "project" }} [opts]
 */
export function usageToCsv(report, opts = {}) {
  const view = opts.view || "tickets";
  const hasApplication = report.totals.applicationCalls !== undefined;
  // A portfolio report carries a `project` on every ticket and an extra `project` breakdown;
  // the single-board shape has neither. One exporter handles both rather than a second that
  // could round or label differently.
  const isPortfolio = /** @type {any} */ (report).kind === "portfolio";
  if (view === "tickets") {
    return csv(
      [...(isPortfolio ? ["project"] : []), "ticket", "name", "status", "area", "epic", "board_model", "timing", "confidence",
       "input", "output", "cache_read", "cache_write", "thinking", "total_tokens",
       "turns", "runs", ...(hasApplication ? ["application_calls"] : []), "estimated_active_minutes", "exact_run_minutes", "exact_cycle_hours", "span_hours",
       "models", "agents", "first", "last"],
      report.tickets.map((t) => [
        ...(isPortfolio ? [/** @type {any} */ (t).project || ""] : []),
        t.id, t.name, t.status, t.area, t.epicName || t.epicId, t.boardModel, t.timing, t.confidence,
        t.metrics.tokens.input, t.metrics.tokens.output, t.metrics.tokens.cacheRead,
        t.metrics.tokens.cacheWrite, t.metrics.tokens.thinking, t.metrics.tokens.total,
        t.metrics.turns, t.metrics.runs, ...(hasApplication ? [t.metrics.applicationCalls || 0] : []),
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
     "turns", "runs", ...(hasApplication ? ["application_calls"] : []), "estimated_active_minutes", "exact_minutes"],
    rows.map((r) => [
      r.label || r.key, r.tokens.input, r.tokens.output, r.tokens.cacheRead, r.tokens.cacheWrite,
      r.tokens.thinking, r.tokens.total, r.turns, r.runs, ...(hasApplication ? [r.applicationCalls || 0] : []),
      (r.estimatedActiveMs / 60000).toFixed(1), (r.exactMs / 60000).toFixed(1),
    ]),
  );
}
