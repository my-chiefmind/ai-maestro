#!/usr/bin/env node
// @ts-check
/**
 * telemetry-io.mjs — the exact, measured half of ticket usage: one record per agent RUN.
 *
 * Why runs and not ticket fields. The obvious design is `started_at`/`ended_at` on the ticket,
 * and it is wrong. A ticket is worked more than once: a dev stage, a reviewer stage, a retry
 * after a failed review, a model swap partway, a resumed run days later. All of that has to
 * collapse onto one record, and the moment it does you have lost the very breakdown the
 * dashboard exists to show. So the ticket record stays exactly as `board/board.schema.json`
 * defines it, and the measurements live here, append-only, one line per run. Ticket totals are
 * DERIVED (scripts/usage-core.mjs), never stored.
 *
 * The file is `board/telemetry.jsonl`, alongside the board's other live data — and, like that
 * data, git-ignored and excluded from `npm pack`: it describes one person's local runs.
 *
 * Append-only is what makes concurrent writes safe without a lock. Two `maestro run`
 * invocations finishing at once each append one line with `O_APPEND`; a single `write()` under
 * the pipe buffer is not interleaved by the kernel, and a reader tolerates a torn tail by
 * skipping unparseable lines. Nothing is ever rewritten in place, so there is no lost update.
 *
 * ── Record schema (v1) ───────────────────────────────────────────────────────────────────
 * Required:  v, runId, ticketId, startedAt
 * Optional:  endedAt, durationMs, stage, role, runtime, model, modelId, agent, sessionId,
 *            usage, usageSource, outcome, note
 *
 * `usage` is `{ input, output, cacheRead, cacheWrite, thinking }` — the same shape the
 * transcript scanner produces, so both halves aggregate through one code path. It is null
 * when the runtime did not report counts; `usageSource` says which case you are looking at
 * ("provider" | "none"), because a missing number and a zero are very different claims.
 *
 * EXTENSIBILITY IS A CONTRACT HERE. Readers must ignore fields they do not know, and writers
 * must never repurpose one. That is what lets cost be added later — a `cost` object on new
 * records — without rewriting or invalidating a single existing line, and without this kit
 * shipping or maintaining a price table it would have to keep correct forever.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export const TELEMETRY_SCHEMA = 1;
export const TELEMETRY_FILENAME = "telemetry.jsonl";

/** Fields this version defines. Anything else on a record is passed through untouched. */
export const KNOWN_FIELDS = new Set([
  "v", "runId", "ticketId", "startedAt", "endedAt", "durationMs", "stage", "role",
  "runtime", "model", "modelId", "agent", "sessionId", "usage", "usageSource", "outcome", "note",
]);

/** @param {string} boardDir */
export const telemetryPath = (boardDir) => join(boardDir, TELEMETRY_FILENAME);

/** @returns {string} */
export const newRunId = () => `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, thinking: number }} Usage
 * @typedef {{
 *   v: number, runId: string, ticketId: string, startedAt: string,
 *   endedAt?: string, durationMs?: number, stage?: string, role?: string,
 *   runtime?: string, model?: string, modelId?: string, agent?: string, sessionId?: string,
 *   usage?: Usage | null, usageSource?: "provider" | "none", outcome?: string, note?: string,
 * }} RunRecord
 */

/**
 * Reject a record that would produce a misleading row rather than write it. A run with no
 * ticket or no start is not a weaker measurement — it is not a measurement.
 * @param {any} rec
 * @returns {string[]} problems; empty means valid
 */
export function validateRun(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") return ["record must be an object"];
  if (typeof rec.ticketId !== "string" || !/^T-\d+$/.test(rec.ticketId)) problems.push("ticketId must look like T-123");
  if (typeof rec.startedAt !== "string" || Number.isNaN(Date.parse(rec.startedAt))) problems.push("startedAt must be an ISO timestamp");
  if (rec.endedAt != null && Number.isNaN(Date.parse(rec.endedAt))) problems.push("endedAt must be an ISO timestamp");
  if (rec.durationMs != null && !(Number.isFinite(rec.durationMs) && rec.durationMs >= 0)) problems.push("durationMs must be a non-negative number");
  if (rec.usage != null) {
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "thinking"]) {
      if (!Number.isFinite(rec.usage[k])) problems.push(`usage.${k} must be a number`);
    }
  }
  return problems;
}

/**
 * Append one run. Returns the stored record (with `v`, `runId` and `durationMs` filled in).
 * @param {string} boardDir
 * @param {Partial<RunRecord> & { ticketId: string, startedAt: string }} rec
 * @returns {RunRecord}
 */
export function appendRun(boardDir, rec) {
  const out = /** @type {any} */ ({
    v: TELEMETRY_SCHEMA,
    runId: rec.runId || newRunId(),
    ...rec,
  });
  if (out.durationMs == null && out.startedAt && out.endedAt) {
    out.durationMs = Math.max(0, Date.parse(out.endedAt) - Date.parse(out.startedAt));
  }
  if (out.usage === undefined) { out.usage = null; out.usageSource = out.usageSource || "none"; }
  else if (out.usageSource === undefined) out.usageSource = out.usage ? "provider" : "none";

  const problems = validateRun(out);
  if (problems.length) throw new Error(`invalid telemetry record: ${problems.join("; ")}`);

  const p = telemetryPath(boardDir);
  mkdirSync(dirname(p), { recursive: true });
  // One line, one write, O_APPEND: concurrent runs interleave by line, never within one.
  appendFileSync(p, `${JSON.stringify(out)}\n`, "utf8");
  return out;
}

/**
 * Read every run record. A torn or hand-mangled line is skipped, not fatal — this file is
 * append-only telemetry, and losing one line must not cost the other several hundred.
 * @param {string} boardDir
 * @returns {{ runs: RunRecord[], skipped: number }}
 */
export function readRuns(boardDir) {
  const p = telemetryPath(boardDir);
  if (!existsSync(p)) return { runs: [], skipped: 0 };
  let text;
  try { text = readFileSync(p, "utf8"); } catch { return { runs: [], skipped: 0 }; }
  /** @type {RunRecord[]} */
  const runs = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    if (validateRun(rec).length) { skipped++; continue; }
    runs.push(rec);
  }
  runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { runs, skipped };
}

/**
 * A small helper for instrumenting a stage: stamp the start, run, stamp the end, append.
 * Records the run whether the stage succeeded or threw — a failed stage still consumed time
 * and tokens, and hiding it would flatter every ticket it touched.
 * @template T
 * @param {string} boardDir
 * @param {Partial<RunRecord> & { ticketId: string }} meta
 * @param {() => T} fn  must return `{ result, usage?, modelId?, sessionId? }`
 * @returns {T}
 */
export function recordRun(boardDir, meta, fn) {
  const startedAt = new Date().toISOString();
  let outcome = "ok";
  /** @type {any} */
  let extra = {};
  try {
    const r = /** @type {any} */ (fn());
    extra = r && typeof r === "object" ? r : {};
    return /** @type {any} */ (r);
  } catch (e) {
    outcome = "failed";
    extra = { note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
    throw e;
  } finally {
    const endedAt = new Date().toISOString();
    try {
      appendRun(boardDir, {
        ...meta, startedAt, endedAt, outcome,
        ...(extra.usage !== undefined ? { usage: extra.usage } : {}),
        ...(extra.modelId ? { modelId: extra.modelId } : {}),
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
        ...(extra.note ? { note: extra.note } : {}),
      });
    } catch { /* telemetry must never take down the run it is measuring */ }
  }
}
