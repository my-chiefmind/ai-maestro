/**
 * local-status.mjs — machine-local ticket status shared by every git worktree (opt-in).
 *
 * THE PROBLEM: with status in board/data.json, every status change and archive move is a git
 * change that needs its own commit, PR, review, resync with main and merge. On a busy board that
 * admin costs as much as delivery itself.
 *
 * THE SPLIT, when `config.json` has `"localStatus": { "enabled": true }`:
 *
 *   DEFINITIONS  — name, desc, acceptance criteria, touches, gates, testCmd, epic … stay in
 *                  board/data.json and archive.json, in git, exactly as before.
 *   VOLATILE     — status, current/next agent, evidence, done_at, claim and lane state (the
 *                  `fields` list) and whether a ticket is archived live in ONE store per
 *                  machine and board, inside the git common dir. Every worktree of the
 *                  repository reads and writes the same copy; nothing is committed per change.
 *
 * Every read overlays the store onto the files (`overlayBoard`), so callers see one logical
 * board. `maestro status sync` writes that logical board back into the files once a day.
 *
 * STORAGE reuses the guarded-delivery ledger mechanism (scripts/delivery-store.mjs): a JSON
 * record in a commit at `refs/maestro/<namespace>/status/<boardKey>`. Refs under refs/maestro/
 * live in the common dir, so all worktrees see one value. Each write is a new commit whose
 * parent is the previous one and is installed with `git update-ref <ref> <new> <old>` — a
 * compare-and-swap, so a writer working from a stale copy fails instead of losing an update.
 * The commit chain is the append-only change log: every commit message carries a JSON entry
 * naming the operation, the worktree and each ticket's before/after.
 *
 * This module is pure storage and overlay logic. The locking callers live in board-io.mjs
 * (mutateBoard) and local-status-api.mjs (sync, export, import).
 *
 * No third-party dependencies.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { git, identifier } from "./delivery-store.mjs";
import { canonical, digest } from "./delivery-values.mjs";
import { BoardConflictError, BoardInputError } from "./board-errors.mjs";

/**
 * Ticket fields that are progress, not definition. `claim` and `lane` are reserved for
 * coordinators that record claim/lane state on the ticket. A project adds its own with
 * `localStatus.fields` (for example a gate that flips during delivery).
 */
export const DEFAULT_STATUS_FIELDS = Object.freeze([
  "status", "currentAgent", "nextAgent", "evidence", "done_at", "doneAt", "claim", "lane",
]);
export const STORE_SCHEMA_VERSION = 1;
const LOCATIONS = ["board", "archive"];

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function readConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf8")); }
  catch { return null; } // the validator reports a broken config; an unreadable one means "off"
}

const repoCache = new Map();
function repoFacts(boardDir) {
  if (repoCache.has(boardDir)) return repoCache.get(boardDir);
  const result = git(boardDir, ["rev-parse", "--show-toplevel", "--git-common-dir"], { allowFailure: true });
  if (result.status !== 0) {
    throw new BoardInputError(
      `localStatus is enabled but ${boardDir} is not inside a git repository. The shared status ` +
      `store lives in the git common dir; run 'git init' or disable localStatus.`, { path: boardDir });
  }
  const [top, common] = result.stdout.trim().split("\n");
  const facts = { top: realpathSync(top), common: realpathSync(resolve(boardDir, common)) };
  repoCache.set(boardDir, facts);
  return facts;
}

/**
 * The local-status settings for a board, or null when the feature is off (the default).
 *
 * @param {{dataPath: string, configPath?: string, config?: object|null}} options
 *   `config` short-circuits reading `configPath` when the caller already has it.
 */
