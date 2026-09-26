/**
 * registry-write.mjs — safe mutation of a portfolio registry file (see registry.mjs for the
 * format). Public through the `./registry` export.
 *
 * Same discipline as board-io.mjs: a directory lock across the read-modify-write, a content
 * version for compare-and-swap against writers that did not take the lock (hand edits),
 * validation of the result before anything is written, and an atomic, fsync'd replace.
 *
 * Unlike the board, a registry is a hand-maintained file, so writes are SURGICAL: the text is
 * spliced at the exact span of the entry (or member) being changed and every other byte is
 * preserved. Parking an entry appends `"status": "parked"` to that entry; unparking removes the
 * member again (absent status means active), so park → unpark restores the file byte-for-byte.
 *
 * Scope: operations address the direct `projects` entries of the one file given. Nested
 * registries are not edited through their parent; pass the nested file's path instead.
 *
 * No third-party dependencies.
 */

import { existsSync, readFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { withBoardLock, boardVersion, writeAtomic, BoardLockError } from "./board-io.mjs";
import { ENTRY_KEYS, STATUSES, KINDS, expandHome, readRegistry } from "./registry.mjs";
import { scanJson, memberOf } from "./json-spans.mjs";

export const ABSENT_REGISTRY_VERSION = "sha256:absent";

class RegistryError extends Error {
  constructor(name, code, message, detail = {}) {
    super(message);
    this.name = name;
    this.code = code;
    Object.assign(this, detail);
  }
}
export class RegistryValidationError extends RegistryError {
  constructor(message, detail = {}) {
    super("RegistryValidationError", "EREGISTRYINVALID", message, { errors: detail.errors ?? [message], ...detail });
  }
}
export class RegistryConflictError extends RegistryError {
  constructor(message, detail = {}) { super("RegistryConflictError", "EREGISTRYCONFLICT", message, detail); }
}
export class RegistryLockError extends RegistryError {
  constructor(message, detail = {}) { super("RegistryLockError", "EREGISTRYLOCKED", message, detail); }
}
export class RegistryNotFoundError extends RegistryError {
  constructor(message, detail = {}) { super("RegistryNotFoundError", "EREGISTRYNOTFOUND", message, detail); }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function assertOptions(opts, required, optional) {
  if (!isObject(opts)) throw new RegistryValidationError("Registry options must be an object.");
  const known = new Set([...required, ...optional]);
  const unknown = Object.keys(opts).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new RegistryValidationError(`Unknown registry option(s): ${unknown.join(", ")}.`, { fields: unknown });
  }
  for (const k of required) {
    if (opts[k] === undefined) throw new RegistryValidationError(`Missing required registry option: ${k}.`, { fields: [k] });
  }
  if (typeof opts.registryPath !== "string" || !opts.registryPath.trim()) {
    throw new RegistryValidationError("registryPath must be a non-empty string.");
  }
  if (opts.expectVersion !== undefined && typeof opts.expectVersion !== "string") {
    throw new RegistryValidationError("expectVersion must be a string.");
  }
  if (opts.lockTimeoutMs !== undefined && !(Number.isFinite(opts.lockTimeoutMs) && opts.lockTimeoutMs >= 0)) {
    throw new RegistryValidationError("lockTimeoutMs must be a finite number >= 0.");
  }
}

const absPath = (p) => resolve(expandHome(p));
const entryName = (e) => e.name ?? e.path;

/** Structural errors in one entry, in the same terms registry.mjs enforces on read. */
export function entryErrors(entry, where = "entry") {
  if (!isObject(entry)) return [`${where}: must be an object.`];
  const errors = [];
  const unknown = Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k));
  if (unknown.length) errors.push(`${where}: unknown key(s) ${unknown.join(", ")} — an entry takes ${[...ENTRY_KEYS].join(", ")}.`);
  for (const k of ["name", "path", "registry"]) {
    if (entry[k] !== undefined && (typeof entry[k] !== "string" || !entry[k].trim())) errors.push(`${where}: "${k}" must be a non-empty string.`);
  }
  if (entry.note !== undefined && typeof entry.note !== "string") errors.push(`${where}: "note" must be a string.`);
  if (entry.registry !== undefined && entry.path !== undefined) errors.push(`${where}: has both "registry" and "path".`);
  if (entry.registry === undefined && entry.path === undefined) errors.push(`${where}: needs a "path" or a "registry".`);
  if (entry.status !== undefined && !STATUSES.has(entry.status)) errors.push(`${where}: status must be one of ${[...STATUSES].join(", ")}.`);
  if (entry.kind !== undefined && !KINDS.has(entry.kind)) errors.push(`${where}: kind must be one of ${[...KINDS].join(", ")}.`);
  return errors;
}

