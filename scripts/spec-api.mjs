/** Targeted, versioned access to direct board/specs/<id>.md children. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { boardVersion, withBoardLock, writeAtomic } from "./board-io.mjs";
import { BoardLockError } from "./board-errors.mjs";

class SpecError extends Error {
  constructor(name, code, message, detail = {}) {
    super(message);
    this.name = name;
    this.code = code;
    Object.assign(this, detail);
  }
}
export class SpecInputError extends SpecError {
  constructor(message, detail) { super("SpecInputError", "ESPECINPUT", message, detail); }
}
export class SpecNotFoundError extends SpecError {
  constructor(message, detail) { super("SpecNotFoundError", "ESPECNOTFOUND", message, detail); }
}
export class SpecConflictError extends SpecError {
  constructor(message, detail) { super("SpecConflictError", "ESPECCONFLICT", message, detail); }
}
export class SpecLockError extends SpecError {
  constructor(message, detail) { super("SpecLockError", "ESPECLOCK", message, detail); }
}

export const ABSENT_SPEC_VERSION = "sha256:absent";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function paths(options, { requireId = true } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new SpecInputError("Options must be an object.");
  const allowed = requireId
    ? ["boardPath", "id", "content", "expectVersion", "lockOptions"]
    : ["boardPath", "lockOptions"];
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new SpecInputError(`Unknown spec option(s): ${unknown.join(", ")}.`);
  const { boardPath } = options;
  if (typeof boardPath !== "string" || !boardPath.trim()) throw new SpecInputError("boardPath must be a board directory or data.json path.");
  const abs = resolve(boardPath);
  const boardDir = abs.endsWith(".json") ? dirname(abs) : abs;
  const specs = join(boardDir, "specs");
  if (!requireId) return { boardDir, specs };
  const { id } = options;
  if (!safeId(id)) throw new SpecInputError("Spec id must be a direct, safe filename stem.", { id });
  return { boardDir, specs, path: join(specs, `${id}.md`) };
}

function safeId(id) {
  return typeof id === "string" && ID.test(id) && id !== "." && id !== ".." && !id.includes("..");
}

function assertSafe({ boardDir, specs, path }) {
  if (!existsSync(boardDir) || !lstatSync(boardDir).isDirectory()) throw new SpecInputError("Board directory is missing or invalid.", { path: boardDir });
  if (existsSync(specs) || isDanglingLink(specs)) {
    if (lstatSync(specs).isSymbolicLink() || !lstatSync(specs).isDirectory() || dirname(realpathSync(specs)) !== realpathSync(boardDir)) {
      throw new SpecInputError("Specs directory must be a real direct child of the board.", { path: specs });
    }
  }
  if (path && (existsSync(path) || isDanglingLink(path))) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new SpecInputError("Spec path must be a regular file.", { path });
  }
}

function isDanglingLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function locked(p, operation, options, fn) {
  // Validate before creating .board.lock so a missing board is a typed input error. Repeat
  // inside the lock because a path can be replaced between the two checks.
  try { assertSafe(p); return withBoardLock(p.boardDir, () => { assertSafe(p); return fn(); }, { op: operation, ...(options.lockOptions ?? {}) }); }
  catch (error) {
    if (error instanceof BoardLockError) {
      const holder = error.holder ?? null;
      const timeoutMs = error.timeoutMs;
      throw new SpecLockError(
        `Timed out after ${timeoutMs}ms waiting for the spec lock.`,
        { holder, timeoutMs },
      );
    }
    if (error?.code === "ENOENT") throw new SpecInputError("Board or spec path disappeared during the operation.", { path: p.boardDir });
    throw error;
  }
}

export function getSpecVersion(options) {
  const p = paths(options);
  if ("content" in options || "expectVersion" in options) throw new SpecInputError("Read options cannot include write fields.");
  return locked(p, "spec-version", options, () => boardVersion(p.path));
}

/**
 * Return a coherent snapshot of safe direct specs. Foreign files are intentionally ignored:
 * discovery never recurses, follows links, or turns an arbitrary directory entry into a path
 * supplied by a caller. The specs root itself must still be the real board/specs directory.
 */
export function listSpecs(options) {
  const p = paths(options, { requireId: false });
  return locked(p, "list-specs", options, () => {
    if (!existsSync(p.specs)) return [];
    const result = [];
    for (const name of readdirSync(p.specs)) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (!safeId(id) || `${id}.md` !== name) continue;
      const path = join(p.specs, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        result.push({ id, version: boardVersion(path) });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export function readSpec(options) {
  const p = paths(options);
  if ("content" in options || "expectVersion" in options) throw new SpecInputError("Read options cannot include write fields.");
  return locked(p, "read-spec", options, () => {
    if (!existsSync(p.path)) throw new SpecNotFoundError(`Spec ${options.id} does not exist.`, { id: options.id, path: p.path });
    return { id: options.id, content: readFileSync(p.path, "utf8"), version: boardVersion(p.path) };
  });
}

export function writeSpec(options) {
  const p = paths(options);
  if (typeof options.content !== "string") throw new SpecInputError("Spec content must be a string.", { id: options.id });
  if (typeof options.expectVersion !== "string" || !options.expectVersion) throw new SpecInputError("expectVersion is required, including when creating a spec.", { id: options.id });
  return locked(p, "write-spec", options, () => {
    const actual = boardVersion(p.path);
    if (actual !== options.expectVersion) throw new SpecConflictError(`Spec ${options.id} changed since it was read.`, { id: options.id, expected: options.expectVersion, actual, path: p.path });
    if (!existsSync(p.specs)) mkdirSync(p.specs);
    writeAtomic(p.path, options.content);
    return { id: options.id, version: boardVersion(p.path) };
  });
}
