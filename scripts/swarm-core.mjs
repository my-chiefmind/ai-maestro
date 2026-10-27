/** Configuration helpers and the exclusive merge lock for the optional Maestro swarm policy. */

import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "fs";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { isAbsolute, join, resolve } from "path";
import { MAX_LANES, UNLIMITED_LANES } from "./lane-core.mjs";

export const DEFAULT_SWARM = Object.freeze({
  enabled: false,
  targetAgents: 10,
  waveMinutes: 30,
  autoMerge: false,
  timeoutsMinutes: Object.freeze({ xs: 60, s: 120, m: 240, l: 480 }),
});

export const SWARM_EXECUTION_CONTRACT = Object.freeze({
  coordinator: "invoking-swarm-session",
  dispatch: "direct-specialist-agents",
  spawnedCoordinator: false,
  stageAgents: Object.freeze({
    planning: "principal-engineer",
    implementation: "ticket-area-agent",
    qa: "qa",
    delivery: "principal-delivery",
    repair: "ticket-area-agent",
  }),
});

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function swarmPolicy(config = {}) {
  const saved = config?.orchestration?.swarm ?? {};
  return {
    ...DEFAULT_SWARM,
    ...saved,
    timeoutsMinutes: { ...DEFAULT_SWARM.timeoutsMinutes, ...(saved.timeoutsMinutes ?? {}) },
  };
}

export function validateSwarmConfig(config = {}) {
  const errors = [];
  const raw = config?.orchestration?.swarm;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    return ["orchestration.swarm must be an object."];
  }
  const policy = swarmPolicy(config);
  if (typeof policy.enabled !== "boolean") errors.push("orchestration.swarm.enabled must be boolean.");
  if (!integerIn(policy.targetAgents, 2, 64)) errors.push("orchestration.swarm.targetAgents must be an integer from 2 to 64.");
  if (!integerIn(policy.waveMinutes, 1, 1440)) errors.push("orchestration.swarm.waveMinutes must be an integer from 1 to 1440.");
  if (typeof policy.autoMerge !== "boolean") errors.push("orchestration.swarm.autoMerge must be boolean.");
  for (const size of ["xs", "s", "m", "l"]) {
    if (!integerIn(policy.timeoutsMinutes[size], 1, 10080)) {
      errors.push(`orchestration.swarm.timeoutsMinutes.${size} must be an integer from 1 to 10080.`);
    }
  }
  const worktrees = config?.orchestration?.maxWorktrees;
  if (worktrees != null && worktrees !== UNLIMITED_LANES && !integerIn(worktrees, 1, MAX_LANES)) {
    errors.push(`orchestration.maxWorktrees must be an integer from 1 to ${MAX_LANES}, or "${UNLIMITED_LANES}".`);
  }
  return errors;
}

export function updateSwarmConfig(config = {}, changes = {}) {
  const orchestration = { ...(config.orchestration ?? {}) };
  const current = swarmPolicy(config);
  const timeoutChanges = changes.timeoutsMinutes ?? {};
  const swarm = {
    ...current,
    ...changes,
    timeoutsMinutes: { ...current.timeoutsMinutes, ...timeoutChanges },
  };
  delete swarm.maxWorktrees;
  if (changes.maxWorktrees != null) orchestration.maxWorktrees = changes.maxWorktrees;
  orchestration.swarm = swarm;
  const updated = { ...config, orchestration };
  const errors = validateSwarmConfig(updated);
  if (errors.length) throw new Error(errors.join("\n"));
  return updated;
}

// ── Exclusive merge lock ──────────────────────────────────────────────────────────────────
//
// "One merge at a time" needs a primitive two coordinators on one host cannot both hold. The
// lock is a file created with the `wx` flag (atomic create-if-absent) inside the repository's
// *common* git directory, which every worktree of the checkout shares and no commit ever
// contains. The pattern is board-io.mjs's `.board.lock`, with one difference: a merge takes
// minutes, not milliseconds, so staleness is decided by the holder process being gone, with a
// long age ceiling only for locks that recorded no pid.