/** Validate a whole registry document (direct entries only). */
export function registryDocumentErrors(doc) {
  if (!isObject(doc)) return ["registry must be a JSON object."];
  if (!Array.isArray(doc.projects)) return ['"projects" must be an array.'];
  const errors = [];
  const seen = new Set();
  doc.projects.forEach((e, i) => {
    const errs = entryErrors(e, `projects[${i}]`);
    errors.push(...errs);
    if (!errs.length && e.registry === undefined) {
      const n = entryName(e);
      if (seen.has(n)) errors.push(`projects[${i}]: duplicate project name "${n}".`);
      seen.add(n);
    }
  });
  return errors;
}

function parseText(text, path) {
  try { return JSON.parse(text); }
  catch (e) { throw new RegistryValidationError(`The registry is not valid JSON: ${e.message}`, { path }); }
}

/** Opaque content version of a registry file, for compare-and-swap. */
export function getRegistryVersion(registryPath) {
  if (typeof registryPath !== "string" || !registryPath.trim()) throw new RegistryValidationError("registryPath must be a non-empty string.");
  return boardVersion(absPath(registryPath));
}

/**
 * Read one registry file as written — direct entries only, nested registries NOT resolved —
 * together with its version. Use readRegistry for the resolved project list.
 * @returns {{ projects: object[], version: string }}
 */
export function readRegistryDocument(registryPath) {
  const path = absPath(typeof registryPath === "string" ? registryPath : "");
  if (typeof registryPath !== "string" || !registryPath.trim()) throw new RegistryValidationError("registryPath must be a non-empty string.");
  if (!existsSync(path)) throw new RegistryNotFoundError("No registry file exists at the given path.", { path });
  const buf = readFileSync(path);
  const doc = parseText(buf.toString("utf8"), path);
  const errors = registryDocumentErrors(doc);
  if (errors.length) throw new RegistryValidationError(`The registry is not valid:\n  • ${errors.join("\n  • ")}`, { errors, path });
  return { projects: doc.projects, version: boardVersion(path) };
}

/**
 * Locked read → edit → validate → atomic write. `edit(text, doc, tree)` returns the new text,
 * or null for a no-op.
 */
