/**
 * board-io.mjs — the one true way to WRITE a board file.
 *
 * board-core.mjs owns what a valid board IS; this module owns how one is safely replaced.
 * Every writer — the CLI (`maestro board …`), the cockpit server, the orchestrate engine
 * via the CLI — goes through here, so there is one concurrency rule for the board rather
 * than one per caller.
 *
 * THE FAILURE THIS EXISTS TO PREVENT (T-010): a board mutation is read-whole-file, change
 * one thing, write-whole-file. Two writers interleaved — A reads, B reads, A writes, B
 * writes from its stale copy — silently drop A's change. The result is well-formed JSON
 * that passes validation, so nothing downstream can detect it. That happened on this
 * repo's own board on 2026-08-08 and cost a filed ticket.
 *
 * Two independent guards, because they catch different writers:
 *
 *   LOCK  — mutual exclusion between processes that come through here. Held across the
 *           whole read-modify-write, so the interleaving above cannot occur at all.
 *   CAS   — a content version compared just before the write, which catches writers that
 *           did NOT take the lock: a hand edit, an editor save, an agent that wrote the
 *           file directly. The lock cannot stop those; the version check can refuse to
 *           overwrite them.
 *
 * No third-party dependencies.
 */

import { createHash } from "crypto";
import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync,
} from "fs";
import { dirname, join, basename } from "path";

/** Wait between lock-acquisition attempts. */
const LOCK_POLL_MS = 25;
/** How long to wait for a held lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
/**
 * A lock older than this is treated as abandoned. Board mutations are sub-second; a lock
 * surviving this long means the holder crashed between create and release, and refusing
 * every future write because of it would be a worse failure than stealing it.
 */
export const LOCK_STALE_MS = 30_000;

/** Raised when the board changed underneath a writer. Carries the versions for reporting. */
export class BoardConflictError extends Error {
  /**
   * @param {string} message
   * @param {{expected?: string, actual?: string, path?: string}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = "BoardConflictError";
    this.code = "EBOARDCONFLICT";
    Object.assign(this, detail);
  }
}

/** Raised when the lock could not be acquired in time — someone else is mid-write. */
export class BoardLockError extends Error {
  /** @param {string} message @param {{path?: string, holder?: any}} [detail] */
  constructor(message, detail = {}) {
    super(message);
    this.name = "BoardLockError";
    this.code = "EBOARDLOCK";
    Object.assign(this, detail);
  }
}

/**
 * Content version of a board file, used for compare-and-swap.
 *
 * A hash of the bytes rather than mtime+size: two writes in the same millisecond that
 * happen to produce the same file size are indistinguishable by stat, and "same size,
 * different ticket" is exactly what a lost update looks like (one ticket swapped for
 * another). The value is opaque to callers — only equality is ever meaningful.
 *
 * @param {string} dataPath absolute path to a board JSON file
 * @returns {string} version token; a stable sentinel when the file does not exist
 */
export function boardVersion(dataPath) {
  if (!existsSync(dataPath)) return "sha256:absent";
  return "sha256:" + createHash("sha256").update(readFileSync(dataPath)).digest("hex").slice(0, 32);
}

/**
 * Replace a file's contents without ever leaving a partial file on disk.
 *
 * Writes a sibling temp file (same directory, so the rename stays on one filesystem and is
 * therefore atomic) and renames it over the target. A crash mid-write loses the temp file,
 * not the board — the previous board stays intact and readable.
 *
 * @param {string} path
 * @param {string} text
 */
export function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** @param {number} ms */
function sleepSync(ms) {
  // Synchronous on purpose: the lock is held across a synchronous read-modify-write, and
  // an await here would let another task in the same process interleave inside the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} lockPath */
function readHolder(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return null; }
}

/**
 * Run `fn` holding an exclusive lock on the board directory.
 *
 * The lock is a file created with the `wx` flag — create-if-absent is atomic at the OS
 * level, so two processes racing to create it cannot both win. It guards the DIRECTORY,
 * not a single file, because the land-and-archive transition mutates data.json and
 * archive.json together and must be all-or-nothing with respect to other writers.
 *
 * @template T
 * @param {string} boardDir
 * @param {(ctx: {lockPath: string}) => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, op?: string, onStaleSteal?: (h: any) => void}} [opts]
 * @returns {T}
 */
export function withBoardLock(boardDir, fn, opts = {}) {
  const { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, op = "write", onStaleSteal } = opts;
  const lockPath = join(boardDir, ".board.lock");
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      // Age comes from the lock file's own mtime, NOT from the JSON inside it. `wx` creates
      // the file empty and the holder record lands a moment later, so a content-derived age
      // reads a live, freshly-taken lock as unidentifiable — and stealing it lets two
      // writers into the critical section, which is the exact bug this module exists to
      // prevent. It cost 3 of 8 concurrent writes when this was content-based.
      let age;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === "ENOENT") continue; // released underneath us — try to take it
        throw statErr;
      }
      const holder = readHolder(lockPath);
      if (age >= staleMs) {
        try { unlinkSync(lockPath); } catch { /* another waiter got there first */ }
        onStaleSteal?.(holder);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new BoardLockError(
          `Timed out after ${timeoutMs}ms waiting for the board lock at ${lockPath}. ` +
          `Held by pid ${holder?.pid ?? "?"} since ${holder?.at ?? "?"} (${holder?.op ?? "?"}). ` +
          `If that process is gone, delete the lock file and retry.`,
          { path: lockPath, holder },
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }

  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), op }));
    closeSync(fd);
    fd = null;
    return fn({ lockPath });
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(lockPath); } catch { /* stolen as stale, or never created */ }
  }
}