export const MERGE_LOCK_NAME = "maestro-merge.lock";
/** A lock older than this is treated as abandoned even when its holder pid is unknown. */
export const MERGE_LOCK_STALE_MS = 60 * 60 * 1000;

function gitCommonDir(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return isAbsolute(out) ? out : resolve(repoRoot, out);
  } catch {
    return null;
  }
}

/** Where the lock lives for the checkout at `repoRoot`; null when it is not a git checkout. */
export function mergeLockPath(repoRoot = process.cwd()) {
  const common = gitCommonDir(repoRoot);
  return common ? join(common, MERGE_LOCK_NAME) : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function readMergeHolder(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return null; }
}

/**
 * A lock is stale when its holder recorded a pid and that process is gone (it can never release
 * the lock itself), or when it recorded no pid and is older than `staleMs`. A lock whose
 * recorded holder process is still alive is never stale, however old: only that holder, or a
 * forced release, removes it.
 */
function lockIsStale(lockPath, holder, staleMs, now = Date.now()) {
  if (Number.isInteger(holder?.pid) && holder.pid > 0) return !processAlive(holder.pid);
  let age;
  try { age = now - statSync(lockPath).mtimeMs; } catch { return false; }
  return age > staleMs;
}

/** A break marker older than this belongs to a breaker that crashed mid-break. */
const BREAK_STALE_MS = 30 * 1000;

/**
 * Remove a stale lock without ever removing a live one. Breakers serialize on a second `wx`
 * marker, re-read the lock under it, and move the lock aside by atomic rename. If the file
 * moved aside is not the one judged stale (its holder released and a new holder took the lock
 * in between), it is linked straight back, so the new holder keeps its lock.
 */
function breakStaleLock(path, judged, staleMs, now) {
  const marker = `${path}.break`;
  try {
    if (now - statSync(marker).mtimeMs > BREAK_STALE_MS) unlinkSync(marker);
  } catch { /* no marker, or another breaker cleared it */ }
  let fd;
  try { fd = openSync(marker, "wx"); } catch { return false; }
  closeSync(fd);
  try {
    const current = readMergeHolder(path);
    if (!existsSync(path) || current?.token !== judged?.token || !lockIsStale(path, current, staleMs, now)) return false;
    const tomb = `${path}.stale-${randomUUID()}`;
    try { renameSync(path, tomb); } catch { return false; }
    const moved = readMergeHolder(tomb);
    if (moved?.token !== judged?.token) {
      try { linkSync(tomb, path); } catch { /* path re-taken; the moved lock was already superseded */ }
      unlinkSync(tomb);
      return false;
    }
    unlinkSync(tomb);
    return true;
  } finally {
    try { unlinkSync(marker); } catch { /* already gone */ }
  }
}

/**
 * Describe the lock without taking it. `available` is true whenever a lock path exists, so a
 * runtime status can truthfully say the primitive is there; `held` says whether a merge is in
 * progress right now.
 */
export function inspectMergeLock(repoRoot = process.cwd(), { staleMs = MERGE_LOCK_STALE_MS, now = Date.now() } = {}) {
  const path = mergeLockPath(repoRoot);
  if (!path) return { available: false, kind: null, path: null, held: false, holder: null, stale: false };
  if (!existsSync(path)) return { available: true, kind: "file", path, held: false, holder: null, stale: false };
  const holder = readMergeHolder(path);
  return { available: true, kind: "file", path, held: true, holder, stale: lockIsStale(path, holder, staleMs, now) };
}

/**
 * Take the merge lock, or report who holds it. Never waits: a coordinator that finds the lock
 * held leaves the PR queued and tries again on its next wave. A stale lock (see lockIsStale) is
 * broken safely (see breakStaleLock) and retaken once. Every lock carries a random `token`;
 * release checks it, so a lock can only be released by the call that took it.
 *
 * `holder.pid` should be the long-lived process that will perform the merge; when omitted the
 * lock records no pid and only age makes it stale.
 *
 * @returns {{acquired: true, path: string, holder: object} | {acquired: false, path: string|null, holder: object|null, reason: string}}
 */