function mutateRegistry(opts, op, edit, { allowMissing = false } = {}) {
  const path = absPath(opts.registryPath);
  const lockOptions = { op, lockName: `.${basename(path)}.lock` };
  if (opts.lockTimeoutMs !== undefined) lockOptions.timeoutMs = opts.lockTimeoutMs;
  try {
    return withBoardLock(dirname(path), () => {
      const onDisk = boardVersion(path);
      if (opts.expectVersion !== undefined && opts.expectVersion !== onDisk) {
        throw new RegistryConflictError(
          `The registry changed since you read it (expected ${opts.expectVersion}, found ${onDisk}). Re-read and reapply.`,
          { expected: opts.expectVersion, actual: onDisk, path },
        );
      }
      const exists = existsSync(path);
      if (!exists && !allowMissing) throw new RegistryNotFoundError("No registry file exists at the given path.", { path });
      const text = exists ? readFileSync(path, "utf8") : null;
      const doc = text === null ? { projects: [] } : parseText(text, path);
      const before = registryDocumentErrors(doc);
      if (before.length) {
        throw new RegistryValidationError(`Refusing to edit the registry — it is already invalid:\n  • ${before.join("\n  • ")}`, { errors: before, path });
      }
      const next = edit(text, doc, text === null ? null : scanJson(text));
      if (next === null) return { version: onDisk, changed: false };
      const nextDoc = parseText(next, path);
      const errors = registryDocumentErrors(nextDoc);
      if (errors.length) {
        throw new RegistryValidationError(`Refusing to write the registry — the result would be invalid:\n  • ${errors.join("\n  • ")}`, { errors, path });
      }
      writeAtomic(path, next);
      return { version: boardVersion(path), changed: true };
    }, lockOptions);
  } catch (e) {
    if (e instanceof BoardLockError) {
      throw new RegistryLockError(`Timed out after ${e.timeoutMs}ms waiting for the registry lock; another writer holds it.`, { holder: e.holder, timeoutMs: e.timeoutMs });
    }
    throw e;
  }
}

/** Index of the direct path entry named `name`, or -1. */
function findEntry(doc, name) {
  return doc.projects.findIndex((e) => e.registry === undefined && entryName(e) === name);
}

function assertName(name) {
  if (typeof name !== "string" || !name.trim()) throw new RegistryValidationError("name must be a non-empty string.");
}

/** `{ "k": v, … }` — the one-line entry style the registry format documents. */
function inlineEntry(entry) {
  const parts = Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * Append an entry. Creates the registry (`{ "projects": [...] }`) when the file is absent.
 * @param {{registryPath: string, entry: object, expectVersion?: string, lockTimeoutMs?: number}} opts
 * @returns {{ version: string, changed: true }}
 */
export function addRegistryEntry(opts) {
  assertOptions(opts, ["registryPath", "entry"], ["expectVersion", "lockTimeoutMs"]);
  const { entry } = opts;
  const errs = entryErrors(entry, "entry");
  if (errs.length) throw new RegistryValidationError(errs.join(" "), { errors: errs });
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));

  return mutateRegistry(opts, "registry-add", (text, doc, tree) => {
    if (clean.registry === undefined) {
      const name = entryName(clean);
      if (findEntry(doc, name) !== -1) {
        throw new RegistryValidationError(`A project named "${name}" is already in the registry.`, { errors: [`duplicate project name "${name}"`] });
      }
      // Names must be unique across the whole tree, not just this file; a clash with a nested
      // registry would make every consumer's readRegistry fail with EDUPNAME.
      if (text !== null) {
        let resolved = null;
        try { resolved = readRegistry(opts.registryPath, { includeParked: true }); } catch { /* tree unreadable — file-level check only */ }
        if (resolved?.projects.some((p) => p.name === name)) {
          throw new RegistryValidationError(`A project named "${name}" already exists in a nested registry.`, { errors: [`duplicate project name "${name}"`] });
        }
      }
    }
    const projectsMember = tree ? memberOf(tree, "projects") : null;
    if (text === null || !projectsMember || projectsMember.value.items.length === 0) {
      // Nothing to preserve inside the array: write the whole document canonically.
      return JSON.stringify({ ...doc, projects: [clean] }, null, 2) + "\n";
    }
    const items = projectsMember.value.items;
    const last = items[items.length - 1];
    // Reuse the whitespace that already separates entries, so the new one lines up.
    const sep = items.length > 1
      ? text.slice(text.indexOf(",", items[items.length - 2].end) + 1, last.start)
      : text.slice(projectsMember.value.start + 1, items[0].start);
    return text.slice(0, last.end) + "," + sep + inlineEntry(clean) + text.slice(last.end);
  }, { allowMissing: true });
}