/**
 * Read → mutate → validate → write, with both guards applied.
 *
 * `mutate` receives the board as it is ON DISK RIGHT NOW, inside the lock — never a copy
 * the caller read earlier. That is what makes a mutation expressed declaratively ("set
 * T-010 to blocked") immune to the lost-update race: there is no stale in-memory board for
 * it to be applied to.
 *
 * @param {object} params
 * @param {string} params.dataPath           absolute path to data.json
 * @param {string} [params.archivePath]      absolute path to archive.json (defaults alongside)
 * @param {(ctx: {data: any, archive: any}) => {data?: any, archive?: any, result?: any}} params.mutate
 * @param {string} [params.expectVersion]    caller's version; refuse if disk has moved on
 * @param {(board: {data: any, archive: any}) => string[]} [params.validate] returns errors
 * @param {string} [params.op]               short label recorded in the lock file
 * @returns {{result: any, version: string, archiveVersion: string, changed: boolean}}
 */
export function mutateBoard({ dataPath, archivePath, mutate, expectVersion, validate, op = "write" }) {
  const boardDir = dirname(dataPath);
  const archPath = archivePath ?? join(boardDir, "archive.json");

  return withBoardLock(boardDir, () => {
    const onDisk = boardVersion(dataPath);
    // CAS against writers that never took the lock (hand edits, the cockpit, a stray agent).
    if (expectVersion != null && expectVersion !== onDisk) {
      throw new BoardConflictError(
        `The board at ${dataPath} changed on disk since you read it ` +
        `(expected ${expectVersion}, found ${onDisk}). Re-read it and reapply the change — ` +
        `writing now would silently drop whatever the other writer added.`,
        { expected: expectVersion, actual: onDisk, path: dataPath },
      );
    }

    const data = readJSONOr(dataPath, { epics: [], tickets: [] });
    const archive = readJSONOr(archPath, { epics: [], tickets: [] });

    const out = mutate({ data, archive }) ?? {};
    const nextData = out.data ?? data;
    const nextArchive = out.archive ?? archive;

    const errors = validate?.({ data: nextData, archive: nextArchive }) ?? [];
    if (errors.length) {
      throw new Error(
        `Refusing to write ${dataPath} — the result would be an invalid board:\n` +
        errors.map((e) => `  • ${e}`).join("\n"),
      );
    }

    const dataText = JSON.stringify(nextData, null, 2) + "\n";
    const archText = JSON.stringify(nextArchive, null, 2) + "\n";
    const dataChanged = !existsSync(dataPath) || readFileSync(dataPath, "utf8") !== dataText;
    const archChanged = out.archive !== undefined &&
      (!existsSync(archPath) || readFileSync(archPath, "utf8") !== archText);

    // archive.json first: if the process dies between the two writes, a ticket present in
    // both files is a loud validator error, while a ticket in neither is silent data loss.
    if (archChanged) writeAtomic(archPath, archText);
    if (dataChanged) writeAtomic(dataPath, dataText);

    return {
      result: out.result,
      version: boardVersion(dataPath),
      archiveVersion: boardVersion(archPath),
      changed: dataChanged || archChanged,
    };
  }, { op });
}

/** @param {string} p @param {any} fallback */
function readJSONOr(p, fallback) {
  if (!existsSync(p)) return fallback;
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Never fall back to an empty board on a parse error: the caller would "mutate" an
    // empty board and write it, destroying every ticket in the file.
    throw new Error(`Invalid JSON in ${p}: ${e.message}. Fix the file before writing to it.`);
  }
}
