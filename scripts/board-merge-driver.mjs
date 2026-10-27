#!/usr/bin/env node
/**
 * Git merge driver for board/data.json and board/archive.json (opt-in).
 *
 * Nearly every PR edits the board, and a line merge conflicts whenever two lanes add or close
 * tickets next to each other. This merges the board as data: epics and tickets by `id`, every
 * other value by key, so two PRs that change different tickets (or different fields of one
 * ticket) merge cleanly.
 *
 *   node <kit>/scripts/board-merge-driver.mjs %O %A %B     (base, ours — rewritten in place, theirs)
 *
 * A value both sides changed differently is a real conflict: the driver then falls back to
 * git's own line merge with conflict markers, names the place on stderr and exits 1.
 *
 * Registering it (once per clone — git keeps drivers in .git/config, never in a commit):
 *
 *   maestro merge-driver install [--board <dir>]    git config + .gitattributes lines
 *   maestro merge-driver status  [--board <dir>]
 *   maestro merge-driver uninstall [--board <dir>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

class Conflict extends Error {}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isIdList = (v) => Array.isArray(v) && v.every((x) => isObject(x) && typeof x.id === "string")
  && new Set(v.map((x) => x.id)).size === v.length;

/** Three-way merge of one value; `undefined` means absent (deleted, or never there). */
export function mergeValue(base, ours, theirs, where = "board") {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (isObject(ours) && isObject(theirs)) return mergeObject(isObject(base) ? base : {}, ours, theirs, where);
  if (isIdList(ours) && isIdList(theirs) && (base === undefined || isIdList(base))) {
    return mergeIdList(base ?? [], ours, theirs, where);
  }
  throw new Conflict(where);
}

