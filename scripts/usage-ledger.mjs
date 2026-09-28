// @ts-check
/**
 * Recorded agent-usage ledger: `board/usage.jsonl`.
 *
 * One line per model turn, COUNT-ONLY — no prompt, tool, path, or message text can be stored
 * because the schema is closed (unknown fields are rejected) and every string is a bounded,
 * safe identifier. The file is committed to git and appended from many branches/worktrees,
 * so it is merged with `merge=union` (see .gitattributes); a union merge can duplicate lines,
 * which is why every reader dedups by `key` and the writer never rewrites a prior record.
 *
 * Automatic recording (the hooks and `maestro usage sync`) never touches that tracked file:
 * new records go to an UNTRACKED spool, `board/.usage-pending.jsonl`, so a session running in
 * the main checkout never leaves it dirty (a dirty tracked file blocks `git pull --ff-only` and
 * `release:prepare`). Readers see ledger + spool, deduped by key, so numbers appear at once.
 * `maestro usage commit` (commitUsage) folds the spool into usage.jsonl — deduped, under the
 * lock, atomically — and empties it; the result reaches git through a normal commit/PR.
 *
 * Writes take the board directory lock, merge new records by key, keep each file sorted by
 * (ts, key), and replace it atomically. The import cursor (`board/.usage-cursor.json`, also
 * untracked) is written under the same lock, also atomically. Older kits kept the cursor in the
 * tracked `board/usage-cursor.json`; it is still read as a fallback but never written again.
 */
import { existsSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { withBoardLock, writeAtomic } from "./board-io.mjs";

export const USAGE_LEDGER_FILE = "usage.jsonl";
/** Untracked spool the hooks and `usage sync` append to; folded in by `maestro usage commit`. */
export const USAGE_PENDING_FILE = ".usage-pending.jsonl";
/** Untracked import cursor. */
export const USAGE_CURSOR_FILE = ".usage-cursor.json";
/** Tracked cursor written by older kits: read as a fallback, never written. */
export const USAGE_LEGACY_CURSOR_FILE = "usage-cursor.json";
export const USAGE_RECORD_VERSION = 1;

const RECORD_FIELDS = ["v", "key", "runtime", "provider", "model", "ts", "sessionId", "agentType",
  "branch", "ticketId", "confidence", "evidenceKind", "usage"];
const RECORD_FIELD_SET = new Set(RECORD_FIELDS);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];
const USAGE_FIELD_SET = new Set(USAGE_FIELDS);

export class UsageLedgerInputError extends Error {
  /** @param {string} message @param {Record<string, any>} [detail] */
  constructor(message, detail = {}) { super(message); this.name = "UsageLedgerInputError"; this.code = "EUSAGELEDGERINPUT"; Object.assign(this, detail); }
}

/** @param {any} v */
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._@+/-]*$/;
/** @param {any} value @param {string} field @param {number} [max] */
function ident(value, field, max = 128) {
  if (typeof value !== "string" || !value || value.length > max || !IDENT.test(value)) {
    throw new UsageLedgerInputError(`${field} must be a safe identifier of at most ${max} characters.`, { field });
  }
  return value;
}

/**
 * Validate one record against the strict count-only schema. Returns a canonical copy with
 * fields in a fixed order (so identical records serialise identically).
 * @param {any} record
 */
export function validateUsageRecord(record) {
  if (!object(record)) throw new UsageLedgerInputError("Usage record must be an object.");
  const extra = Object.keys(record).filter((k) => !RECORD_FIELD_SET.has(k));
  if (extra.length) throw new UsageLedgerInputError(`Unknown usage record field: ${extra.join(", ")}.`, { fields: extra });
  if (record.v !== USAGE_RECORD_VERSION) throw new UsageLedgerInputError(`v must be ${USAGE_RECORD_VERSION}.`, { field: "v" });
  const runtime = ident(record.runtime, "runtime", 32);
  const sessionId = ident(record.sessionId, "sessionId");
  const prefix = `${runtime}:${sessionId}:`;
  if (typeof record.key !== "string" || !record.key.startsWith(prefix)) throw new UsageLedgerInputError("key must be runtime:sessionId:turnId.", { field: "key" });
  ident(record.key.slice(prefix.length), "key turnId");
  const key = record.key;
  if (typeof record.ts !== "string" || !Number.isFinite(Date.parse(record.ts)) || new Date(Date.parse(record.ts)).toISOString() !== record.ts) {
    throw new UsageLedgerInputError("ts must be a canonical ISO-8601 timestamp.", { field: "ts" });
  }
  const ticketId = record.ticketId === null ? null : ident(record.ticketId, "ticketId", 64);
  const u = record.usage;
  if (!object(u)) throw new UsageLedgerInputError("usage must be an object.", { field: "usage" });
  const extraUsage = Object.keys(u).filter((k) => !USAGE_FIELD_SET.has(k));
  if (extraUsage.length) throw new UsageLedgerInputError(`Unknown usage field: ${extraUsage.join(", ")}.`, { fields: extraUsage });
  /** @type {Record<string, number>} */
  const usage = {};
  for (const f of USAGE_FIELDS) {
    if (!Number.isSafeInteger(u[f]) || u[f] < 0) throw new UsageLedgerInputError(`usage.${f} must be a non-negative safe integer.`, { field: `usage.${f}` });
    usage[f] = u[f];
  }
  if (usage.reasoning > usage.output) throw new UsageLedgerInputError("usage.reasoning cannot exceed output.", { field: "usage.reasoning" });
  if (usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) {
    throw new UsageLedgerInputError("usage.total must equal input + output + cacheRead + cacheWrite.", { field: "usage.total" });
  }
  return {
    v: USAGE_RECORD_VERSION, key, runtime,
    provider: ident(record.provider, "provider", 64),
    model: ident(record.model, "model"),
    ts: record.ts, sessionId,
    agentType: ident(record.agentType, "agentType", 64),
    branch: ident(record.branch, "branch", 200),
    ticketId,
    confidence: ident(record.confidence, "confidence", 32),
    evidenceKind: ident(record.evidenceKind, "evidenceKind", 32),
    usage,
  };
}

