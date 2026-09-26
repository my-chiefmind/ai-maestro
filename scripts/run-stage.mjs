#!/usr/bin/env node
// @ts-check
/**
 * run-stage.mjs — run one pipeline stage on a runtime adapter and record what it cost.
 *
 * Split out of run-ticket.mjs so the measured half of usage reporting is reachable without
 * driving a whole dev → PR → reviewer pipeline. That pipeline needs a GitHub remote and a
 * second account's token, so a runner that only exists inside it is a runner that can only be
 * proven by doing something irreversible. The stage itself — invoke the adapter, read what it
 * reports, append a telemetry line — has none of those dependencies and is where every
 * assumption about token capture actually lives.
 *
 * Nothing here writes to the board. Measurements are append-only run records
 * (scripts/telemetry-io.mjs) and ticket totals are derived from them.
 */
import { spawnSync } from "child_process";
import { appendRun, newRunId } from "./telemetry-io.mjs";
import { normaliseUsage } from "./usage-scan.mjs";
import { metadataForCodexSession, parseCodexExecJsonl } from "./usage-codex.mjs";

/** Keep diagnostics stable and free of runtime-specific objects such as raw fs errors. */
function telemetryDiagnostic(error) {
  const err = /** @type {any} */ (error);
  return {
    name: typeof err?.name === "string" ? err.name : "Error",
    code: typeof err?.code === "string" ? err.code : "ETELEMETRYUNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}

function reportTelemetryFailure(error) {
  const diagnostic = telemetryDiagnostic(error);
  console.error(`  (telemetry not recorded [${diagnostic.code}]: ${diagnostic.message})`);
  return diagnostic;
}

/**
 * Codex has no haiku/sonnet/opus alias — Maestro's tiers map to its reasoning-effort config
 * instead, and the model is left at whatever the caller's Codex config already selects.
 * See docs/MODEL-ROUTING.md.
 */
export const CODEX_EFFORT = { haiku: "low", sonnet: "medium", opus: "high" };

/** Thrown when the adapter itself failed. Carries the timing so the run is still recorded. */
export class StageError extends Error {
  /** @param {string} message @param {{ outcome: string, startedAt: string, endedAt: string, durationMs: number }} info */
  constructor(message, info) {
    super(message);
    this.name = "StageError";
    this.stageFailure = true;
    Object.assign(this, info);
  }
}

/**
 * Claude Code's `-p --output-format json` wraps the same answer in an envelope that also
 * reports `session_id`, `duration_ms` and the real `usage` counters — the only way this
 * runner can record what a stage cost instead of guessing. run-ticket's call sites discard
 * the returned text, so the format change is invisible to them; stderr stays inherited, so
 * the live progress a human watches is untouched.
 *
 * A caller who passes their own --output-format keeps it and we record no usage: their flag
 * is an explicit instruction, and instrumentation is not entitled to override it.
 * @param {string[]} extraFlags
 */
export function wantsJsonEnvelope(extraFlags) {
  return !extraFlags.some((f) => f === "--output-format" || f.startsWith("--output-format="));
}

/**
 * Parse Claude Code's JSON envelope. Best-effort by design: a CLI version that changes the
 * shape must cost us the telemetry for that run, never the run itself.
 * @param {string} stdout
 * @returns {{ usage: any, sessionId: string | null, modelUsage: Record<string, any> | null }}
 */
export function parseClaudeEnvelope(stdout) {
  const empty = { usage: null, sessionId: null, modelUsage: null };
  try {
    const j = JSON.parse(stdout);
    if (!j || typeof j !== "object") return empty;
    return {
      usage: j.usage ? normaliseUsage(j.usage) : null,
      sessionId: typeof j.session_id === "string" ? j.session_id : null,
      // Newer CLIs break usage down per model when a stage spanned more than one. Where they
      // do, that detail is strictly better than one blended row.
      modelUsage: j.modelUsage && typeof j.modelUsage === "object" ? j.modelUsage : null,
    };
  } catch { return empty; }
}

/**
 * Invoke a runtime adapter once.
 * @param {{ runtime: string, model: string, prompt: string, extraFlags?: string[], cwd: string,
 *           env?: NodeJS.ProcessEnv, timeoutMs?: number }} opts
 * @returns {{ stdout: string, startedAt: string, endedAt: string, durationMs: number,
 *             usage: any, sessionId: string | null, modelUsage: Record<string, any> | null }}
 */
export function runAgent(opts) {
  const { runtime, model, prompt, cwd } = opts;
  const extraFlags = opts.extraFlags ?? [];
  const timeoutMs = opts.timeoutMs ?? 1800_000;
  const cmd = runtime === "claude" ? "claude" : "codex";
  const codexModelArgs = /** @type {any} */ (CODEX_EFFORT)[model]
    ? ["-c", `model_reasoning_effort=${/** @type {any} */ (CODEX_EFFORT)[model]}`]
    : ["-m", model];
  const claudeJson = runtime === "claude" && wantsJsonEnvelope(extraFlags);
  let codexJson = false;
  if (runtime === "codex") {
    const requested = extraFlags.includes("--json");
    const help = spawnSync(cmd, ["exec", "--help"], {
      cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], env: opts.env || process.env,
    });
    codexJson = requested || (!help.error && help.status === 0 && /(^|\s)--json(?:\s|$)/m.test(help.stdout || ""));
  }
  const args = runtime === "claude"
    ? ["-p", prompt, "--model", model, ...(claudeJson ? ["--output-format", "json"] : []), ...extraFlags]
    : ["exec", prompt, ...codexModelArgs, ...(codexJson && !extraFlags.includes("--json") ? ["--json"] : []), ...extraFlags];

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"], env: opts.env || process.env,
  });
  const durationMs = Date.now() - started;
  const endedAt = new Date().toISOString();
  const info = { startedAt, endedAt, durationMs };

  // These THROW rather than exiting so runStage can record the failed stage first. A stage
  // that burned twenty minutes and then failed is exactly the run you most want on the
  // dashboard; exiting here would erase it.
  const rawStdout = r.stdout || "";
  const codexEnvelope = runtime === "codex" && codexJson ? parseCodexExecJsonl(rawStdout) : null;
  const codexMeta = codexEnvelope?.sessionId
    ? metadataForCodexSession(codexEnvelope.sessionId, opts.env?.CODEX_HOME)
    : { modelId: null, provider: null };
  const failureInfo = {
    ...info,
    usage: codexEnvelope?.usage || null,
    sessionId: codexEnvelope?.sessionId || null,
    modelId: codexEnvelope?.modelId || codexMeta.modelId,
    provider: codexEnvelope?.provider || codexMeta.provider,
  };
  if (r.error) throw new StageError(`Failed to run "${cmd}": ${r.error.message}`, { ...failureInfo, outcome: "spawn-failed" });
  if (r.signal === "SIGTERM") throw new StageError(`${cmd} timed out after ${timeoutMs / 1000}s (--timeout to change it).`, { ...failureInfo, outcome: "timeout" });
  if (r.status !== 0 || codexEnvelope?.error) {
    const why = codexEnvelope?.error || `${cmd} exited ${r.status}`;
    throw new StageError(`${why}.`, { ...failureInfo, outcome: "failed" });
  }

  const envelope = claudeJson ? parseClaudeEnvelope(rawStdout)
    : codexEnvelope ? {
      usage: codexEnvelope.usage, sessionId: codexEnvelope.sessionId, modelUsage: null,
      modelId: codexEnvelope.modelId || codexMeta.modelId,
      provider: codexEnvelope.provider || codexMeta.provider,
    }
      : { usage: null, sessionId: null, modelUsage: null, modelId: null, provider: null };
  return { stdout: codexEnvelope ? codexEnvelope.stdout : rawStdout, ...info, ...envelope };
}

