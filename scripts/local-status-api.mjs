/**
 * local-status-api.mjs — the locked operations over the shared status store (see local-status.mjs):
 * reading one ticket, the daily sync into the board files, backup/export, import and the log.
 * Re-exported from `@mychiefmind/ai-maestro/board`.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withBoardLock, withStatusLock, writeAtomic, boardVersion, effectiveVersion, snapshotVersion } from "./board-io.mjs";
import { tryBackup } from "./board-backup.mjs";
import { loadBoardContext, resolveBoardPaths, validateBoardContext } from "./board-context.mjs";
import { archiveTicketOperation } from "./board-operations.mjs";
import {
  localStatusSettings, readStore, commitStore, overlayBoard, entryFor, logEntry, readLog,
  applyLocalStatus, assertLocations, STORE_SCHEMA_VERSION,
} from "./local-status.mjs";
import { canonical } from "./delivery-values.mjs";
import { BoardInputError, BoardNotFoundError, BoardValidationError } from "./board-errors.mjs";

/** Backups kept per board in the common dir. */
export const STATUS_BACKUP_KEEP = 30;

function settingsOrThrow(paths) {
  const s = localStatusSettings({ dataPath: paths.dataPath, configPath: paths.configPath });
  if (!s) {
    throw new BoardInputError(
      `Local status is not enabled for ${paths.dataPath}. Set "localStatus": { "enabled": true } in ${paths.configPath}.`,
      { field: "localStatus" });
  }
  return s;
}

function readJSONOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return fallback;
  try { return JSON.parse(raw); }
  catch (e) { throw new BoardInputError(`Invalid JSON in ${path}: ${e.message}`, { path }); }
}

/**
 * One ticket as every reader sees it: definitions from the files, progress from the shared
 * store when localStatus is on. Searches the active board, then the archive.
 *
 * @returns {{ticket: object, location: "board"|"archive", source: "local-status"|"files",
 *   version: string, archiveVersion: string, localStatus: {ref, oid}|null}}
 */
export function readTicket(options = {}) {
  const id = options.id;
  if (typeof id !== "string" || !id) throw new BoardNotFoundError("Ticket id is required.");
  const paths = resolveBoardPaths(options);
  return withBoardLock(paths.boardDir, () => {
    const context = loadBoardContext(options);
    const live = (context.data.tickets ?? []).find((t) => t?.id === id);
    const archived = live ? null : (context.archive.tickets ?? []).find((t) => t?.id === id);
    if (!live && !archived) throw new BoardNotFoundError(`Ticket ${id} was not found.`, { id, kind: "ticket" });
    let source = "files";
    if (context.localStatus) {
      const { store } = context.localStatus;
      if (Object.prototype.hasOwnProperty.call(store.tickets, id)) source = "local-status";
    }
    return {
      ticket: live ?? archived, location: live ? "board" : "archive", source,
      version: snapshotVersion(paths.dataPath, context.localStatus), archiveVersion: snapshotVersion(paths.archivePath, context.localStatus),
      localStatus: context.localStatus ? { ref: context.localStatus.ref, oid: context.localStatus.oid } : null,
    };
  }, { op: "read-ticket", ...(options.lockOptions ?? {}) });
}

/**
 * Overlay the shared status onto board contents the caller read elsewhere — typically the
 * definitions at a commit (`git show <sha>:maestro/board/data.json`). A no-op when localStatus
 * is off. `boardPath` names the board in this checkout, which identifies the store.
 */
export function overlayLocalStatus(options = {}) {
  const paths = resolveBoardPaths(options);
  const out = applyLocalStatus({
    dataPath: paths.dataPath, configPath: paths.configPath,
    data: options.data ?? { epics: [], tickets: [] }, archive: options.archive ?? { epics: [], tickets: [] },
  });
  return { data: out.data, archive: out.archive, localStatus: out.localStatus ? { ref: out.localStatus.ref, oid: out.localStatus.oid } : null };
}

/** The raw store: `{ enabled, ref, oid, board, tickets }`; `enabled: false` when off. */
export function readLocalStatus(options = {}) {
  const paths = resolveBoardPaths(options);
  const s = localStatusSettings({ dataPath: paths.dataPath, configPath: paths.configPath });
  if (!s) return { enabled: false };
  const { oid, store } = readStore(s);
  return { enabled: true, ref: s.ref, oid, board: s.board, fields: s.fields, tickets: store.tickets };
}