export function acquireMergeLock({ repoRoot = process.cwd(), holder = {}, staleMs = MERGE_LOCK_STALE_MS, now = Date.now() } = {}) {
  const path = mergeLockPath(repoRoot);
  if (!path) return { acquired: false, path: null, holder: null, reason: `${repoRoot} is not a git checkout; no merge lock is available.` };
  if (typeof holder?.holder !== "string" || !holder.holder.trim()) {
    return { acquired: false, path, holder: null, reason: "A holder name is required to take the merge lock." };
  }
  const record = { takenAt: new Date(now).toISOString(), ...holder, token: randomUUID() };
  if (record.pid == null) delete record.pid;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify(record, null, 2) + "\n");
      closeSync(fd);
      return { acquired: true, path, holder: record };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readMergeHolder(path);
      // An unreadable lock (a crash between create and write) is stale only by age.
      if (attempt === 0 && lockIsStale(path, current, staleMs, now) && breakStaleLock(path, current, staleMs, now)) continue;
      const who = [current?.ticket ? `for ${current.ticket}` : "", current?.holder ? `by ${current.holder}` : ""].filter(Boolean).join(" ");
      return { acquired: false, path, holder: current, reason: `Merge lock is held${who ? ` ${who}` : ""}; one merge at a time.` };
    }
  }
  return { acquired: false, path, holder: readMergeHolder(path), reason: "Merge lock could not be taken." };
}

/**
 * Release the lock. The caller must name the holder that took it (and may pass the token for an
 * exact match); a lock held by anyone else, or one whose holder cannot be read, is refused
 * unless `force` is set. Releasing when nothing is held reports `notHeld` and is not an error.
 */
export function releaseMergeLock({ repoRoot = process.cwd(), holder = null, token = null, force = false } = {}) {
  const path = mergeLockPath(repoRoot);
  if (!path || !existsSync(path)) return { released: false, notHeld: true, path, holder: null, reason: "No merge lock is held." };
  const current = readMergeHolder(path);
  if (!force) {
    if (!holder) return { released: false, path, holder: current, reason: "Name the holder that took the lock (or force the release)." };
    if (!current?.holder) return { released: false, path, holder: current, reason: "The lock's holder cannot be read; only a forced release removes it." };
    if (current.holder !== holder || (token && current.token !== token)) {
      return { released: false, path, holder: current, reason: `Merge lock is held by ${current.holder}, not ${holder}.` };
    }
  }
  unlinkSync(path);
  return { released: true, path, holder: current };
}

/** Run `fn` holding the merge lock; this call's own lock is released even when `fn` throws. */
export function withMergeLock(opts, fn) {
  const lock = acquireMergeLock(opts);
  if (!lock.acquired) throw new Error(lock.reason);
  try { return fn(lock); }
  finally { releaseMergeLock({ repoRoot: opts?.repoRoot, holder: lock.holder.holder, token: lock.holder.token }); }
}

/**
 * Runtime status joins the requested policy with what this host can actually provide. Harness
 * capacity still cannot be observed from configuration. The merge lock can: `effectiveAutoMerge`
 * is true exactly when the policy asks for automatic merge and an exclusive file lock exists for
 * the checkout. Every automatic merge must still take that lock (`acquireMergeLock`, or
 * `maestro swarm lock`) and release it afterwards.
 */
export function swarmRuntimeStatus(config = {}, { repoRoot = process.cwd(), now = Date.now() } = {}) {
  const policy = swarmPolicy(config);
  const mergeLock = inspectMergeLock(repoRoot, { now });
  const effectiveAutoMerge = policy.autoMerge && mergeLock.available;
  return {
    ...SWARM_EXECUTION_CONTRACT,
    configuredTargetAgents: policy.targetAgents,
    observedHarnessCapacity: null,
    effectiveWorkerCapacity: null,
    capacityStatus: "requires-live-harness-observation",
    mergeLock,
    requestedAutoMerge: policy.autoMerge,
    effectiveAutoMerge,
    autoMergeBlocker: effectiveAutoMerge
      ? null
      : policy.autoMerge
        ? "No exclusive merge-lock primitive is available for this checkout (not a git checkout); automatic merge is fail-closed."
        : null,
  };
}