/**
 * Remove the direct project entry named `name` (its `name`, or its `path` when unnamed).
 * @param {{registryPath: string, name: string, expectVersion?: string, lockTimeoutMs?: number}} opts
 * @returns {{ version: string, changed: true }}
 */
export function removeRegistryEntry(opts) {
  assertOptions(opts, ["registryPath", "name"], ["expectVersion", "lockTimeoutMs"]);
  assertName(opts.name);
  return mutateRegistry(opts, "registry-remove", (text, doc, tree) => {
    const idx = findEntry(doc, opts.name);
    if (idx === -1) throw new RegistryNotFoundError(`No project named "${opts.name}" in the registry.`, { name: opts.name });
    const arr = memberOf(tree, "projects").value;
    const items = arr.items;
    const it = items[idx];
    if (items.length === 1) return text.slice(0, arr.start + 1) + text.slice(arr.end - 1);
    if (idx < items.length - 1) return text.slice(0, it.start) + text.slice(items[idx + 1].start);
    return text.slice(0, items[idx - 1].end) + text.slice(it.end);
  });
}

/**
 * Park or unpark a project. Only that entry's text changes. Parking an entry without a status
 * appends `"status": "parked"`; setting `active` removes the status member (absent = active),
 * so a park/unpark round trip is byte-identical. Setting the status it already has is a no-op
 * (`changed: false`, file untouched).
 * @param {{registryPath: string, name: string, status: "active"|"parked", expectVersion?: string, lockTimeoutMs?: number}} opts
 * @returns {{ version: string, changed: boolean }}
 */
export function setRegistryStatus(opts) {
  assertOptions(opts, ["registryPath", "name", "status"], ["expectVersion", "lockTimeoutMs"]);
  assertName(opts.name);
  if (!STATUSES.has(opts.status)) {
    throw new RegistryValidationError(`status must be one of ${[...STATUSES].join(", ")}.`, { errors: ["bad status"] });
  }
  return mutateRegistry(opts, "registry-status", (text, doc, tree) => {
    const idx = findEntry(doc, opts.name);
    if (idx === -1) throw new RegistryNotFoundError(`No project named "${opts.name}" in the registry.`, { name: opts.name });
    const current = doc.projects[idx].status ?? "active";
    if (current === opts.status) return null;
    const node = memberOf(tree, "projects").value.items[idx];
    const statusMembers = node.members.filter((m) => m.key === "status");

    if (opts.status === "parked") {
      if (statusMembers.length) {
        const v = statusMembers[statusMembers.length - 1].value;
        return text.slice(0, v.start) + JSON.stringify("parked") + text.slice(v.end);
      }
      const members = node.members;
      if (!members.length) return null; // unreachable: a valid entry has path or registry
      const lastMember = members[members.length - 1];
      // Match the entry's own layout: one-line entries get `, "status": …`, multi-line
      // entries get a new line indented like the member before it.
      const lineStart = text.lastIndexOf("\n", lastMember.keyStart) + 1;
      const multiLine = text.slice(node.start, node.end).includes("\n") && lineStart > node.start;
      const glue = multiLine ? ",\n" + text.slice(lineStart, lastMember.keyStart) : ", ";
      const at = lastMember.value.end;
      return text.slice(0, at) + glue + '"status": "parked"' + text.slice(at);
    }

    // active: drop every status member (absent = active), last first so spans stay valid.
    let out = text;
    const members = node.members;
    for (let k = members.length - 1; k >= 0; k--) {
      if (members[k].key !== "status") continue;
      const m = members[k];
      if (k > 0) out = out.slice(0, members[k - 1].value.end) + out.slice(m.value.end);
      else if (members.length > 1) out = out.slice(0, m.keyStart) + out.slice(members[1].keyStart);
      else out = out.slice(0, node.start + 1) + out.slice(node.end - 1);
    }
    return out;
  });
}