export function localStatusSettings({ dataPath, configPath, config } = {}) {
  const absData = resolve(dataPath);
  const boardDir = dirname(absData);
  const cfg = config !== undefined ? config : readConfig(configPath ?? join(boardDir, "..", "config.json"));
  const policy = cfg?.localStatus;
  if (policy == null || policy.enabled === false) return null;
  const bad = (message) => { throw new BoardInputError(`config.localStatus: ${message}`, { field: "localStatus" }); };
  if (typeof policy !== "object" || Array.isArray(policy)) bad("must be an object.");
  if (policy.enabled !== true) bad("enabled must be true or false.");
  const known = new Set(["enabled", "fields", "namespace"]);
  const unknown = Object.keys(policy).filter((k) => !known.has(k));
  if (unknown.length) bad(`unknown key(s): ${unknown.join(", ")}.`);
  if (policy.fields != null && !(Array.isArray(policy.fields) && policy.fields.every((f) => typeof f === "string" && f && f !== "id"))) {
    bad("fields must be an array of ticket field names (never \"id\").");
  }
  const namespace = identifier(policy.namespace ?? cfg?.delivery?.namespace ?? "maestro", "localStatus namespace");
  const fields = [...new Set([...DEFAULT_STATUS_FIELDS, ...(policy.fields ?? [])])];

  const { top, common } = repoFacts(boardDir);
  const board = relative(top, join(realpathSync(boardDir), basename(absData))).split("\\").join("/");
  if (!board || board.startsWith("../") || isAbsolute(board)) bad("the board must be inside its git repository.");
  // The board's path inside the repository is its identity: the same in every worktree.
  const boardKey = digest(["local-status", board]).slice(0, 16);
  return {
    repo: top, common, board, boardKey, namespace, fields,
    ref: `refs/maestro/${namespace}/status/${boardKey}`,
    lockDir: join(common, "maestro", "status"),
    lockName: `${boardKey}.lock`,
  };
}

function emptyStore(s) {
  return { schemaVersion: STORE_SCHEMA_VERSION, board: s.board, tickets: {} };
}

/** Current store and the commit it came from (`oid` null when nothing was ever written). */
export function readStore(s) {
  const head = git(s.repo, ["rev-parse", "--verify", "--quiet", `${s.ref}^{commit}`], { allowFailure: true });
  const oid = head.status === 0 ? head.stdout.trim() : null;
  if (!oid) return { oid: null, store: emptyStore(s) };
  let store;
  try { store = JSON.parse(git(s.repo, ["cat-file", "blob", `${oid}:record.json`])); }
  catch { throw new BoardInputError(`The local status store at ${s.ref} is unreadable. Restore it from 'maestro status export' backups.`); }
  if (store?.schemaVersion !== STORE_SCHEMA_VERSION || store.board !== s.board || !store.tickets || typeof store.tickets !== "object") {
    throw new BoardInputError(`The local status store at ${s.ref} does not belong to board ${s.board}.`);
  }
  return { oid, store };
}

/**
 * Install `store` as the next commit after `expected`. Compare-and-swap: when another writer
 * moved the ref first, nothing is installed and BoardConflictError is thrown.
 */
export function commitStore(s, expected, store, logEntry) {
  const blob = git(s.repo, ["hash-object", "-w", "--stdin"], { input: `${canonical(store)}\n` });
  const tree = git(s.repo, ["mktree"], { input: `100644 blob ${blob}\trecord.json\n` });
  const who = { GIT_AUTHOR_NAME: "Maestro status", GIT_AUTHOR_EMAIL: "maestro@localhost",
    GIT_COMMITTER_NAME: "Maestro status", GIT_COMMITTER_EMAIL: "maestro@localhost" };
  const message = `maestro status: ${logEntry.op}\n\n${JSON.stringify(logEntry)}\n`;
  const oid = git(s.repo, ["commit-tree", tree, ...(expected ? ["-p", expected] : [])], { input: message, env: who });
  const result = git(s.repo, ["update-ref", s.ref, oid, expected ?? ""], { allowFailure: true });
  if (result.status !== 0) {
    throw new BoardConflictError(
      `The shared ticket status changed underneath this write (another worktree wrote first). ` +
      `Re-read and retry.`, { expected, path: s.ref });
  }
  return oid;
}

/** Version token for a board file pair plus the store generation it was read with. */
export function compositeVersion(fileVersion, storeOid) {
  return "sha256:" + createHash("sha256").update(`${fileVersion}\n${storeOid ?? "empty"}`).digest("hex").slice(0, 32);
}

function volatileOf(ticket, fields) {
  const out = {};
  for (const f of fields) if (own(ticket, f)) out[f] = ticket[f];
  return out;
}
function definitionOf(ticket, fields) {
  const out = {};
  for (const [k, v] of Object.entries(ticket)) if (!fields.includes(k)) out[k] = v;
  return out;
}