function mergeObject(base, ours, theirs, where) {
  const out = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const v = mergeValue(base[key], ours[key], theirs[key], `${where}.${key}`);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Items keep our order; items only they added follow, in their order. */
function mergeIdList(base, ours, theirs, where) {
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const b = byId(base), o = byId(ours), t = byId(theirs);
  const ids = [...o.keys(), ...[...t.keys()].filter((id) => !o.has(id))];
  const out = [];
  for (const id of ids) {
    const v = mergeValue(b.get(id), o.get(id), t.get(id), `${where}[${id}]`);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Merge three board files as git hands them to a driver. Returns true on a clean merge (ours
 * rewritten), false after falling back to a line merge with conflict markers.
 */
export function mergeBoardFiles(basePath, oursPath, theirsPath, { log = (m) => process.stderr.write(m) } = {}) {
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  try {
    const merged = mergeValue(read(basePath), read(oursPath), read(theirsPath));
    writeFileSync(oursPath, JSON.stringify(merged, null, 2) + "\n");
    return true;
  } catch (error) {
    const why = error instanceof Conflict ? `${error.message} changed on both sides` : `not mergeable as JSON (${error.message})`;
    log(`board merge: ${why}; falling back to a line merge.\n`);
    spawnSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], { stdio: "inherit" });
    return false;
  }
}

// ── Registration ──────────────────────────────────────────────────────────────────────────

export const DRIVER_NAME = "maestro-board";
const BOARD_FILES = ["data.json", "archive.json"];
const posix = (p) => p.split(sep).join("/");

function gitOut(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Where things are, for a repository at `cwd` and a board directory (default maestro/board, then board). */
export function mergeDriverPaths({ cwd = process.cwd(), board = null, kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  const repoRoot = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) throw new Error(`${cwd} is not inside a git repository.`);
  const boardDir = board
    ? resolve(cwd, board)
    : [join(repoRoot, "maestro", "board"), join(repoRoot, "board")].find((d) => existsSync(join(d, "data.json")));
  if (!boardDir || !existsSync(join(boardDir, "data.json"))) throw new Error("No board found (maestro/board/data.json or board/data.json). Pass --board <dir>.");
  const boardRel = posix(relative(repoRoot, boardDir));
  if (boardRel.startsWith("..") || isAbsolute(boardRel)) throw new Error(`The board ${boardDir} is outside the repository ${repoRoot}.`);
  const driverRel = posix(relative(repoRoot, join(kitRoot, "scripts", "board-merge-driver.mjs")));
  if (driverRel.startsWith("..") || isAbsolute(driverRel)) {
    throw new Error(`The kit at ${kitRoot} is outside the repository, so every clone could not run it. Use the kit vendored into the repository (maestro/bin/cli.mjs merge-driver install).`);
  }
  const patterns = BOARD_FILES.map((f) => `${boardRel ? `${boardRel}/` : ""}${f}`);
  return { repoRoot, boardRel, driverRel, patterns, command: `node ${driverRel} %O %A %B` };
}

const attributeLine = (pattern) => `${pattern} merge=${DRIVER_NAME}`;

export function mergeDriverStatus(opts = {}) {
  const p = mergeDriverPaths(opts);
  const driver = gitOut(p.repoRoot, ["config", "--local", "--get", `merge.${DRIVER_NAME}.driver`]);
  const attrsPath = join(p.repoRoot, ".gitattributes");
  const attrs = existsSync(attrsPath) ? readFileSync(attrsPath, "utf8").split(/\r?\n/) : [];
  const missing = p.patterns.filter((pat) => !attrs.includes(attributeLine(pat)));
  return { ...p, driver, configured: driver === p.command, attributes: missing.length === 0, missingAttributes: missing };
}

export function installMergeDriver(opts = {}) {
  const p = mergeDriverPaths(opts);
  const set = (key, value) => {
    const r = spawnSync("git", ["config", "--local", key, value], { cwd: p.repoRoot, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git config ${key} failed: ${r.stderr.trim()}`);
  };
  set(`merge.${DRIVER_NAME}.name`, "maestro board: merge by ticket id");
  set(`merge.${DRIVER_NAME}.driver`, p.command);
  const attrsPath = join(p.repoRoot, ".gitattributes");
  const text = existsSync(attrsPath) ? readFileSync(attrsPath, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const add = p.patterns.map(attributeLine).filter((l) => !lines.includes(l));
  if (add.length) {
    const header = "# Merged by ticket id, not by line (maestro merge-driver install).";
    const block = [...(lines.includes(header) ? [] : [header]), ...add].join("\n") + "\n";
    writeFileSync(attrsPath, text + (text && !text.endsWith("\n") ? "\n" : "") + block);
  }
  return { ...mergeDriverStatus(opts), addedAttributes: add };
}

export function uninstallMergeDriver(opts = {}) {
  const p = mergeDriverPaths(opts);
  spawnSync("git", ["config", "--local", "--remove-section", `merge.${DRIVER_NAME}`], { cwd: p.repoRoot, encoding: "utf8" });
  const attrsPath = join(p.repoRoot, ".gitattributes");
  if (existsSync(attrsPath)) {
    const drop = new Set([...p.patterns.map(attributeLine), "# Merged by ticket id, not by line (maestro merge-driver install)."]);
    const text = readFileSync(attrsPath, "utf8");
    const kept = text.split("\n").filter((l) => !drop.has(l.replace(/\r$/, "")));
    writeFileSync(attrsPath, kept.join("\n"));
  }
  return mergeDriverStatus(opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const op = argv[0];
  if (["install", "uninstall", "status"].includes(op)) {
    const i = argv.indexOf("--board");
    const board = i !== -1 ? argv[i + 1] : null;
    const json = argv.includes("--json");
    try {
      const r = op === "install" ? installMergeDriver({ board }) : op === "uninstall" ? uninstallMergeDriver({ board }) : mergeDriverStatus({ board });
      if (json) process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      else if (op === "uninstall") process.stdout.write(`\n  ✓ Board merge driver removed from ${r.repoRoot} (git config and .gitattributes).\n\n`);
      else process.stdout.write(`
  Board merge driver (${DRIVER_NAME})
  git config:     ${r.configured ? `✓ ${r.command}` : r.driver ? `✗ points elsewhere: ${r.driver}` : "✗ not registered in this clone"}
  .gitattributes: ${r.attributes ? `✓ ${r.patterns.join(", ")}` : `✗ missing: ${r.missingAttributes.join(", ")}`}
${op === "install" ? "\n  Commit .gitattributes. Every other clone runs 'maestro merge-driver install' once: git\n  never stores a driver command in the repository.\n" : ""}
`);
      process.exit(op === "status" && !(r.configured && r.attributes) ? 1 : 0);
    } catch (error) {
      if (json) process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
      else process.stderr.write(`\n  ✗ ${error.message}\n\n`);
      process.exit(2);
    }
  }
  if (argv.length !== 3 || ["help", "--help", "-h"].includes(op)) {
    process.stdout.write(`
  maestro merge-driver — merge board/data.json and archive.json by ticket id (opt-in)

    maestro merge-driver install   [--board <dir>] [--json]   register in this clone + .gitattributes
    maestro merge-driver status    [--board <dir>] [--json]   exit 1 when not fully registered
    maestro merge-driver uninstall [--board <dir>] [--json]

  Git runs the driver itself as: node <kit>/scripts/board-merge-driver.mjs %O %A %B
`);
    process.exit(!argv.length || ["help", "--help", "-h"].includes(op) ? 0 : 2);
  }
  const [basePath, oursPath, theirsPath] = argv;
  process.exit(mergeBoardFiles(basePath, oursPath, theirsPath) ? 0 : 1);
}
