// @ts-check
/** Provider-neutral, privacy-safe application token ledger. */
import { appendFileSync, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { resolveBoardPaths } from "./board-context.mjs";
import { withBoardLock } from "./board-io.mjs";
import { BoardLockError } from "./board-errors.mjs";

class ApplicationUsageError extends Error {
  /** @param {string} name @param {string} code @param {string} message @param {Record<string, any>} [detail] */
  constructor(name, code, message, detail = {}) { super(message); this.name = name; this.code = code; Object.assign(this, detail); }
}
export class ApplicationUsageInputError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageInputError", "EAPPLICATIONUSAGEINPUT", message, detail); }
}
export class ApplicationUsageBoardError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageBoardError", "EAPPLICATIONUSAGEBOARD", message, detail); }
}
export class ApplicationUsageConflictError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageConflictError", "EAPPLICATIONUSAGECONFLICT", message, detail); }
}
export class ApplicationUsageLockError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageLockError", "EAPPLICATIONUSAGELOCK", message, detail); }
}
export class ApplicationUsageReadError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageReadError", "EAPPLICATIONUSAGEREAD", message, detail); }
}
export class ApplicationUsageWriteError extends ApplicationUsageError {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super("ApplicationUsageWriteError", "EAPPLICATIONUSAGEWRITE", message, detail); }
}

const EVENT_FIELDS = new Set(["project", "ticketId", "provider", "model", "timestamp", "operation", "usage", "idempotencyKey"]);
const USAGE_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite", "thinking"]);
const STORED_FIELDS = new Set(["v", "eventId", "idempotencyHash", "project", "ticketId", "provider", "model", "timestamp", "operation", "usage"]);
/** @param {any} v */
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** @param {Record<string, any>} v @param {Set<string>} allowed */
const unknown = (v, allowed) => Object.keys(v).filter((k) => !allowed.has(k));
/** @param {string} v */
const digest = (v) => createHash("sha256").update(v).digest("hex");
/** @param {any} v */
const canonical = (v) => JSON.stringify(v);
/** @param {any} value @param {string} name @param {number} [max] */
const safeText = (value, name, max = 160) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApplicationUsageInputError(`${name} must be a non-empty safe string of at most ${max} characters.`, { field: name });
  }
  return value;
};
/** @param {any} value @param {string} name @param {number} [max] */
const safeIdentifier = (value, name, max = 160) => {
  const text = safeText(value, name, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) throw new ApplicationUsageInputError(`${name} must be a safe identifier.`, { field: name });
  return text;
};
/** @param {string} path @param {string} source */
const parseJson = (path, source) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new ApplicationUsageBoardError(`Cannot read valid ${source} JSON.`, { source, cause: error instanceof Error ? error.name : "Error" }); }
};

/** @param {any} usage */
function validateUsage(usage) {
  if (!object(usage)) throw new ApplicationUsageInputError("event.usage must be an object.", { field: "usage" });
  const extra = unknown(usage, USAGE_FIELDS);
  if (extra.length) throw new ApplicationUsageInputError(`Unknown event.usage field: ${extra.join(", ")}.`, { fields: extra });
  /** @type {Record<string, number>} */
  const out = {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new ApplicationUsageInputError(`event.usage.${field} must be a non-negative safe integer.`, { field: `usage.${field}` });
    out[field] = value;
  }
  if ((out.thinking || 0) > (out.output || 0)) throw new ApplicationUsageInputError("event.usage.thinking cannot exceed output.", { field: "usage.thinking" });
  return out;
}

/** @param {any} event */
function normaliseEvent(event) {
  if (!object(event)) throw new ApplicationUsageInputError("event must be an object.");
  const extra = unknown(event, EVENT_FIELDS);
  if (extra.length) throw new ApplicationUsageInputError(`Unknown event field: ${extra.join(", ")}.`, { fields: extra });
  const timestamp = safeText(event.timestamp, "timestamp", 40);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new ApplicationUsageInputError("event.timestamp must be a canonical ISO-8601 timestamp.", { field: "timestamp" });
  }
  const ticketId = event.ticketId == null ? null : safeText(event.ticketId, "ticketId", 80);
  return {
    project: safeText(event.project, "project"), ticketId,
    provider: safeIdentifier(event.provider, "provider", 80), model: safeIdentifier(event.model, "model"),
    timestamp, operation: safeIdentifier(event.operation, "operation"), usage: validateUsage(event.usage),
    idempotencyKey: safeText(event.idempotencyKey, "idempotencyKey", 512),
  };
}