/** Store entry recording a ticket's volatile fields and where it lives. */
export function entryFor(ticket, location, fields, at = new Date().toISOString()) {
  const values = volatileOf(ticket, fields);
  return { location, fields: clone(values), cleared: fields.filter((f) => !own(values, f)), updatedAt: at };
}

function applyEntry(ticket, entry) {
  const out = { ...ticket };
  for (const f of entry.cleared ?? []) delete out[f];
  Object.assign(out, clone(entry.fields ?? {}));
  return out;
}

/**
 * The logical board: the files with the store applied. Pure; never mutates its inputs.
 * Tickets the store does not mention are exactly as the files have them. A ticket the store
 * marks archived leaves the active list for the archive (with its epic copied alongside, as
 * `maestro ticket archive` does), and the reverse for one the store restored.
 */
export function overlayBoard(data, archive, store) {
  const files = { data: clone(data) ?? { epics: [], tickets: [] }, archive: clone(archive) ?? { epics: [], tickets: [] } };
  const entries = store?.tickets ?? {};
  if (!Object.keys(entries).length) return files;
  const outData = { ...files.data, tickets: [] };
  const outArchive = { ...files.archive, epics: [...(files.archive.epics ?? [])], tickets: [] };
  const toArchive = [], toBoard = [];
  for (const t of files.data.tickets ?? []) {
    const e = t && own(entries, t.id) ? entries[t.id] : null;
    if (!e) { outData.tickets.push(t); continue; }
    (e.location === "archive" ? toArchive : outData.tickets).push(applyEntry(t, e));
  }
  for (const t of files.archive.tickets ?? []) {
    const e = t && own(entries, t.id) ? entries[t.id] : null;
    if (!e) { outArchive.tickets.push(t); continue; }
    (e.location === "board" ? toBoard : outArchive.tickets).push(applyEntry(t, e));
  }
  for (const t of toArchive) {
    if (t.epicId && !(outArchive.epics ?? []).some((e) => e.id === t.epicId)) {
      const epic = (outData.epics ?? []).find((e) => e.id === t.epicId);
      if (epic) outArchive.epics.push(epic);
    }
    outArchive.tickets.push(t);
  }
  outData.tickets.push(...toBoard);
  return { data: outData, archive: outArchive };
}

function index(board) {
  const map = new Map();
  for (const t of board.data.tickets ?? []) if (t?.id != null) map.set(t.id, { t, loc: "board" });
  for (const t of board.archive.tickets ?? []) if (t?.id != null && !map.has(t.id)) map.set(t.id, { t, loc: "archive" });
  return map;
}

/**
 * Split a mutated logical board back into file contents and store entries.
 *
 * Only what the mutation CHANGED moves: a changed definition is written to the ticket where the
 * files hold it; changed volatile fields or a location move become a store entry; a ticket new to
 * the files is written to them whole (it is a definition change, and a commit carries it anyway).
 *
 * @returns {{data, archive, store, changes: Array<{id, from, to}>, storeChanged: boolean}}
 */
