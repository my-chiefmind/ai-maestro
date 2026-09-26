#!/usr/bin/env node
/** Thin CLI facade over the public, locked spec API. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  listSpecs, readSpec, writeSpec,
  SpecInputError, SpecNotFoundError, SpecConflictError, SpecLockError,
} from "./spec-api.mjs";

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["board", "file", "expect-version", "json"]);

function usage(exitCode = 0) {
  process.stdout.write(`
  maestro spec — list, read, and safely write board specs

    maestro spec list [--board <path>] [--json]
    maestro spec read <id> [--board <path>] [--json]
    maestro spec write <id> --file <path|-> --expect-version <token> [--board <path>] [--json]

  --file - reads the exact spec body from stdin. Writes always require compare-and-swap;
  use sha256:absent to create a spec only when it does not already exist.

  Exit 2 means the spec moved or the board lock was busy. Exit 1 means the request was
  invalid, the spec was missing, or an unexpected read/write error occurred.

`);
  process.exit(exitCode);
}

function parse() {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") usage(argv.length ? 0 : 1);
  const op = argv[0];
  if (!["list", "read", "write"].includes(op)) failInput(`Unknown spec operation "${op}".`);
  const positional = [];
  const flags = new Map();
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    if (!KNOWN_FLAGS.has(name)) failInput(`Unknown option --${name}.`);
    if (flags.has(name)) failInput(`Option --${name} may only be supplied once.`);
    if (name === "json") { flags.set(name, true); continue; }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) failInput(`Option --${name} requires a value.`);
    flags.set(name, next); i += 1;
  }
  const allowed = op === "write"
    ? new Set(["board", "file", "expect-version", "json"])
    : new Set(["board", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) failInput(`Option --${name} is not valid for spec ${op}.`, flags.has("json"));
  if (op === "list" && positional.length !== 0) failInput("spec list does not accept an id or extra arguments.", flags.has("json"));
  if (op !== "list" && positional.length !== 1) failInput(`spec ${op} requires exactly one spec id.`, flags.has("json"));
  if (op === "write") {
    if (!flags.has("file")) failInput("spec write requires --file <path|->.", flags.has("json"));
    if (!flags.has("expect-version")) failInput("spec write requires --expect-version <token>.", flags.has("json"));
  }
  return { op, id: positional[0], flags, json: flags.has("json") };
}

function sanitizedHolder(holder) {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return null;
  const safe = {};
  if (Number.isInteger(holder.pid) && holder.pid >= 0) safe.pid = holder.pid;
  if (typeof holder.at === "string" && !Number.isNaN(Date.parse(holder.at)) &&
      new Date(holder.at).toISOString() === holder.at) safe.at = holder.at;
  if (typeof holder.op === "string" && /^[A-Za-z0-9_-]+$/.test(holder.op)) safe.op = holder.op;
  return Object.keys(safe).length ? safe : null;
}

function errorPayload(error, exitCode) {
  const payload = { ok: false, error: error.message, code: exitCode, errorCode: error.code };
  if (error instanceof SpecConflictError) {
    payload.id = error.id; payload.expected = error.expected; payload.actual = error.actual;
  } else if (error instanceof SpecLockError) {
    payload.timeoutMs = error.timeoutMs; payload.holder = sanitizedHolder(error.holder);
  }
  return payload;
}

function failInput(message, json = argv.includes("--json")) {
  emitError(new SpecInputError(message), 1, json);
}

function emitError(error, exitCode, json) {
  const known = error instanceof SpecInputError || error instanceof SpecNotFoundError ||
    error instanceof SpecConflictError || error instanceof SpecLockError;
  const safe = known ? error : Object.assign(new Error("Spec command failed."), { code: "ESPECINTERNAL" });
  if (json) process.stdout.write(`${JSON.stringify(errorPayload(safe, exitCode))}\n`);
  else process.stderr.write(`\n  ✗ ${safe.message}\n\n`);
  process.exit(exitCode);
}

let parsed;
try { parsed = parse(); }
catch (error) { emitError(error, 1, argv.includes("--json")); }

const boardPath = resolve(parsed.flags.get("board") ?? "board/data.json");
try {
  if (parsed.op === "list") {
    const specs = listSpecs({ boardPath });
    if (parsed.json) process.stdout.write(`${JSON.stringify({ ok: true, specs })}\n`);
    else if (specs.length) process.stdout.write(`${specs.map(({ id, version }) => `${id}\t${version}`).join("\n")}\n`);
  } else if (parsed.op === "read") {
    const result = readSpec({ boardPath, id: parsed.id });
    if (parsed.json) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else process.stdout.write(result.content);
  } else {
    let content;
    try { content = readFileSync(parsed.flags.get("file") === "-" ? 0 : resolve(parsed.flags.get("file")), "utf8"); }
    catch { throw new SpecInputError("Could not read spec content file."); }
    const result = writeSpec({ boardPath, id: parsed.id, content, expectVersion: parsed.flags.get("expect-version") });
    if (parsed.json) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else process.stdout.write(`  ✓ ${result.id} written (${result.version})\n`);
  }
} catch (error) {
  emitError(error, error instanceof SpecConflictError || error instanceof SpecLockError ? 2 : 1, parsed.json);
}