/** @param {any} value */
function validateStored(value) {
  if (!object(value) || unknown(value, STORED_FIELDS).length || value.v !== 1) return false;
  if (typeof value.eventId !== "string" || typeof value.idempotencyHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.idempotencyHash) || value.eventId !== `app_${value.idempotencyHash.slice(7)}`) return false;
  try {
    normaliseEvent({ project: value.project, ticketId: value.ticketId, provider: value.provider,
      model: value.model, timestamp: value.timestamp, operation: value.operation,
      usage: value.usage, idempotencyKey: "stored" });
    return true;
  } catch { return false; }
}

/** Tolerant report reader: malformed/torn lines are counted and skipped. */
/** @param {string} boardDir */
export function readApplicationUsage(boardDir) {
  const path = join(resolve(boardDir), "application-usage.jsonl");
  if (!existsSync(path)) return { events: [], skipped: 0 };
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { throw new ApplicationUsageReadError("Application usage ledger could not be read.", { cause: error instanceof Error ? error.name : "Error" }); }
  const events = []; let skipped = 0;
  const seen = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!validateStored(value)) { skipped++; continue; }
      const prior = seen.get(value.idempotencyHash);
      if (prior !== undefined) { skipped++; continue; }
      seen.set(value.idempotencyHash, canonical(value));
      events.push(value);
    }
    catch { skipped++; }
  }
  return { events, skipped };
}

/** @param {string} path */
function readStrict(path) {
  const { events, skipped } = readApplicationUsage(dirname(path));
  if (skipped) throw new ApplicationUsageReadError("Application usage ledger contains malformed data; refusing to append because idempotency cannot be proven.", { skipped });
  return events;
}

/**
 * Append one application usage event exactly once.
 * @param {{boardPath:string,event:any,lockOptions?:{timeoutMs?:number,staleMs?:number}}} options
 */
export function appendApplicationUsage(options) {
  if (!object(options)) throw new ApplicationUsageInputError("Options must be an object.");
  const extra = unknown(options, new Set(["boardPath", "event", "lockOptions"]));
  if (extra.length) throw new ApplicationUsageInputError(`Unknown option: ${extra.join(", ")}.`, { fields: extra });
  if (typeof options.boardPath !== "string" || !options.boardPath.trim()) throw new ApplicationUsageInputError("boardPath must be a non-empty string.", { field: "boardPath" });
  if (options.lockOptions !== undefined) {
    if (!object(options.lockOptions) || unknown(options.lockOptions, new Set(["timeoutMs", "staleMs"])).length) throw new ApplicationUsageInputError("lockOptions may contain only timeoutMs and staleMs.");
    for (const [key, value] of Object.entries(options.lockOptions)) if (!Number.isFinite(value) || value < 0) throw new ApplicationUsageInputError(`lockOptions.${key} must be a non-negative number.`);
  }
  const input = normaliseEvent(options.event);
  const paths = resolveBoardPaths(options);
  const ledgerPath = join(paths.boardDir, "application-usage.jsonl");
  try {
    return withBoardLock(paths.boardDir, () => {
      if (!existsSync(paths.dataPath)) throw new ApplicationUsageBoardError("Board data could not be read.", { source: "board" });
      const data = parseJson(paths.dataPath, "board");
      const archive = existsSync(paths.archivePath) ? parseJson(paths.archivePath, "archive") : { tickets: [] };
      if (!existsSync(paths.configPath)) throw new ApplicationUsageBoardError("Project config could not be read.", { source: "config" });
      const config = parseJson(paths.configPath, "config");
      if (typeof config?.project?.name !== "string" || !config.project.name.trim()) throw new ApplicationUsageBoardError("Project config must define project.name.", { source: "config" });
      const expectedProject = config.project.name;
      if (input.project !== expectedProject) throw new ApplicationUsageBoardError(`Event project does not match this board's project (${expectedProject}).`, { field: "project" });
      if (input.ticketId && ![...(data.tickets || []), ...(archive.tickets || [])].some((t) => t?.id === input.ticketId)) {
        throw new ApplicationUsageBoardError(`Ticket ${input.ticketId} is not defined by this board.`, { field: "ticketId" });
      }
      const keyDigest = digest(input.idempotencyKey);
      const stored = { v: 1, eventId: `app_${keyDigest}`, idempotencyHash: `sha256:${keyDigest}`, project: input.project,
        ticketId: input.ticketId, provider: input.provider, model: input.model, timestamp: input.timestamp,
        operation: input.operation, usage: input.usage };
      const payloadHash = digest(canonical(stored));
      for (const prior of readStrict(ledgerPath)) {
        if (prior.idempotencyHash !== stored.idempotencyHash) continue;
        if (digest(canonical(prior)) === payloadHash) return { event: prior, appended: false };
        throw new ApplicationUsageConflictError("The idempotency key was already used for a different application usage event.", { eventId: prior.eventId });
      }
      try { appendFileSync(ledgerPath, JSON.stringify(stored) + "\n", { encoding: "utf8", flag: "a" }); }
      catch (error) { throw new ApplicationUsageWriteError("Application usage event could not be appended.", { cause: error instanceof Error ? error.name : "Error" }); }
      return { event: stored, appended: true };
    }, { op: "append-application-usage", ...(options.lockOptions || {}) });
  } catch (error) {
    if (error instanceof BoardLockError) throw new ApplicationUsageLockError(error.message, { timeoutMs: /** @type {any} */ (error).timeoutMs });
    if (error instanceof ApplicationUsageError) throw error;
    throw new ApplicationUsageWriteError("Application usage event could not be written.", { cause: error instanceof Error ? error.name : "Error" });
  }
}