/** @param {{ts:string,key:string}} a @param {{ts:string,key:string}} b */
const byTsKey = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Parse one JSONL file into `into` (dedup by key across calls, first occurrence wins).
 * @param {string} path @param {Set<string>} seen @param {any[]} into
 */
function readInto(path, seen, into) {
  let skipped = 0, duplicates = 0;
  if (!existsSync(path)) return { skipped, duplicates };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = validateUsageRecord(JSON.parse(line)); } catch { skipped++; continue; }
    if (seen.has(rec.key)) { duplicates++; continue; }
    seen.add(rec.key);
    into.push(rec);
  }
  return { skipped, duplicates };
}

/**
 * Tolerant reader. Malformed/invalid lines are counted and skipped; duplicate keys (e.g. from
 * a git union merge, or a record both committed and still pending) are kept once — first
 * occurrence wins, the committed ledger first — so nothing is double counted.
 * `pending: false` reads only the committed ledger.
 * @param {string} boardDir
 * @param {{ pending?: boolean }} [opts]
 * @returns {{ records: ReturnType<typeof validateUsageRecord>[], skipped: number, duplicates: number, pending: number }}
 */
export function readUsage(boardDir, opts = {}) {
  const dir = resolve(boardDir);
  const seen = new Set();
  /** @type {any[]} */ const records = [];
  const a = readInto(join(dir, USAGE_LEDGER_FILE), seen, records);
  const committed = records.length;
  const b = opts.pending === false ? { skipped: 0, duplicates: 0 } : readInto(join(dir, USAGE_PENDING_FILE), seen, records);
  const pending = records.length - committed;
  records.sort(byTsKey);
  return { records, skipped: a.skipped + b.skipped, duplicates: a.duplicates + b.duplicates, pending };
}

/** @param {string} boardDir */
export function readUsageCursor(boardDir) {
  const dir = resolve(boardDir);
  const path = [USAGE_CURSOR_FILE, USAGE_LEGACY_CURSOR_FILE].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!path) return { v: 1, sources: {} };
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    return validateCursor(c);
  } catch { return { v: 1, sources: {} }; }
}

/** @param {any} c */
function validateCursor(c) {
  if (!object(c) || c.v !== 1 || !object(c.sources)) throw new UsageLedgerInputError("Cursor must be {v:1, sources:{}}.");
  /** @type {Record<string, {offset:number}>} */
  const sources = {};
  for (const [id, s] of Object.entries(c.sources)) {
    if (typeof id !== "string" || !id || id.length > 512) throw new UsageLedgerInputError("Cursor source id is invalid.");
    if (!object(s) || Object.keys(s).some((k) => k !== "offset") || !Number.isSafeInteger(s.offset) || s.offset < 0) {
      throw new UsageLedgerInputError("Cursor source must be {offset: non-negative integer}.", { source: id });
    }
    sources[id] = { offset: s.offset };
  }
  return { v: 1, sources };
}

/**
 * Append records (and optionally advance import cursors) under the board lock.
 * Records land in the untracked spool (USAGE_PENDING_FILE), never in the tracked ledger.
 * Records already present by key (committed or pending) are skipped — never rewritten.
 * Returns what was written.
 * @param {string} boardDir
 * @param {any[]} records
 * @param {{ cursor?: Record<string, {offset:number}>, lockOptions?: {timeoutMs?: number, staleMs?: number} }} [opts]
 */
