#!/usr/bin/env node
/**
 * lane-plan.mjs — `maestro lanes`: what can safely run in parallel, and why.
 *
 * Read-only. It answers the question an orchestrator must answer before dispatching more than
 * one ticket at a time, and it answers it the same way every caller sees it, because they all
 * read scripts/lane-core.mjs.
 *
 *   maestro lanes plan            the schedule: which tickets share a lane, and why
 *   maestro lanes next            just the tickets startable right now (what to dispatch)
 *   maestro lanes check <a> <b>   would these two conflict?
 *
 * Common flags: --board <path> --config <path> --max <n> --json
 *
 * Exit 0 always for `plan`/`next` — this is a report, not a gate. `check` exits 1 when the two
 * tickets conflict, so it is usable in a script.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { eligibleTickets } from "./board-core.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import {
  assignLanes, startableNow, conflictReason, parallelismLostToVagueness,
  laneCount, serialFiles, touchesOf, MAX_LANES,
} from "./lane-core.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");

const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
function die(msg, code = 1) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  else process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code);
}

function usage() {
  out(`
  maestro lanes — what can safely run in parallel, and why

    maestro lanes plan            the full schedule: lanes, queues, and the reason for each
    maestro lanes next            only the tickets startable right now
    maestro lanes check <a> <b>   would these two tickets conflict? (exit 1 if they would)

  A lane is a worktree that runs a QUEUE of tickets one at a time, landing each before
  starting the next. Tickets in one lane cannot conflict with each other; assignment makes
  sure tickets in DIFFERENT lanes cannot either.

  Two tickets may run in parallel only when nothing suggests they touch the same files:
  no dependency between them, neither touching a serial-only file (migrations, lockfiles),
  and either both declaring disjoint \`touches\` globs or being in different epics AND areas.

  Flags: --board <path>  --config <path>  --max <n>  --json
  Pool size comes from config.orchestration.maxWorktrees (default 3, hard ceiling ${MAX_LANES}).
`);
  process.exit(argv.length ? 1 : 0);
}

const op = argv[0];
if (!op || op === "--help" || op === "-h" || op === "help") usage();
if (!["plan", "next", "check"].includes(op)) die(`Unknown op "${op}". Known: plan, next, check.`);

const boardPath = resolve(flag("board", "board/data.json"));
if (!existsSync(boardPath)) die(`Board file not found: ${boardPath}. Pass --board <path>.`);

const readJSON = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
};

const board = readJSON(boardPath, null);
if (!board) die(`${boardPath} is not valid JSON.`);
const archive = readJSON(join(dirname(boardPath), "archive.json"), { epics: [], tickets: [] });

const configPath = flag("config") ?? join(dirname(boardPath), "..", "config.json");
const config = readJSON(configPath, null);
// --max is an override for trying a different pool size without editing config.
const effectiveConfig = flag("max")
  ? { ...(config ?? {}), orchestration: { ...(config?.orchestration ?? {}), maxWorktrees: Number(flag("max")) } }
  : config;

// The plan, so lanes only ever schedule work the scope gate would actually let run. Scheduling
// a ticket the orchestrator will refuse is worse than not scheduling it: it occupies a lane.
let plan = null;
try { plan = readPlanForBoard(boardPath); } catch { plan = null; }

const ready = eligibleTickets(board, archive.tickets ?? [], { plan });

// ── check ───────────────────────────────────────────────────────────────────────
if (op === "check") {
  const [, aId, bId] = argv;
  if (!aId || !bId || aId.startsWith("--") || bId.startsWith("--")) die("check needs two ticket ids: maestro lanes check T-001 T-002");
  const all = board.tickets ?? [];
  const a = all.find((t) => t.id === aId);
  const b = all.find((t) => t.id === bId);
  if (!a) die(`${aId} is not on the board.`);
  if (!b) die(`${bId} is not on the board.`);

  const reason = conflictReason(a, b, effectiveConfig);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, parallel: reason === null, reason }) + "\n");
    process.exit(reason === null ? 0 : 1);
  }
  out("");
  if (reason === null) {
    out(`  ✓ ${aId} and ${bId} can run in parallel.`);
    out(`    ${describeScope(a)}`);
    out(`    ${describeScope(b)}`);
    out("");
    process.exit(0);
  }
  out(`  ✗ ${aId} and ${bId} must share a lane — ${reason}.`);
  if (!touchesOf(a).length || !touchesOf(b).length) {
    out(`    Declare what each touches to unlock parallelism:`);
    out(`      maestro ticket retrace ... is for the plan; for file scope, set \`touches\` on the ticket.`);
  }
  out("");
  process.exit(1);
}

// ── plan / next ─────────────────────────────────────────────────────────────────
const schedule = assignLanes(ready, effectiveConfig);
const startable = startableNow(ready, effectiveConfig);
const vague = parallelismLostToVagueness(ready, effectiveConfig);

if (op === "next") {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: true,
      start: startable.start.map((t) => t.id),
      exclusive: startable.exclusive?.id ?? null,
      waiting: startable.waiting.map((t) => t.id),
      max: schedule.max,
    }) + "\n");
    process.exit(0);
  }
  out("");
  if (!startable.start.length) out("  Nothing startable right now.");
  else out(`  Start now (${startable.start.length}): ${startable.start.map((t) => t.id).join(", ")}`);
  if (startable.exclusive) out(`  ⚠ ${startable.exclusive.id} runs ALONE — the pool must be empty first.`);
  if (startable.waiting.length) out(`  Waiting for the pool to drain: ${startable.waiting.map((t) => t.id).join(", ")}`);
  out("");
  process.exit(0);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    ok: true,
    max: schedule.max,
    lanes: schedule.lanes.map((l) => ({
      index: l.index, exclusive: l.exclusive, reason: l.reason,
      tickets: l.tickets.map((t) => ({ id: t.id, name: t.name, area: t.area, epicId: t.epicId, touches: touchesOf(t) })),
    })),
    startNow: startable.start.map((t) => t.id),
    waiting: startable.waiting.map((t) => t.id),
    parallelismLost: vague,
  }) + "\n");
  process.exit(0);
}

out("");
if (!ready.length) {
  out("  Nothing is eligible to run, so there is nothing to schedule.");
  out("");
  process.exit(0);
}
out(`  ${ready.length} eligible ticket(s) across ${schedule.lanes.length} lane(s) — pool cap ${schedule.max}.`);
out("");
for (const l of schedule.lanes) {
  const head = l.tickets[0];
  const tag = l.exclusive ? "  [runs alone]" : "";
  out(`  Lane ${l.index}${tag}`);
  for (const [i, t] of l.tickets.entries()) {
    const mark = i === 0 ? (l.exclusive && startable.start[0]?.id !== t.id ? "⏸" : "▶") : " ";
    const scope = touchesOf(t).length ? touchesOf(t).join(", ") : `${t.area || "no area"}${t.epicId ? ` / ${t.epicId}` : ""}`;
    out(`   ${mark} ${String(t.id).padEnd(8)} ${String(t.name || "").slice(0, 42).padEnd(44)} ${scope}`);
  }
  if (l.reason) out(`     ${l.reason}`);
  void head;
  out("");
}
out(`  Starting now: ${startable.start.map((t) => t.id).join(", ") || "nothing"}`);
if (startable.waiting.length) {
  out(`  Held until the pool drains: ${startable.waiting.map((t) => t.id).join(", ")}`);
}
if (vague.length) {
  out("");
  out(`  ${vague.length} pair(s) forced to share a lane only because their file scope is undeclared:`);
  for (const v of vague.slice(0, 8)) out(`   · ${v.a} + ${v.b} — ${v.reason}`);
  out(`  Add \`touches\` globs to those tickets and they can run in parallel.`);
}
const serial = serialFiles(effectiveConfig).length;
out("");
out(`  ${laneCount(effectiveConfig)} lane(s) configured; ${serial} serial-only file pattern(s) in force.`);
out("");

/** @param {any} t */
function describeScope(t) {
  const touches = touchesOf(t);
  return touches.length
    ? `${t.id} touches ${touches.join(", ")}`
    : `${t.id} declares no \`touches\` (area ${t.area || "none"}, epic ${t.epicId || "none"})`;
}
