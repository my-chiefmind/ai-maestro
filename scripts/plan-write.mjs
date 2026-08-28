#!/usr/bin/env node
/**
 * plan-write.mjs — `maestro plan <op>`: the only supported way to change board/plan.json.
 *
 * Same contract as `maestro ticket`: every operation is DECLARATIVE ("add this requirement",
 * not "here is the new plan"), applied to the file as it exists at write time, inside the board
 * lock, validated, and written atomically — with plan.md re-rendered in the same breath.
 *
 * Usage:
 *   maestro plan init                          create an empty plan (and its mirror)
 *   maestro plan show [--section <key>]        print the plan
 *   maestro plan status                        completeness %, per-section, open gaps
 *   maestro plan questions                     the next unanswered questions (drives /plan-update)
 *   maestro plan coverage                      plan items vs the tickets working them
 *   maestro plan set-goal --text <t> [--metric <m>]...
 *   maestro plan scope [--in <t>]... [--out <t>]...
 *   maestro plan add <section> --text <t> [--verify|--budget|--actor|--target|--mitigation|--notes <v>]
 *   maestro plan edit <ID> [--text|--verify|--budget|--actor|--target|--mitigation|--notes <v>]
 *   maestro plan remove <ID>
 *   maestro plan gap-add --text <t> --need required|optional [--from <skill>]
 *   maestro plan gap-set <G-ID> --status open|accepted|declined [--resolved-as <ID>]
 *   maestro plan render                        rewrite plan.md from plan.json
 *   maestro plan version                       the plan's content version
 *
 * Common flags: --board <path> --plan <path> --expect-version <v> --json --dry-run
 *
 * Exit codes: 0 = written (or no-op), 1 = the request was wrong (do not retry), 2 = contended —
 * the plan moved or the lock was busy, so re-run the same command.
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, join, dirname } from "path";
import {
  PLAN_SECTIONS, SECTION_BY_KEY, SECTION_KEYS, QUESTION_SECTIONS, GAP_NEEDS, GAP_STATUSES,
  planCompleteness, planCoverage, planItems, planIsGating, enforceableItems, nextId, nextOutId,
  sectionForId, validatePlan, isPlaceholder, TRACEABLE_PREFIXES,
  initiativeMap, initiativeProgress, projectWideProgress, normalisePlan, OWNED_SECTIONS,
} from "./plan-core.mjs";
import { planPaths, readPlan, planVersion, mutatePlan } from "./plan-io.mjs";
import { BoardConflictError, BoardLockError } from "./board-io.mjs";
import { epicOwnershipVerdict, ownershipVerdict, initiativeModeActive } from "./board-core.mjs";

const argv = process.argv.slice(2);
const OPS = new Set([
  "init", "show", "status", "questions", "coverage", "gate", "check",
  "set-goal", "scope", "add", "edit", "remove",
  "initiative-add", "initiative-edit", "initiative-remove",
  "gap-add", "gap-set", "render", "version",
]);

/** First value of a flag. */
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
/** EVERY value of a repeatable flag — `--metric a --metric b` is the natural way to give a list. */
const flagAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] != null && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
  }
  return out;
};
const has = (name) => argv.includes(`--${name}`);

const JSON_OUT = has("json");
const DRY_RUN = has("dry-run");

function die(msg, code = 1) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg, code }) + "\n");
  else process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code);
}

function ok(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  else if (human) process.stdout.write(`  ✓ ${human}\n`);
  process.exit(0);
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function usage() {
  process.stdout.write(`
  maestro plan — the project plan every epic and ticket is scoped against

    maestro plan status                     completeness %, what's thin, open gaps
    maestro plan questions                  the next unanswered questions
    maestro plan show [--section <key>]     print the plan
    maestro plan coverage                   plan items vs the tickets working them
    maestro plan gate --json                the scope boundary, for machine callers
    maestro plan check [--traces FR-1,NFR-2] run the plan's enforce commands (CI-friendly)

    maestro plan init                       create an empty plan
    maestro plan set-goal --text <t> [--metric <m>]...
    maestro plan scope [--in <t>]... [--out <t>]...
    maestro plan add <section> --text <t> [field flags] [--initiative I-1]
    maestro plan edit <ID> [field flags] [--initiative I-2 | --clear-initiative]
    maestro plan remove <ID>
    maestro plan initiative-add    --name <t> --outcome <t> [--metric <m>]... [--in <t>]...
                                   [--out <t>]... [--depends-on I-n]...
    maestro plan initiative-edit <I-n> [same flags — list flags REPLACE, never append]
    maestro plan initiative-remove <I-n>   refused while anything still references it
    maestro plan gap-add --text <t> --need required|optional [--from <skill>]
    maestro plan gap-set <G-ID> --status open|accepted|declined [--resolved-as <ID>]
    maestro plan render                     rewrite plan.md from plan.json
    maestro plan version

  Sections: ${PLAN_SECTIONS.filter((s) => s.kind === "list").map((s) => s.key).join(", ")}
  Field flags: --text --verify --budget --enforce --actor --target --mitigation --notes
               --enforce <cmd> is a command that MUST exit 0 — a rule agents cannot violate,
               as opposed to --verify, which describes how a human would check it.
  Common:      --board --plan --expect-version --json --dry-run
  check:       --traces <ids>  narrow to one ticket's plan items
               --cwd <dir>     where enforce commands run (default: the repo root)

  Exit 2 means the plan moved or the lock was busy — re-read and retry. Exit 1 means the
  request itself was wrong; retrying will not help.

`);
  process.exit(argv.length ? 1 : 0);
}

// ── Paths ───────────────────────────────────────────────────────────────────────
const boardArg = flag("board", "board/data.json");
const paths = planPaths(boardArg);
const PLAN_PATH = resolve(flag("plan") ?? paths.plan);
const DATA_PATH = resolve(paths.data);

/**
 * The repo root — where an `enforce` command runs, and the only sane cwd for one: these are
 * project-level checks ("no plaintext write reaches the DB"), not board-level ones.
 *
 * Resolved exactly as render/sync.mjs resolves its output dir, so `enforce` runs where
 * `.claude/` lives and where a developer would run the same command by hand. `--cwd` overrides
 * for layouts the default gets wrong.
 */
function repoRoot() {
  const projectDir = resolve(paths.boardDir, "..");
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir, "config.json"), "utf8"));
    if (cfg?.outDir) return resolve(projectDir, cfg.outDir);
  } catch { /* no config, or not ours to read */ }
  return projectDir;
}