export function splitBoard({ files, before, after, store, fields, at = new Date().toISOString() }) {
  const data = clone(files.data) ?? { epics: [], tickets: [] };
  const archive = clone(files.archive) ?? { epics: [], tickets: [] };
  data.tickets ??= []; archive.tickets ??= [];
  const next = { ...store, tickets: { ...store.tickets } };
  const fileIdx = index({ data, archive });
  const b = index(before), a = index(after);
  const changes = [];
  const brief = (x) => (x ? { location: x.loc, status: x.t.status ?? null } : null);

  for (const [id, was] of b) {
    if (a.has(id)) continue;
    // Removed from the logical board altogether.
    const f = fileIdx.get(id);
    if (f) {
      const list = f.loc === "board" ? data.tickets : archive.tickets;
      list.splice(list.findIndex((t) => t.id === id), 1);
    }
    if (own(next.tickets, id)) { delete next.tickets[id]; changes.push({ id, from: brief(was), to: null }); }
  }
  for (const [id, now] of a) {
    const was = b.get(id);
    const f = fileIdx.get(id);
    if (!f) {
      (now.loc === "board" ? data.tickets : archive.tickets).push(clone(now.t));
      continue;
    }
    const defBefore = was ? definitionOf(was.t, fields) : null;
    const defAfter = definitionOf(now.t, fields);
    if (canonical(defBefore) !== canonical(defAfter)) {
      const list = f.loc === "board" ? data.tickets : archive.tickets;
      const i = list.findIndex((t) => t.id === id);
      list[i] = { ...clone(defAfter), ...volatileOf(list[i], fields) };
    }
    const moved = !was || was.loc !== now.loc;
    if (moved || canonical(volatileOf(was.t, fields)) !== canonical(volatileOf(now.t, fields))) {
      next.tickets[id] = entryFor(now.t, now.loc, fields, at);
      changes.push({ id, from: brief(was), to: brief(now) });
    }
  }

  // Epics are definitions. An archive copy of an epic that is still live and identical on the
  // active board is the shadow archiving a ticket leaves (the overlay re-creates it for tickets
  // the store archives), not file content; any other difference is a real epic change.
  const fileArchiveEpics = new Set((files.archive.epics ?? []).map((e) => e.id));
  const shadow = (board) => (e) => !fileArchiveEpics.has(e.id) &&
    (board.data.epics ?? []).some((live) => live.id === e.id && canonical(live) === canonical(e));
  const beforeArchiveEpics = (before.archive.epics ?? []).filter((e) => !shadow(before)(e));
  const afterArchiveEpics = (after.archive.epics ?? []).filter((e) => !shadow(after)(e));
  if (canonical(before.data.epics ?? []) !== canonical(after.data.epics ?? [])) data.epics = clone(after.data.epics);
  if (canonical(beforeArchiveEpics) !== canonical(afterArchiveEpics)) archive.epics = clone(afterArchiveEpics);
  for (const key of Object.keys(after.data)) if (key !== "tickets" && key !== "epics") data[key] = clone(after.data[key]);
  for (const key of Object.keys(after.archive)) if (key !== "tickets" && key !== "epics") archive[key] = clone(after.archive[key]);

  return { data, archive, store: next, changes, storeChanged: canonical(next.tickets) !== canonical(store.tickets) };
}

/** The log entry recorded in each store commit. */
export function logEntry(s, op, changes, at = new Date().toISOString()) {
  let branch = null;
  try { branch = git(s.repo, ["branch", "--show-current"]) || null; } catch { /* detached */ }
  return { at, op, worktree: s.repo, branch, pid: process.pid, changes };
}

/** The change log, newest first. */
export function readLog(s, { limit = 50 } = {}) {
  const head = git(s.repo, ["rev-parse", "--verify", "--quiet", `${s.ref}^{commit}`], { allowFailure: true });
  if (head.status !== 0) return [];
  const out = git(s.repo, ["log", `-n${Math.max(1, Number(limit) || 50)}`, "--format=%H%x1f%B%x1e", s.ref]);
  return out.split("\x1e").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [oid, body = ""] = chunk.split("\x1f");
    const json = body.split("\n").slice(2).join("\n").trim();
    let entry = null;
    try { entry = JSON.parse(json); } catch { /* foreign commit message */ }
    return { oid, ...(entry ?? { op: body.split("\n")[0] }) };
  });
}

/**
 * Overlay the shared status onto board contents the caller already holds — for example
 * `git show <sha>:board/data.json`. Returns the inputs untouched when localStatus is off.
 */
export function applyLocalStatus({ dataPath, configPath, config, data, archive }) {
  const s = localStatusSettings({ dataPath, configPath, config });
  if (!s) return { data, archive, localStatus: null };
  const { oid, store } = readStore(s);
  return { ...overlayBoard(data, archive, store), localStatus: { ref: s.ref, oid, settings: s, store } };
}

export function assertLocations(store) {
  for (const [id, entry] of Object.entries(store.tickets ?? {})) {
    if (!entry || !LOCATIONS.includes(entry.location) || typeof entry.fields !== "object" || !Array.isArray(entry.cleared ?? [])) {
      throw new BoardInputError(`Local status entry for ${id} is malformed.`, { id });
    }
  }
}