/** @param {any} value @param {string} field */
const count = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new ApplicationUsageInputError(`DeepSeek usage.${field} must be a non-negative safe integer.`, { field });
  return value;
};

/** Map only a DeepSeek response's `usage` object; never pass the response itself. */
/** @param {any} usage */
export function mapDeepSeekUsage(usage) {
  if (!object(usage)) throw new ApplicationUsageInputError("DeepSeek usage must be an object.");
  const extra = unknown(usage, new Set([
    "prompt_tokens", "completion_tokens", "total_tokens",
    "prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
    "prompt_tokens_details", "completion_tokens_details",
  ]));
  if (extra.length) throw new ApplicationUsageInputError(`Unknown DeepSeek usage field: ${extra.join(", ")}.`, { fields: extra });
  const prompt = count(usage.prompt_tokens, "prompt_tokens");
  const completion = count(usage.completion_tokens, "completion_tokens");
  const total = count(usage.total_tokens, "total_tokens");
  if (prompt + completion !== total) throw new ApplicationUsageInputError("DeepSeek total_tokens must equal prompt_tokens + completion_tokens.");
  const legacyHit = usage.prompt_cache_hit_tokens;
  const legacyMiss = usage.prompt_cache_miss_tokens;
  const detailCached = usage.prompt_tokens_details?.cached_tokens;
  if (usage.prompt_tokens_details !== undefined && (!object(usage.prompt_tokens_details) || unknown(usage.prompt_tokens_details, new Set(["cached_tokens"])).length)) {
    throw new ApplicationUsageInputError("DeepSeek prompt_tokens_details may contain only cached_tokens.");
  }
  const hit = detailCached !== undefined ? count(detailCached, "prompt_tokens_details.cached_tokens") : legacyHit !== undefined ? count(legacyHit, "prompt_cache_hit_tokens") : 0;
  if (detailCached !== undefined && legacyHit !== undefined && hit !== count(legacyHit, "prompt_cache_hit_tokens")) throw new ApplicationUsageInputError("DeepSeek cache counters disagree.");
  if (hit > prompt) throw new ApplicationUsageInputError("DeepSeek cached prompt tokens cannot exceed prompt_tokens.");
  const miss = legacyMiss !== undefined ? count(legacyMiss, "prompt_cache_miss_tokens") : count(prompt - hit, "derived prompt cache miss tokens");
  if (miss > prompt) throw new ApplicationUsageInputError("DeepSeek cache miss tokens cannot exceed prompt_tokens.");
  if (hit + miss !== prompt) throw new ApplicationUsageInputError("DeepSeek cache hit + miss must equal prompt_tokens.");
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (usage.completion_tokens_details !== undefined && (!object(usage.completion_tokens_details) || unknown(usage.completion_tokens_details, new Set(["reasoning_tokens"])).length)) {
    throw new ApplicationUsageInputError("DeepSeek completion_tokens_details may contain only reasoning_tokens.");
  }
  const thinking = count(reasoning, "completion_tokens_details.reasoning_tokens");
  if (thinking > completion) throw new ApplicationUsageInputError("DeepSeek reasoning tokens cannot exceed completion tokens.");
  return { input: miss, output: completion, cacheRead: hit, cacheWrite: 0, thinking };
}