/** Project name for the rendered plan.md — from config.json beside the board dir, if any. */
function projectName() {
  for (const p of [join(paths.boardDir, "..", "config.json"), join(paths.boardDir, "config.json")]) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (cfg?.project?.name) return String(cfg.project.name);
    } catch { /* no config, or not ours to read */ }
  }
  return "Project";
}

// ── Per-item field flags ────────────────────────────────────────────────────────
const ITEM_FIELDS = ["text", "verify", "budget", "enforce", "actor", "target", "mitigation", "notes"];

/** Collect the field flags the caller actually passed (absent ≠ empty — absent leaves it alone). */
function itemPatch(section) {
  const patch = {};
  for (const f of ITEM_FIELDS) {
    const v = flag(f);
    if (v == null) continue;
    if (f !== "text" && f !== "notes" && section && !(section.fields ?? []).includes(f)) {
      die(`--${f} does not apply to "${section.key}" (it accepts: ${["text", ...(section.fields ?? []), "notes"].join(", ")}).`);
    }
    patch[f] = v;
  }
  return patch;
}


/**
 * The board beside this plan, or null. Read-only, and a missing or unreadable board is never an
 * error: writing a plan must not require a board to exist.
 */
function boardForPreflight() {
  if (!existsSync(DATA_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    let archive = { epics: [], tickets: [] };
    const archivePath = join(dirname(DATA_PATH), "archive.json");
    if (existsSync(archivePath)) {
      try { archive = JSON.parse(readFileSync(archivePath, "utf8")); } catch { /* keep the empty one */ }
    }
    return { data, archivedEpics: archive.epics ?? [], archivedTickets: archive.tickets ?? [] };
  } catch {
    return null; // an unreadable board is the board validator's problem, not this op's
  }
}

/**
 * REVERSE PREFLIGHT: refuse a plan write that would invalidate the board.
 *
 * plan.json and data.json are separate files behind separate locks with no cross-file
 * transaction, so `maestro plan edit FR-3 --initiative I-1` can succeed on its own terms and
 * leave a ticket in an I-2 epic tracing FR-3 — a board that is now invalid, and nothing caught
 * it. The board CLI already reads the plan for the forward direction (board-write.mjs); this is
 * the symmetric read.
 *
 * It is NOT atomic across the two files and does not pretend to be: it checks the board as it
 * is right now, and a concurrent board write could still race it. That is why the board's own
 * validator stays the backstop. This exists so the common case fails at the moment someone
 * makes the mistake, naming every id, rather than surfacing later as a refused ticket run.
 *
 * @param {any} nextPlan the plan as it WOULD be after this write
 * @param {string} subject what is being changed, for the message
 */
function assertBoardSurvives(nextPlan, subject) {
  const board = boardForPreflight();
  if (!board || !initiativeModeActive(nextPlan)) return;
  const { data, archivedEpics, archivedTickets } = board;
  const conflicts = [];
  for (const e of data.epics ?? []) {
    const v = epicOwnershipVerdict(e, nextPlan);
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(v.reason);
  }
  for (const e of archivedEpics) {
    const v = epicOwnershipVerdict(e, nextPlan);
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(`archive: ${v.reason}`);
  }
  for (const t of data.tickets ?? []) {
    const v = ownershipVerdict(t, { plan: nextPlan, data, archivedEpics });
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(v.reason);
  }
  // ARCHIVED TICKETS COUNT. A landed ticket's traces are not decoration — planCoverage reads
  // them, and initiativeProgress groups those rows by the ITEM's owner. So moving FR-1 to I-2
  // while an archived ticket delivered it under an I-1 epic silently re-attributes finished
  // work to an initiative that never did it, and the delivery percentages both initiatives
  // report are wrong from then on. There is no way to re-trace an archived ticket afterwards
  // either — archived work is history and has no editing op — so the only place this can be
  // caught is here, before the plan moves.
  //
  // The same live+archived epic index resolves them, because an archived ticket's epic is
  // usually archived too but does not have to be.
  for (const t of archivedTickets) {
    const v = ownershipVerdict(t, { plan: nextPlan, data, archivedEpics });
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(`archive: ${v.reason}`);
  }
  if (conflicts.length) {
    die(`Refusing to change ${subject} — ${conflicts.length} board reference(s) would break and ` +
        `nothing has been written:\n${conflicts.map((c) => `  • ${c}`).join("\n")}\n` +
        `Reassign or re-trace them first ('maestro ticket edit-epic' / 'maestro ticket retrace').`, 1);
  }
}

/** Every place an initiative id is referenced, across the plan and the board. */
function referencesToInitiative(plan, id) {
  const refs = [];
  for (const s of PLAN_SECTIONS) {
    if (s.kind !== "list") continue;
    for (const item of plan.sections[s.key] ?? []) {
      if (item.initiativeId === id) refs.push(`plan item ${item.id}`);
    }
  }
  for (const other of plan.sections.initiatives ?? []) {
    if ((other.depends_on ?? []).includes(id)) refs.push(`initiative ${other.id} depends_on it`);
  }
  const board = boardForPreflight();
  if (board) {
    for (const e of board.data.epics ?? []) if (e.initiativeId === id) refs.push(`epic ${e.id}`);
    for (const e of board.archivedEpics) if (e.initiativeId === id) refs.push(`archived epic ${e.id}`);
  }
  return refs;
}

/** The initiative flags an item op accepts: `--initiative I-1` or `--clear-initiative`. */
function initiativePatch(plan) {
  const id = flag("initiative");
  if (id != null && has("clear-initiative")) die("--initiative and --clear-initiative contradict each other.");
  if (id != null && !initiativeMap(plan).has(id)) {
    const known = [...initiativeMap(plan).keys()];
    die(`The plan does not define initiative ${id} (known: ${known.join(", ") || "none yet"}). ` +
        `Create it with 'maestro plan initiative-add --name … --outcome …'.`);
  }
  if (has("clear-initiative")) return { clear: true };
  return id == null ? null : { initiativeId: id };
}

function write(mutate, op) {
  if (DRY_RUN) {
    const before = readPlan(PLAN_PATH);
    const after = mutate(structuredClone(before));
    const { errors } = validatePlan(after);
    if (errors.length) die(`Would be invalid:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
    return { plan: after, version: planVersion(PLAN_PATH), changed: true, warnings: [], dryRun: true };
  }
  try {
    const r = mutatePlan({ planPath: PLAN_PATH, mutate, expectVersion: flag("expect-version"), projectName: projectName(), op });
    // Quality warnings never block a write — an incomplete plan must stay writable — but they
    // go to stderr rather than being swallowed, or a requirement with no verification method
    // sits there looking finished. --json callers get them via `maestro plan status`.
    if (!JSON_OUT) for (const w of r.warnings) process.stderr.write(`  ⚠ ${w}\n`);
    return r;
  } catch (e) {
    if (e instanceof BoardConflictError || e instanceof BoardLockError) die(e.message, 2);
    die(e.message, 1);
  }
}

// ── Read-only reports ───────────────────────────────────────────────────────────

function renderStatus(plan) {
  const c = planCompleteness(plan);
  if (JSON_OUT) return ok({ ...c, planPath: PLAN_PATH, version: planVersion(PLAN_PATH) });

  const bar = (pct) => {
    const n = Math.round(pct / 5);
    return `[${"█".repeat(n)}${"·".repeat(20 - n)}]`;
  };
  out("");
  out(`  Project plan — ${bar(c.percent)} ${c.percent}% complete`);
  out("");
  for (const s of c.sections) {
    // A filled tick only means something for sections that count toward the percentage. Gaps
    // and open questions being "filled" is not good news, so they never get one.
    const mark = !s.counts ? (s.count ? "·" : "○") : s.filled ? "✓" : "·";
    const count = s.count ? ` (${s.count})` : "";
    const note = s.detail ? `  ${s.detail}` : "";
    out(`   ${mark} ${s.label.padEnd(30)}${count.padEnd(6)}${note}`);
  }
  const board = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : { tickets: [] };
  const archPath0 = join(paths.boardDir, "archive.json");
  const archive0 = existsSync(archPath0) ? JSON.parse(readFileSync(archPath0, "utf8")) : { tickets: [] };
  const progress = initiativeProgress(plan, board.tickets ?? [], archive0.tickets ?? []);
  if (progress.length) {
    out("");
    out("  Initiatives — delivery is derived from the board, not declared here:");
    for (const p of progress) {
      out(`   ${p.id.padEnd(5)} ${p.name.slice(0, 28).padEnd(30)} ${String(p.percent).padStart(3)}% delivered  (${p.done}/${p.total})`);
    }
    const g = projectWideProgress(plan, board.tickets ?? [], archive0.tickets ?? []);
    if (g.total) out(`   ${"—".padEnd(5)} ${"Project-wide".padEnd(30)} ${String(g.percent).padStart(3)}% delivered  (${g.done}/${g.total})`);
  }
  if (c.requiredGaps.length) {
    out("");
    out(`  Required gaps — these hold the percentage down until accepted or declined:`);
    for (const g of c.requiredGaps) out(`   ⚠ ${g.id}  ${g.text}${g.from ? `  (${g.from})` : ""}`);
  }
  if (c.optionalGaps.length) {
    out("");
    out(`  Optional gaps — suggestions; they never affect the percentage:`);
    for (const g of c.optionalGaps) out(`   · ${g.id}  ${g.text}${g.from ? `  (${g.from})` : ""}`);
  }
  const { warnings } = validatePlan(plan);
  if (warnings.length) {
    out("");
    for (const w of warnings) out(`   ⚠ ${w}`);
  }
  out("");
  out(c.percent === 100 ? "  The plan is complete." : "  Run /plan-update to fill in the rest.");
  out("");
  process.exit(0);
}

/**
 * The questionnaire state /plan-update drives: which sections still need something, in order,
 * with the question to ask and what is already there. Emitting this as data rather than letting
 * the skill invent its own question order is what keeps every project's plan the same shape.
 */
function renderQuestions(plan) {
  const c = planCompleteness(plan);
  const byKey = new Map(c.sections.map((s) => [s.key, s]));
  const steps = QUESTION_SECTIONS.map((s) => {
    const st = byKey.get(s.key);
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      ask: s.ask,
      followUp: s.followUp ?? null,
      filled: st.filled,
      count: st.count,
      detail: st.detail,
      // "Thin" is the useful signal, not just empty: a section can be filled and still be
      // missing the thing that makes it usable (a verify method, an out-of-scope list).
      needsWork: !st.filled || !!st.detail,
      current: currentFor(plan, s.key),
    };
  });
  const gaps = plan.sections.gaps.filter((g) => (g.status ?? "open") === "open");

  if (JSON_OUT) return ok({ percent: c.percent, steps, gaps, next: steps.find((s) => s.needsWork)?.key ?? null });

  out("");
  out(`  Project plan — ${c.percent}% complete. Sections still needing work:`);
  out("");
  for (const s of steps.filter((x) => x.needsWork)) {
    out(`   ${s.label}`);
    out(`     ${s.ask}`);
    if (s.detail) out(`     (${s.detail})`);
    out("");
  }
  if (gaps.length) {
    out(`  ${gaps.length} open gap(s) to triage — see \`maestro plan status\`.`);
    out("");
  }
  process.exit(0);
}

function currentFor(plan, key) {
  const s = SECTION_BY_KEY.get(key);
  const v = plan.sections[key];
  if (s.kind === "prose") return { text: v.text, metrics: v.metrics };
  if (s.kind === "scope") return { in: v.in, out: v.out };
  return v;
}

/**
 * Per-initiative delivery, grouped under each initiative with the project-wide items in their
 * own bucket. The marks say what a reader has to act on: a landed ticket (done), one in flight
 * (has a ticket), or nothing at all.
 */
function renderInitiativeCoverage(plan, rows, tickets, archived) {
  const progress = initiativeProgress(plan, tickets, archived);
  if (!progress.length) return false;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const line = (r) => {
    const mark = r.done ? "✓" : r.tickets.length ? "◐" : "○";
    const who = r.done ? r.tickets.join(", ") : r.tickets.length ? `${r.tickets.join(", ")} active` : "no ticket";
    return `     ${mark} ${r.id.padEnd(7)} ${r.text.slice(0, 52).padEnd(54)} ${who}`;
  };
  for (const p of progress) {
    out("");
    out(`  ${p.id} ${p.name} — ${p.percent}% delivered  (${p.done}/${p.total} items${p.milestones.length ? `, ${p.milestones.length} milestone(s)` : ""})`);
    const owned = rows.filter((r) => r.initiativeId === p.id);
    if (!owned.length) out("     _No plan items owned yet._");
    for (const r of owned) out(line(r));
  }
  const global = projectWideProgress(plan, tickets, archived);
  const globalRows = rows.filter((r) => r.initiativeId == null);
  if (globalRows.length) {
    out("");
    out(`  Project-wide — ${global.percent}% delivered  (${global.done}/${global.total} items)`);
    out(`     Owned by no single initiative; they apply to every one.`);
    for (const r of globalRows) out(line(r));
  }
  void byId;
  return true;
}

function renderCoverage(plan) {
  const board = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : { tickets: [] };
  const archPath = join(paths.boardDir, "archive.json");
  const archive = existsSync(archPath) ? JSON.parse(readFileSync(archPath, "utf8")) : { tickets: [] };
  const rows = planCoverage(plan, board.tickets ?? [], archive.tickets ?? []);
  const uncovered = rows.filter((r) => !r.tickets.length);

  const byInitiative = initiativeProgress(plan, board.tickets ?? [], archive.tickets ?? []);
  if (JSON_OUT) {
    return ok({
      rows,
      uncovered: uncovered.map((r) => r.id),
      initiatives: byInitiative,
      projectWide: byInitiative.length ? projectWideProgress(plan, board.tickets ?? [], archive.tickets ?? []) : null,
    });
  }

  out("");
  if (!rows.length) {
    out("  The plan names no deliverables, use cases, requirements, or milestones yet — nothing to cover.");
    out("");
    process.exit(0);
  }
  if (renderInitiativeCoverage(plan, rows, board.tickets ?? [], archive.tickets ?? [])) {
    out("");
    out(uncovered.length
      ? `  ${uncovered.length} plan item(s) with no ticket: ${uncovered.map((r) => r.id).join(", ")}`
      : "  Every plan item has a ticket.");
    out("");
    process.exit(0);
  }
  for (const r of rows) {
    const mark = r.done ? "✓" : r.tickets.length ? "·" : "✗";
    out(`   ${mark} ${r.id.padEnd(8)} ${r.tickets.length ? r.tickets.join(", ") : "no ticket"}   ${r.text.slice(0, 60)}`);
  }
  out("");
  out(uncovered.length
    ? `  ${uncovered.length} plan item(s) with no ticket: ${uncovered.map((r) => r.id).join(", ")}`
    : "  Every plan item has a ticket.");
  out("");
  process.exit(0);
}

/**
 * Run every `enforce` command the plan declares, and fail if any does.
 *
 * This is the whole point of the field. A rule stated as a requirement is something agents are
 * asked to honour; the same rule as a command that exits non-zero is something they cannot
 * violate — the check runs whether or not anyone remembered it, and no amount of confident
 * prose gets past it. Wire this into CI and it holds for human commits too.
 *
 * `--traces` narrows to one ticket's plan items, which is how the release gate uses it.
 */
function runEnforceChecks(plan) {
  const only = flag("traces");
  const items = enforceableItems(plan, only ? only.split(",").map((s2) => s2.trim()).filter(Boolean) : null);

  if (!items.length) {
    const msg = only
      ? `No enforce command on ${only} — nothing to run.`
      : "No plan item declares an `enforce` command. Rules that must never be violated should carry one: `maestro plan edit FR-3 --enforce \"npm run check:x\"`.";
    if (JSON_OUT) return ok({ ran: 0, failed: [], results: [] });
    out(`\n  ${msg}\n`);
    process.exit(0);
  }

  const cwd = resolve(flag("cwd") ?? repoRoot());
  const results = [];
  for (const item of items) {
    // shell: true so a project can declare a real command line ("npm run x && npm run y"),
    // which is what people actually put in these.
    const r = spawnSync(item.enforce, { cwd, shell: true, encoding: "utf8" });
    const status = r.status ?? (r.error ? 127 : 1);
    results.push({
      id: item.id,
      enforce: item.enforce,
      ok: status === 0,
      status,
      output: [r.stdout, r.stderr].filter(Boolean).join("").trim().slice(-2000),
    });
    if (!JSON_OUT) {
      out(`  ${status === 0 ? "✓" : "✗"} ${item.id.padEnd(7)} ${item.enforce}`);
      if (status !== 0) {
        const tail = results[results.length - 1].output.split("\n").slice(-12);
        for (const line of tail) out(`      ${line}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (JSON_OUT) {
    if (failed.length) {
      process.stdout.write(JSON.stringify({ ok: false, ran: results.length, failed: failed.map((f) => f.id), results }) + "\n");
      process.exit(1);
    }
    return ok({ ran: results.length, failed: [], results });
  }
  out("");
  if (failed.length) {
    out(`  ✗ ${failed.length} of ${results.length} plan invariant(s) violated: ${failed.map((f) => f.id).join(", ")}`);
    out("");
    process.exit(1);
  }
  out(`  ✓ all ${results.length} plan invariant(s) hold.`);
  out("");
  process.exit(0);
}

// ── Dispatch ────────────────────────────────────────────────────────────────────
main();

function main() {
const op = argv[0];
if (!op || op === "--help" || op === "-h" || op === "help") usage();
if (!OPS.has(op)) die(`Unknown op "${op}". Known: ${[...OPS].join(", ")}.`);

// An unparsable plan is the caller's to fix — never silently treated as an empty one, or the
// first write would replace a real plan with a blank.
let plan;
try { plan = readPlan(PLAN_PATH); } catch (e) { die(e.message, 1); }

switch (op) {
  case "version":
    return ok({ version: planVersion(PLAN_PATH), path: PLAN_PATH }, planVersion(PLAN_PATH));

  case "status":
    renderStatus(plan);
    break;

  case "questions":
    renderQuestions(plan);
    break;

  case "coverage":
    renderCoverage(plan);
    break;

  case "check": {
    runEnforceChecks(plan);
    break;
  }

  case "gate": {
    // The scope boundary as data, for callers that must apply it themselves — the orchestrate
    // Workflow can't import this module (a Workflow script has no filesystem access), so it
    // shells out here rather than asking an agent to interpret plan.json. Same authority,
    // no second reading of what "in scope" means.
    const items = planItems(plan);
    const inScopeIds = [...items.values()].filter((i) => TRACEABLE_PREFIXES.includes(i.prefix)).map((i) => i.id);
    const outIds = [...items.values()].filter((i) => i.prefix === "OUT").map((i) => i.id);
    const gating = planIsGating(plan);
    if (JSON_OUT) return ok({ gating, inScopeIds, outIds });
    out("");
    out(gating
      ? `  Scope gate ON — in scope: ${inScopeIds.join(", ") || "(none)"}${outIds.length ? `; out: ${outIds.join(", ")}` : ""}`
      : "  Scope gate OFF — the plan names no deliverable, use case, or requirement yet.");
    out("");
    process.exit(0);
    break;
  }

  case "show": {
    const key = flag("section");
    if (key && !SECTION_BY_KEY.has(key)) die(`Unknown section "${key}". Known: ${SECTION_KEYS.join(", ")}.`);
    if (JSON_OUT) return ok({ plan: key ? { [key]: plan.sections[key] } : plan });
    if (existsSync(paths.md) && !key) { out(readFileSync(paths.md, "utf8")); process.exit(0); }
    out(JSON.stringify(key ? plan.sections[key] : plan, null, 2));
    process.exit(0);
    break;
  }

  case "init": {
    if (existsSync(PLAN_PATH) && !has("force")) {
      die(`A plan already exists at ${PLAN_PATH}. Use \`maestro plan status\` to see it, or --force to reset it.`);
    }
    const r = write((p) => p, "plan-init");
    ok({ version: r.version, path: PLAN_PATH }, `plan created at ${PLAN_PATH} (0% complete — run /plan-update).`);
    break;
  }

  case "render": {
    const r = write((p) => p, "plan-render");
    ok({ version: r.version }, `plan.md re-rendered from plan.json.`);
    break;
  }

  case "set-goal": {
    const text = flag("text");
    const metrics = flagAll("metric");
    if (text == null && !metrics.length && !has("clear-metrics")) {
      die("Nothing to set — pass --text and/or --metric (repeatable).");
    }
    const r = write((p) => {
      if (text != null) p.sections.goal.text = text;
      if (has("clear-metrics")) p.sections.goal.metrics = [];
      // Append rather than replace: a questionnaire that adds one metric at a time must not
      // silently drop the ones already recorded.
      for (const m of metrics) if (!p.sections.goal.metrics.includes(m)) p.sections.goal.metrics.push(m);
      return p;
    }, "plan-set-goal");
    ok({ version: r.version, percent: planCompleteness(r.plan).percent }, `goal updated — plan now ${planCompleteness(r.plan).percent}% complete.`);
    break;
  }

  case "scope": {
    const ins = flagAll("in");
    const outs = flagAll("out");
    const removeIds = flagAll("remove-out");
    if (!ins.length && !outs.length && !removeIds.length) die("Nothing to set — pass --in and/or --out (both repeatable), or --remove-out <OUT-n>.");
    const added = [];
    const r = write((p) => {
      for (const x of ins) if (!p.sections.scope.in.includes(x)) p.sections.scope.in.push(x);
      for (const x of outs) {
        const id = nextOutId(p);
        p.sections.scope.out.push({ id, text: x });
        added.push(id);
      }
      if (removeIds.length) {
        p.sections.scope.out = p.sections.scope.out.filter((o) => !removeIds.includes(o.id));
      }
      return p;
    }, "plan-scope");
    ok({ version: r.version, added, percent: planCompleteness(r.plan).percent },
      `scope updated${added.length ? ` — out-of-scope ${added.join(", ")}` : ""}.`);
    break;
  }

  case "initiative-add": {
    const name = flag("name");
    const outcome = flag("outcome");
    if (!name || isPlaceholder(name)) die("--name is required, and must say something.");
    if (!outcome || isPlaceholder(outcome)) {
      die("--outcome is required: what is true for someone once this lands. An initiative without one is a folder, which is the thing this layer is not.");
    }
    let id;
    const r = write((p) => {
      id = nextId(p, "initiatives");
      const deps = flagAll("depends-on");
      for (const d of deps) {
        // THROW, never die(): this runs inside the board lock, and die() calls process.exit,
        // which skips the finally that releases it — leaving a stale lock the next writer has
        // to wait ten seconds for and then steal. A thrown error unwinds properly.
        if (!p.sections.initiatives.some((i) => i.id === d)) throw new Error(`--depends-on ${d} is not an initiative in this plan.`);
      }
      p.sections.initiatives.push({
        id, name, outcome,
        scope: { in: flagAll("in"), out: flagAll("out") },
        metrics: flagAll("metric"),
        depends_on: deps,
        ...(flag("notes") ? { notes: flag("notes") } : {}),
      });
      return p;
    }, "plan-initiative-add");
    ok({ version: r.version, id }, `${id} added — ${name}.`);
    break;
  }

  case "initiative-edit": {
    const id = argv[1];
    if (!id) die("Which initiative? `maestro plan initiative-edit <I-n> --name ...`");
    // Repeatable list flags REPLACE rather than append: "set the metrics to these three" is
    // the operation people mean, and an appending flag has no way to remove one.
    const patch = {};
    if (flag("name") != null) patch.name = flag("name");
    if (flag("outcome") != null) patch.outcome = flag("outcome");
    if (flag("notes") != null) patch.notes = flag("notes");
    const lists = { metrics: flagAll("metric"), depends_on: flagAll("depends-on") };
    const scopeIn = flagAll("in"), scopeOut = flagAll("out");
    if (!Object.keys(patch).length && !lists.metrics.length && !lists.depends_on.length && !scopeIn.length && !scopeOut.length) {
      die("Nothing to change — pass --name, --outcome, --notes, --metric, --in, --out or --depends-on.");
    }
    const r = write((p) => {
      const init = p.sections.initiatives.find((i) => i.id === id);
      if (!init) throw new Error(`${id} is not an initiative in this plan.`);
      Object.assign(init, patch);
      if (lists.metrics.length) init.metrics = lists.metrics;
      if (lists.depends_on.length) {
        for (const d of lists.depends_on) {
          // Thrown, not die()'d — see the note in initiative-add: this is inside the lock.
          if (d === id) throw new Error(`${id} cannot depend on itself.`);
          if (!p.sections.initiatives.some((i) => i.id === d)) throw new Error(`--depends-on ${d} is not an initiative in this plan.`);
        }
        init.depends_on = lists.depends_on;
      }
      if (scopeIn.length) init.scope = { ...init.scope, in: scopeIn };
      if (scopeOut.length) init.scope = { ...init.scope, out: scopeOut };
      return p;
    }, "plan-initiative-edit");
    ok({ version: r.version, id }, `${id} updated.`);
    break;
  }

  case "initiative-remove": {
    const id = argv[1];
    if (!id) die("Which initiative? `maestro plan initiative-remove <I-n>`");
    const current = normalisePlan(readPlan(PLAN_PATH));
    if (!current.sections.initiatives.some((i) => i.id === id)) die(`${id} is not an initiative in this plan.`);

    // NO --force. Every other removal in this CLI has one, because a dangling `traces_to` is a
    // recoverable state the orchestrator simply refuses. A dangling initiative is not: epics
    // would point at something that no longer exists, and every ticket beneath them would
    // inherit it. There is no reading under which that is what someone wanted, so the only
    // honest answer is to say what still references it and let them unwire it first.
    const refs = referencesToInitiative(current, id);
    if (refs.length) {
      die(`${id} is still referenced by ${refs.length}: ${refs.join(", ")}. ` +
          `Reassign or clear them first ('maestro plan edit <ID> --clear-initiative', ` +
          `'maestro ticket edit-epic <id> --initiative <I-n>'). There is no --force: leaving a ` +
          `dangling initiative reference is never what someone wanted.`, 1);
    }
    const r = write((p) => {
      p.sections.initiatives = p.sections.initiatives.filter((i) => i.id !== id);
      return p;
    }, "plan-initiative-remove");
    ok({ version: r.version, id }, `${id} removed.`);
    break;
  }

  case "add": {
    const key = argv[1];
    const section = SECTION_BY_KEY.get(key);
    if (!section || section.kind !== "list") {
      die(`\`add\` takes a list section: ${PLAN_SECTIONS.filter((s) => s.kind === "list").map((s) => s.key).join(", ")}. For gaps use \`gap-add\`; for the goal use \`set-goal\`; for scope use \`scope\`.`);
    }
    const patch = itemPatch(section);
    if (!patch.text || isPlaceholder(patch.text)) die("--text is required, and must say something (a placeholder like \"TBD\" would count as filled without being filled).");
    let id;
    const own = initiativePatch(normalisePlan(readPlan(PLAN_PATH)));
    if (own && !OWNED_SECTIONS.has(key)) {
      die(`Initiative ownership does not apply to "${key}". Only ${[...OWNED_SECTIONS].join(", ")} can belong to an initiative — gaps and open questions stay project-level.`);
    }
    const r = write((p) => {
      id = nextId(p, key);
      p.sections[key].push({ id, ...patch, ...(own?.initiativeId ? { initiativeId: own.initiativeId } : {}) });
      return p;
    }, `plan-add-${key}`);
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent }, `${id} added to ${section.label} — plan now ${c.percent}% complete.`);
    break;
  }

  case "edit": {
    const id = argv[1];
    if (!id) die("Which item? `maestro plan edit <ID> --text ...`");
    const key = sectionForId(id);
    if (!key || key === "scopeOut") die(`"${id}" is not an editable plan item id.`);
    const section = SECTION_BY_KEY.get(key);
    const patch = itemPatch(section);
    const current = normalisePlan(readPlan(PLAN_PATH));
    const own = initiativePatch(current);
    if (own && !OWNED_SECTIONS.has(key)) {
      die(`Initiative ownership does not apply to "${key}". Only ${[...OWNED_SECTIONS].join(", ")} can belong to an initiative — gaps and open questions stay project-level.`);
    }
    if (!Object.keys(patch).length && !own) {
      die(`Nothing to change — pass at least one of: ${["text", ...(section.fields ?? []), "notes"].map((f) => `--${f}`).join(" ")} --initiative --clear-initiative.`);
    }

    // Ownership is the one edit here that can invalidate the BOARD, so it is the one that gets
    // the reverse preflight. Changing an item's text cannot strand a trace; re-homing it can.
    if (own) {
      const preview = structuredClone(current);
      const target = preview.sections[key].find((i) => i.id === id);
      if (!target) die(`${id} is not in the plan.`);
      if (own.clear) delete target.initiativeId; else target.initiativeId = own.initiativeId;
      assertBoardSurvives(preview, id);
    }

    const r = write((p) => {
      const item = p.sections[key].find((i) => i.id === id);
      if (!item) throw new Error(`${id} is not in the plan.`);
      Object.assign(item, patch);
      if (own?.clear) delete item.initiativeId;
      else if (own?.initiativeId) item.initiativeId = own.initiativeId;
      return p;
    }, "plan-edit");
    ok({ version: r.version, id, percent: planCompleteness(r.plan).percent }, `${id} updated.`);
    break;
  }

  case "remove": {
    const id = argv[1];
    if (!id) die("Which item? `maestro plan remove <ID>`");
    const key = sectionForId(id);
    if (!key) die(`"${id}" is not a plan item id.`);

    // A removed requirement leaves every ticket that traced to it dangling — and the scope gate
    // would then refuse to run them. Say so rather than letting it be discovered at run time.
    const orphans = [];
    if (existsSync(DATA_PATH)) {
      try {
        const board = JSON.parse(readFileSync(DATA_PATH, "utf8"));
        for (const t of board.tickets ?? []) {
          if (Array.isArray(t.traces_to) && t.traces_to.includes(id)) orphans.push(t.id);
        }
      } catch { /* an unreadable board is the board validator's problem, not this op's */ }
    }
    if (orphans.length && !has("force")) {
      die(`${id} is traced to by ${orphans.join(", ")} — removing it puts those tickets out of scope. ` +
          `Re-trace them first, or pass --force.`, 1);
    }

    const r = write((p) => {
      if (key === "scopeOut") p.sections.scope.out = p.sections.scope.out.filter((o) => o.id !== id);
      else p.sections[key] = p.sections[key].filter((i) => i.id !== id);
      return p;
    }, "plan-remove");
    ok({ version: r.version, id, orphans, percent: planCompleteness(r.plan).percent },
      `${id} removed${orphans.length ? ` (${orphans.join(", ")} now trace to nothing)` : ""}.`);
    break;
  }

  case "gap-add": {
    const text = flag("text");
    const need = flag("need");
    const from = flag("from") ?? "";
    if (!text) die("--text is required.");
    if (!GAP_NEEDS.includes(need)) die(`--need must be one of: ${GAP_NEEDS.join(", ")}. "required" means the plan is incomplete without it and the completeness percentage should say so.`);

    // Reporting skills run repeatedly. Without this, every /atomic-report would file the same
    // gap again and the plan would fill with duplicates that each dock the percentage.
    const dup = plan.sections.gaps.find((g) => g.text.trim().toLowerCase() === text.trim().toLowerCase());
    if (dup) ok({ version: planVersion(PLAN_PATH), id: dup.id, duplicate: true }, `already raised as ${dup.id} — nothing added.`);

    let id;
    const r = write((p) => {
      id = nextId(p, "gaps");
      p.sections.gaps.push({ id, text, need, from, status: "open" });
      return p;
    }, "plan-gap-add");
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent },
      `${id} raised as ${need === "optional" ? "an" : "a"} ${need} gap — plan now ${c.percent}% complete.`);
    break;
  }

  case "gap-set": {
    const id = argv[1];
    if (!id) die("Which gap? `maestro plan gap-set <G-ID> --status accepted --resolved-as FR-7`");
    const status = flag("status");
    const need = flag("need");
    const resolvedAs = flag("resolved-as");
    if (status && !GAP_STATUSES.includes(status)) die(`--status must be one of: ${GAP_STATUSES.join(", ")}.`);
    if (need && !GAP_NEEDS.includes(need)) die(`--need must be one of: ${GAP_NEEDS.join(", ")}.`);
    if (!status && !need && !resolvedAs) die("Nothing to change — pass --status, --need, or --resolved-as.");
    const r = write((p) => {
      const g = p.sections.gaps.find((x) => x.id === id);
      if (!g) throw new Error(`${id} is not a gap in this plan.`);
      if (status) g.status = status;
      if (need) g.need = need;
      if (resolvedAs) g.resolvedAs = resolvedAs;
      return p;
    }, "plan-gap-set");
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent }, `${id} updated — plan now ${c.percent}% complete.`);
    break;
  }
}
}