/**
 * Run one stage and record it: one telemetry line per model the stage used.
 *
 * Telemetry never fails a run. A stage that worked but could not be recorded is a lost
 * measurement; a stage failed by its own bookkeeping is a lost day.
 *
 * @param {{ boardDir: string, ticketId: string, stage: string, runtime: string, model: string,
 *           prompt: string, extraFlags?: string[], cwd: string, env?: NodeJS.ProcessEnv,
 *           timeoutMs?: number, agent?: string }} opts
 */
export function runStage(opts) {
  const runId = newRunId();
  const { boardDir, ticketId, stage, runtime, model } = opts;
  let out;
  try {
    out = runAgent(opts);
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (!err?.stageFailure) throw e;
    const now = new Date().toISOString();
    let telemetry;
    try {
      const record = appendRun(boardDir, {
        runId, ticketId, stage, role: stage, runtime, model,
        ...(opts.agent ? { agent: opts.agent } : {}),
        startedAt: err.startedAt || now, endedAt: err.endedAt || now,
        durationMs: err.durationMs ?? 0, outcome: err.outcome || "failed",
        usage: err.usage || null, usageSource: err.usage ? "provider" : "none",
        ...(err.sessionId ? { sessionId: err.sessionId } : {}),
        ...(err.modelId ? { modelId: err.modelId } : {}),
        ...(err.provider ? { provider: err.provider } : {}),
        note: `${runtime} ${err.outcome || "failed"}`,
      });
      telemetry = { ok: true, records: [record], error: null };
    } catch (appendError) {
      const diagnostic = reportTelemetryFailure(appendError);
      telemetry = { ok: false, records: [], error: diagnostic };
      // Preserve the adapter failure as the thrown error while making the secondary loss
      // machine-readable to the pipeline and to tests.
      err.telemetryFailure = diagnostic;
    }
    err.telemetry = telemetry;
    throw e;
  }

  const base = {
    runId, ticketId, stage, role: stage, runtime, model,
    ...(opts.agent ? { agent: opts.agent } : {}),
    startedAt: out.startedAt, endedAt: out.endedAt, durationMs: out.durationMs,
    ...(out.sessionId ? { sessionId: out.sessionId } : {}),
    ...(out.provider ? { provider: out.provider } : {}),
    outcome: "ok",
  };
  /** @type {any[]} */
  const written = [];
  let telemetryError = null;
  try {
    const models = out.modelUsage ? Object.keys(out.modelUsage) : [];
    if (models.length > 1) {
      // Several models in one stage: only `modelUsage` can say which spent what, so it wins.
      // It reports no reasoning count, so `thinking` is 0 on these rows — reasoning is not
      // broken down per model by the runtime, and inventing a split would be a fabrication.
      for (const modelId of models) {
        written.push(appendRun(boardDir, {
          ...base, runId: `${runId}:${modelId}`, modelId,
          usage: normaliseUsage(out.modelUsage?.[modelId]), usageSource: "provider",
        }));
      }
    } else {
      // One model, the overwhelmingly common case: prefer the top-level block, which is the
      // same numbers PLUS the reasoning count that modelUsage omits.
      written.push(appendRun(boardDir, {
        ...base,
        ...(models.length === 1 ? { modelId: models[0] } : out.modelId ? { modelId: out.modelId } : {}),
        usage: out.usage ?? (models.length === 1 ? normaliseUsage(out.modelUsage?.[models[0]]) : null),
        usageSource: out.usage || models.length === 1 ? "provider" : "none",
      }));
    }
  } catch (e) {
    telemetryError = reportTelemetryFailure(e);
  }
  return {
    ...out, runId, records: written,
    telemetry: { ok: telemetryError === null, records: written, error: telemetryError },
  };
}