/** The append-only change log, newest first. */
export function localStatusLog(options = {}) {
  const paths = resolveBoardPaths(options);
  return { entries: readLog(settingsOrThrow(paths), { limit: options.limit }) };
}

function backupDir(s) { return join(s.lockDir, "backups", s.boardKey); }

function exportDocument(s, oid, store) {
  return { kind: "maestro-local-status", schemaVersion: STORE_SCHEMA_VERSION, board: s.board, ref: s.ref, oid,
    exportedAt: new Date().toISOString(), store };
}

function writeBackup(s, oid, store) {
  const dir = backupDir(s);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.json`);
  writeAtomic(path, JSON.stringify(exportDocument(s, oid, store), null, 2) + "\n");
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - STATUS_BACKUP_KEEP))) {
    try { unlinkSync(join(dir, old)); } catch { /* best effort */ }
  }
  return path;
}

/**
 * Snapshot the store. With `out` it is written there; otherwise into the common dir's
 * `maestro/status/backups/<boardKey>/` (newest STATUS_BACKUP_KEEP kept). The document is
 * also returned, so callers can stream it elsewhere.
 */
export function exportLocalStatus(options = {}) {
  const paths = resolveBoardPaths(options);
  const s = settingsOrThrow(paths);
  return withStatusLock(s, () => {
    const { oid, store } = readStore(s);
    const document = exportDocument(s, oid, store);
    let path = null;
    if (options.out) { path = options.out; writeAtomic(path, JSON.stringify(document, null, 2) + "\n"); }
    else if (options.out !== false) path = writeBackup(s, oid, store);
    return { path, document };
  }, { op: "status-export", ...(options.lockOptions ?? {}) });
}

/**
 * Load an export back into the store as one new, logged commit. `mode: "merge"` (default)
 * replaces only the tickets the export names; `"replace"` installs the export exactly.
 */
export function importLocalStatus(options = {}) {
  const paths = resolveBoardPaths(options);
  const s = settingsOrThrow(paths);
  const doc = options.document ?? readJSONOr(options.file, null);
  if (!doc || doc.kind !== "maestro-local-status" || doc.schemaVersion !== STORE_SCHEMA_VERSION || !doc.store?.tickets) {
    throw new BoardInputError("Not a maestro local status export.");
  }
  if (doc.board !== s.board) throw new BoardInputError(`The export belongs to board ${doc.board}, not ${s.board}.`);
  assertLocations(doc.store);
  const mode = options.mode ?? "merge";
  if (!["merge", "replace"].includes(mode)) throw new BoardInputError('mode must be "merge" or "replace".', { field: "mode" });
  return withStatusLock(s, () => {
    const { oid, store } = readStore(s);
    const next = { ...store, tickets: mode === "replace" ? { ...doc.store.tickets } : { ...store.tickets, ...doc.store.tickets } };
    const ids = [...new Set([...Object.keys(store.tickets), ...Object.keys(next.tickets)])]
      .filter((id) => canonical(store.tickets[id] ?? null) !== canonical(next.tickets[id] ?? null));
    if (!ids.length) return { changed: false, oid, tickets: [] };
    if (options.dryRun) return { changed: true, dryRun: true, oid, tickets: ids };
    const changes = ids.map((id) => ({ id, from: brief(store.tickets[id]), to: brief(next.tickets[id]) }));
    const newOid = commitStore(s, oid, next, logEntry(s, `status-import(${mode})`, changes));
    return { changed: true, oid: newOid, tickets: ids };
  }, { op: "status-import", ...(options.lockOptions ?? {}) });
}

const brief = (entry) => (entry ? { location: entry.location, status: entry.fields?.status ?? null } : null);

/**
 * Write the logical board (files + shared status) into data.json / archive.json, archiving
 * tickets whose status is `done`. Run it once a day in one worktree and commit the result in
 * one PR. A run with nothing to change writes nothing (`changed: false`). Every run that writes
 * first saves a store backup.
 *
 * @param {{boardPath?: string, dataPath?: string, dryRun?: boolean, archiveDone?: boolean}} options
 * @returns {{changed: boolean, dryRun?: boolean, files: string[], archived: string[], updated: string[],
 *   version: string, localStatus: {ref, oid}, backup?: string}}
 */
export function syncLocalStatus(options = {}) {
  const paths = resolveBoardPaths(options);
  const s = settingsOrThrow(paths);
  return withBoardLock(paths.boardDir, () => withStatusLock(s, () => {
    const fileData = readJSONOr(paths.dataPath, null);
    if (!fileData) throw new BoardNotFoundError(`Board file not found: ${paths.dataPath}.`, { path: paths.dataPath });
    const fileArchive = readJSONOr(paths.archivePath, { epics: [], tickets: [] });
    const { oid, store } = readStore(s);
    const view = overlayBoard(fileData, fileArchive, store);
    const today = new Date().toISOString().slice(0, 10);

    const archived = [];
    if (options.archiveDone !== false) {
      for (const ticket of [...(view.data.tickets ?? [])].filter((t) => t?.status === "done")) {
        const doneAt = ticket.done_at ?? ticket.doneAt ?? store.tickets[ticket.id]?.updatedAt?.slice(0, 10) ?? today;
        archiveTicketOperation({ data: view.data, archive: view.archive }, {
          id: ticket.id, status: "done", doneAt,
          evidence: ticket.evidence || `Done; archived by maestro status sync on ${today}.`,
        });
        archived.push(ticket.id);
      }
    }

    const context = { ...loadBoardContext(paths), data: view.data, archive: view.archive };
    const verdict = validateBoardContext(context);
    if (verdict.errors.length) {
      throw new BoardValidationError(
        `Refusing to sync ${paths.dataPath} — the synced board would be invalid:\n` +
        verdict.errors.map((e) => `  • ${e}`).join("\n"), { errors: verdict.errors, warnings: verdict.warnings, path: paths.dataPath });
    }

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const dataChanged = !same(view.data, fileData);
    const archChanged = !same(view.archive, fileArchive);
    const fileIds = new Map([...(fileData.tickets ?? []), ...(fileArchive.tickets ?? [])].map((t) => [t.id, t]));
    const updated = [...(view.data.tickets ?? []), ...(view.archive.tickets ?? [])]
      .filter((t) => fileIds.has(t.id) && !same(t, fileIds.get(t.id)) && !archived.includes(t.id)).map((t) => t.id);
    const nextStore = { ...store, tickets: { ...store.tickets } };
    const at = new Date().toISOString();
    for (const id of archived) nextStore.tickets[id] = entryFor(view.archive.tickets.find((t) => t.id === id), "archive", s.fields, at);
    const storeChanged = archived.length > 0;
    const changed = dataChanged || archChanged || storeChanged;
    const files = [archChanged && paths.archivePath, dataChanged && paths.dataPath].filter(Boolean);
    const result = { changed, files, archived, updated, localStatus: { ref: s.ref, oid } };
    if (!changed) return { ...result, version: effectiveVersion(paths.dataPath, paths) };
    if (options.dryRun) return { ...result, dryRun: true, version: effectiveVersion(paths.dataPath, paths) };

    const backup = writeBackup(s, oid, store);
    let newOid = oid;
    if (storeChanged) {
      newOid = commitStore(s, oid, nextStore, logEntry(s, "status-sync", archived.map((id) => ({
        id, from: brief(store.tickets[id]) ?? { location: "board", status: "done" }, to: { location: "archive", status: "done" },
      })), at));
    }
    const backupError = tryBackup(files, { boardDir: paths.boardDir });
    // Destination first, as in mutateBoard: a crash between the renames leaves a moved ticket in
    // both files (a loud validator error), never in neither.
    if (archChanged) writeAtomic(paths.archivePath, JSON.stringify(view.archive, null, 2) + "\n");
    if (dataChanged) writeAtomic(paths.dataPath, JSON.stringify(view.data, null, 2) + "\n");
    return {
      ...result, localStatus: { ref: s.ref, oid: newOid }, backup,
      version: effectiveVersion(paths.dataPath, paths), fileVersion: boardVersion(paths.dataPath),
      ...(backupError ? { backupError } : {}),
    };
  }, { op: "status-sync" }), { op: "status-sync", ...(options.lockOptions ?? {}) });
}