export function appendUsage(boardDir, records, opts = {}) {
  if (typeof boardDir !== "string" || !boardDir) throw new UsageLedgerInputError("boardDir must be a non-empty string.");
  if (!Array.isArray(records)) throw new UsageLedgerInputError("records must be an array.");
  if (!object(opts) || Object.keys(opts).some((k) => k !== "cursor" && k !== "lockOptions")) throw new UsageLedgerInputError("Unknown appendUsage option.");
  const valid = records.map(validateUsageRecord);
  const cursorPatch = opts.cursor === undefined ? null : validateCursor({ v: 1, sources: opts.cursor }).sources;
  const dir = resolve(boardDir);
  return withBoardLock(dir, () => {
    const keys = new Set(readUsage(dir).records.map((r) => r.key));
    const added = [];
    for (const r of valid) {
      if (keys.has(r.key)) continue;
      keys.add(r.key);
      added.push(r);
    }
    if (added.length) {
      /** @type {any[]} */ const spool = [];
      readInto(join(dir, USAGE_PENDING_FILE), new Set(), spool);
      const all = [...spool, ...added].sort(byTsKey);
      writeAtomic(join(dir, USAGE_PENDING_FILE), all.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    if (cursorPatch && Object.keys(cursorPatch).length) {
      const cur = readUsageCursor(dir);
      const next = { v: 1, sources: { ...cur.sources, ...cursorPatch } };
      const sorted = { v: 1, sources: Object.fromEntries(Object.entries(next.sources).sort(([a], [b]) => (a < b ? -1 : 1))) };
      writeAtomic(join(dir, USAGE_CURSOR_FILE), JSON.stringify(sorted, null, 2) + "\n");
    }
    return { appended: added.length, skipped: valid.length - added.length };
  }, { op: "append-usage", ...(opts.lockOptions || {}) });
}

/**
 * Create an empty import cursor if none exists (under the board lock). The cursor's presence
 * is what marks the one-time transcript backfill as done, even when there was nothing to import.
 * @param {string} boardDir
 * @param {{ lockOptions?: {timeoutMs?: number, staleMs?: number} }} [opts]
 * @returns {boolean} whether a cursor was created
 */
export function ensureUsageCursor(boardDir, opts = {}) {
  const dir = resolve(boardDir);
  return withBoardLock(dir, () => {
    if (existsSync(join(dir, USAGE_CURSOR_FILE)) || existsSync(join(dir, USAGE_LEGACY_CURSOR_FILE))) return false;
    writeAtomic(join(dir, USAGE_CURSOR_FILE), JSON.stringify({ v: 1, sources: {} }, null, 2) + "\n");
    return true;
  }, { op: "usage-cursor", ...(opts.lockOptions || {}) });
}

/**
 * Fold the pending spool into the tracked ledger under the board lock: merge by key (a record
 * already committed is not duplicated), keep the ledger sorted by (ts, key), replace it
 * atomically, then remove the spool. Uncommitted edits already in usage.jsonl (a dirty file
 * left by an older kit) are kept. Idempotent: with nothing pending it writes nothing.
 * @param {string} boardDir
 * @param {{ lockOptions?: {timeoutMs?: number, staleMs?: number} }} [opts]
 * @returns {{ committed: number, alreadyCommitted: number }}
 */
export function commitUsage(boardDir, opts = {}) {
  if (typeof boardDir !== "string" || !boardDir) throw new UsageLedgerInputError("boardDir must be a non-empty string.");
  if (!object(opts) || Object.keys(opts).some((k) => k !== "lockOptions")) throw new UsageLedgerInputError("Unknown commitUsage option.");
  const dir = resolve(boardDir);
  return withBoardLock(dir, () => {
    const spoolPath = join(dir, USAGE_PENDING_FILE);
    if (!existsSync(spoolPath)) return { committed: 0, alreadyCommitted: 0 };
    /** @type {any[]} */ const spool = [];
    readInto(spoolPath, new Set(), spool);
    const { records: ledger } = readUsage(dir, { pending: false });
    const keys = new Set(ledger.map((r) => r.key));
    const added = spool.filter((r) => !keys.has(r.key));
    if (added.length) {
      const all = [...ledger, ...added].sort(byTsKey);
      writeAtomic(join(dir, USAGE_LEDGER_FILE), all.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    rmSync(spoolPath, { force: true });
    return { committed: added.length, alreadyCommitted: spool.length - added.length };
  }, { op: "commit-usage", ...(opts.lockOptions || {}) });
}

/**
 * Whether automatic usage recording is on for a project. Default ON; `usage.record: false`
 * in config.json turns it off.
 * @param {any} config
 */
export function usageRecordEnabled(config) {
  return config?.usage?.record !== false;
}
