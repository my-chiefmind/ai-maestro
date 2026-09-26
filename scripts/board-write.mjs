#!/usr/bin/env node
/**
 * board-write.mjs — `maestro ticket <op>`: the only supported way to change a board.
 *
 * Every operation here is DECLARATIVE — "set T-010 to blocked", not "here is the new
 * board". That is the whole point. A declarative op is applied to the board as it exists
 * on disk at write time, inside a lock (scripts/board-io.mjs), so there is no stale
 * in-memory copy for a concurrent writer to clobber. The read-modify-write race that lost
 * a ticket on this repo's board (T-010) is not "made less likely" — it is unrepresentable,
 * because no caller ever hands us a whole board to install.
 *
 * Usage:
 *   maestro ticket set-status <id> <status> [coordination flags]
 *   maestro ticket block <id> --blocker-id <id> --name <n> --desc <d> [ticket fields]
 *   maestro ticket archive <id> --evidence <text> [--done-at YYYY-MM-DD]
 *   maestro ticket version
 *
 * Common flags:
 *   --board <path>            board/data.json (default: ./board/data.json)
 *   --archive <path>          archive.json (default: alongside --board)
 *   --expect-version <v>      refuse the write if the board moved since you read it
 *   --agents <dir>            agent dir for plan validation (default: the kit's)
 *   --config <path>           project config, for model-floor + human-gate checks
 *   --json                    machine-readable result on stdout
 *   --dry-run                 report what would change; write nothing
 *
 * Exit codes: 0 = written (or no-op), 1 = usage/validation failure, 2 = conflict — the
 * board moved, or the lock could not be taken. 2 is retryable; 1 is not.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { validateBoard, agentFileToCode, STATUSES, ARCHIVE_ONLY_STATUSES, PRIORITY, SWAG, initiativeModeActive, epicOwnershipVerdict, ownershipVerdict } from "./board-core.mjs";
import { mutateBoard, boardVersion, BoardConflictError, BoardLockError } from "./board-io.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import { planItems, planIsGating, scopeVerdict, TRACEABLE_PREFIXES, initiativeMap } from "./plan-core.mjs";
import {
  createTicket, editTicket, setTicketStatus, setTicketEpic, createEpic, editEpic,
  archiveTicket, dropTicket, getBoardVersion, readBoard,
  getTicketEligibility, listTicketEligibility, claimTicket,
  BoardConflictError as PublicConflictError, BoardLockError as PublicLockError,
} from "./board-api.mjs";
import { nextTicketIds as publicNextTicketIds, nextEpicIds as publicNextEpicIds } from "./board-operations.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const argv = process.argv.slice(2);
const OPS = new Set([
  "set-status", "set-routing", "set-testcmd", "set-epic", "block", "archive", "version",
  "add", "edit", "add-epic", "edit-epic", "import", "next-id", "retrace", "drop", "eligibility", "claim",
]);

// Ops that name a ticket as argv[1]. The rest either take no subject (version, next-id, add,
// add-epic) or take a file path (import), and must not be forced through the id guard below.
const OPS_TAKING_ID = new Set(["edit", "set-status", "set-routing", "set-testcmd", "set-epic", "block", "archive", "retrace", "drop", "edit-epic", "claim"]);

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
/** A comma-separated list flag: `--traces-to FR-1,FR-2`. Absent → null, so "unset" and "empty" differ. */
const listFlag = (name) => {
  const v = flag(name);
  return v == null ? null : v.split(",").map((s2) => s2.trim()).filter(Boolean);
};

const JSON_OUT = has("json");
const DRY_RUN = has("dry-run");

/** @param {string} msg @param {number} [code] */
function die(msg, code = 1) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg, code }) + "\n");
  else process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code);
}

/** @param {object} payload @param {string} human */
function ok(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  else process.stdout.write(`  ✓ ${human}\n`);
  process.exit(0);
}

function usage() {
  process.stdout.write(`
  maestro ticket — change a board safely (locked, validated, atomic)

    maestro ticket add                        file a new ticket
    maestro ticket edit <id>                  change ticket fields with --changes <json>
    maestro ticket add-epic                   file a new epic
    maestro ticket edit-epic <id>             change an epic (initiative, name, desc, traces)
    maestro ticket import <file.json|->       bulk-add epics + tickets in one atomic write
    maestro ticket next-id [--count N]        allocate free ids (add --epics for epic ids)
    maestro ticket set-status <id> <status>   move a ticket between statuses
    maestro ticket set-routing <id>           set/clear cross-review role routing
    maestro ticket set-epic <id>              move a ticket to another epic
    maestro ticket set-testcmd <id>           set/clear the ticket's test command
    maestro ticket retrace <id>               set the plan items a ticket serves
    maestro ticket block <id>                 mark blocked and file a blocker ticket
    maestro ticket archive <id>               land-and-archive a finished ticket
    maestro ticket drop <id>                  archive a ticket that will never be done
    maestro ticket version                    print the board's content version
    maestro ticket eligibility [id]           read canonical dispatch eligibility (all or one)
    maestro ticket claim <id>                 atomically claim if still eligible

  Statuses: ${STATUSES.join(", ")}

  add flags:
    --name <text>  --desc <text>  (required)
    --id  --epic  --area  --priority <P0-P3>  --swag <XS-XL>  --status  --depends-on a,b
    --agent-plan a,b  --model  --execution-mode  --traces-to FR-1,FR-2  --human-gate  --test-cmd

  edit flags:
    --changes <json>   allowlisted field patch; null clears an optional field

  add-epic flags:
    --name <text>  (required)   --id  --desc  --traces-to  --initiative I-1

  edit-epic flags:
    --initiative I-2   move the epic to another plan initiative
    --clear-initiative  detach the epic from its initiative. Allowed while the plan DOES define
                        initiatives — an epic between assignments is a legitimate transitional
                        state, not an error. The epic then warns in the validator and its
                        tickets are not picked until it is assigned again. It must not still
                        trace an initiative-owned item though: with no initiative it may trace
                        only project-wide ones, so re-trace it (or move it) first.
    --name <text>   --desc <text>   --traces-to D-1,FR-4
    Refused if the result would leave any epic or ticket tracing across initiatives.

  import flags:
    --replace-sample   remove starter items marked "sample": true before adding
    Import only ADDS: an id already live or archived is an error, never an overwrite.

  set-status flags:
    --execution-mode <m>   --agent-plan <a,b,c>   --current-agent <c>   --next-agent <c>

  claim flags:
    the set-status coordination flags above, plus the all-or-none snapshot guard:
    --expect-version <v>  --expect-archive-version <v>  --expect-plan-version <v>

  set-routing flags:
    --dev-runtime <id>  --dev-model <id>  --reviewer-runtime <id>  --reviewer-model <id>
    --clear             remove all four cross-review overrides (project defaults may apply)

  set-epic flags:
    --epic <epic-id>    the epic to move the ticket under (required unless --clear)
    --clear             detach the ticket from its epic
    Refused if the epic does not exist, or if the move would leave the ticket tracing across
    initiative ownership — the same rule edit-epic enforces from the epic's side.

  set-testcmd flags:
    --cmd <command>     (required unless --clear)
    --clear             remove the ticket's testCmd override (an area default may apply)

  retrace flags:
    --traces-to FR-1,FR-2   --scope-exception <reason>   --clear-traces   --clear-exception
    --force  record a trace the plan does not define (the orchestrator still refuses it)

  block flags:
    --blocker-id <id>  --name <text>  --desc <text>  (required)
    --epic <id>  --area <a>  --priority <P0-P3>  --swag <XS-XL>  --failure-kind <k>

  archive flags:
    --evidence <text>  (required)   --done-at <YYYY-MM-DD>

  drop flags:
    --reason <text>  (required)   --status <${ARCHIVE_ONLY_STATUSES.join("|")}>   --force

  Common: --board --archive --expect-version --agents --config --json --dry-run

  Exit 2 means the board moved or the lock was busy — re-read and retry. Exit 1 means the
  request itself was wrong; retrying will not help.
`);
  process.exit(argv.length ? 1 : 0);
}

const op = argv[0];
if (!op || op === "--help" || op === "-h") usage();
if (!OPS.has(op)) die(`Unknown board op "${op}". Expected one of: ${[...OPS].join(", ")}.`);

const dataPath = resolve(flag("board", join(process.cwd(), "board", "data.json")));
const archivePath = resolve(flag("archive", join(dirname(dataPath), "archive.json")));

if (op === "version") {
  const v = getBoardVersion({ dataPath });
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, version: v, board: dataPath }) + "\n");
  else process.stdout.write(`${v}\n`);
  process.exit(0);
}

if (!existsSync(dataPath)) die(`Board file not found: ${dataPath}. Pass --board <path>.`);

if (op === "eligibility") {
  const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
  try {
    const result = id
      ? getTicketEligibility({ dataPath, archivePath, id })
      : listTicketEligibility({ dataPath, archivePath });
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
    else {
      const rows = id ? [result.verdict] : result.verdicts;
      for (const row of rows) {
        const why = row.reasons.map((reason) => reason.code).join(", ");
        process.stdout.write(`${row.ticketId}\t${row.state}${why ? `\t${why}` : ""}\n`);
      }
    }
    process.exit(0);
  } catch (error) {
    die(error.message, error.code === "EBOARDLOCK" ? 2 : 1);
  }
}

if (op === "next-id") {
  // These ids are proposals, not reservations. The coherent locked read prevents a mixed
  // data/archive snapshot; the write that uses them still re-checks for collisions in its own
  // lock, which is the only reservation guarantee worth having.
  const { data, archive, version } = readBoard({ dataPath, archivePath });
  const count = Math.max(1, Number(flag("count", "1")) || 1);
  const ids = has("epics")
    ? publicNextEpicIds(data, archive, count)
    : publicNextTicketIds(data, archive, count);
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ids, version }) + "\n");
  else process.stdout.write(ids.join("\n") + "\n");
  process.exit(0);
}

const ticketId = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
if (OPS_TAKING_ID.has(op) && !ticketId) die(`${op} needs an id: maestro ticket ${op} <id> …`);

// Public operations are the implementation used by both library consumers and the CLI.
// Keep this adapter limited to translating argv into object input and rendering the result.
const PUBLIC_OPS = new Set(["add", "edit", "set-status", "set-epic", "add-epic", "edit-epic", "archive", "drop", "claim"]);
if (PUBLIC_OPS.has(op)) {
  const common = {
    dataPath, archivePath, expectVersion: flag("expect-version") ?? undefined,
    dryRun: DRY_RUN,
    ...(has("agents") ? { agentsDir: flag("agents") } : {}),
    ...(has("config") ? { configPath: flag("config") } : {}),
  };
  const list = (name) => listFlag(name) ?? undefined;
  let call;
  try {
    if (op === "add") call = createTicket({ ...common,
      id: flag("id") ?? undefined, name: flag("name") ?? undefined, desc: flag("desc") ?? undefined,
      epicId: flag("epic") ?? undefined, area: flag("area") ?? undefined,
      priority: flag("priority", "P2"), swag: flag("swag", "M"), status: flag("status", "todo"),
      depends_on: list("depends-on") ?? [], agent_plan: list("agent-plan"), model: flag("model") ?? undefined,
      execution_mode: flag("execution-mode") ?? undefined, traces_to: list("traces-to"),
      human_gate: flag("human-gate") ?? undefined, testCmd: flag("test-cmd") ?? undefined,
      wave: flag("wave") == null ? undefined : Number(flag("wave")), force: has("force"),
    });
    else if (op === "edit") {
      const raw = flag("changes");
      if (!raw) die("edit needs --changes <json>.");
      let changes; try { changes = JSON.parse(raw); } catch (e) { die(`--changes is not valid JSON: ${e.message}`); }
      call = editTicket({ ...common, id: ticketId, changes, force: has("force") });
    } else if (op === "set-status") call = setTicketStatus({ ...common, id: ticketId, status: argv[2], coordination: {
      ...(has("execution-mode") ? { execution_mode: flag("execution-mode") } : {}),
      ...(has("agent-plan") ? { agent_plan: list("agent-plan") } : {}),
      ...(has("current-agent") ? { currentAgent: flag("current-agent") } : {}),
      ...(has("next-agent") ? { nextAgent: flag("next-agent") } : {}),
    } });
    else if (op === "claim") call = claimTicket({ ...common, id: ticketId,
      expectArchiveVersion: flag("expect-archive-version") ?? undefined,
      expectPlanVersion: flag("expect-plan-version") ?? undefined,
      coordination: {
        ...(has("execution-mode") ? { execution_mode: flag("execution-mode") } : {}),
        ...(has("agent-plan") ? { agent_plan: list("agent-plan") } : {}),
        ...(has("current-agent") ? { currentAgent: flag("current-agent") } : {}),
        ...(has("next-agent") ? { nextAgent: flag("next-agent") } : {}),
      },
    });
    else if (op === "set-epic") {
      if (has("clear") && has("epic")) die("--epic and --clear contradict each other.");
      if (!has("clear") && !has("epic")) die("set-epic needs --epic <epic-id>, or --clear.");
      call = setTicketEpic({ ...common, id: ticketId, epicId: has("clear") ? null : flag("epic") });
    } else if (op === "add-epic") call = createEpic({ ...common,
      id: flag("id") ?? undefined, name: flag("name") ?? undefined, desc: flag("desc") ?? undefined,
      initiativeId: flag("initiative") ?? undefined, traces_to: list("traces-to"), force: has("force"),
    });
    else if (op === "edit-epic") {
      if (has("initiative") && has("clear-initiative")) die("--initiative and --clear-initiative contradict each other.");
      const changes = {};
      if (has("initiative")) changes.initiativeId = flag("initiative");
      if (has("clear-initiative")) changes.initiativeId = null;
      if (has("name")) changes.name = flag("name");
      if (has("desc")) changes.desc = flag("desc");
      if (has("traces-to")) changes.traces_to = list("traces-to") ?? [];
      if (!Object.keys(changes).length) die("Nothing to change — pass --initiative, --clear-initiative, --name, --desc or --traces-to.");
      call = editEpic({ ...common, id: ticketId, changes, force: has("force") });
    } else if (op === "archive") call = archiveTicket({ ...common, id: ticketId,
      evidence: flag("evidence") ?? undefined, status: flag("status", "done"), doneAt: flag("done-at") ?? undefined,
    });
    else call = dropTicket({ ...common, id: ticketId, reason: flag("reason") ?? undefined,
      status: flag("status", "wont-do"), force: has("force"),
    });
    ok({ ...(call.result ?? {}), version: call.version, archiveVersion: call.archiveVersion,
      changed: call.changed, ...(DRY_RUN ? { dryRun: true } : {}) },
    `${op} ${call.changed ? "applied" : "made no change"}${DRY_RUN ? " (nothing written)" : ""}`);
  } catch (e) {
    if (e instanceof PublicConflictError || e instanceof PublicLockError) die(e.message, 2);
    die(e.message, 1);
  }
}

// ── Validation context, mirroring validate-board.mjs so the same board is judged the
//    same way whoever writes it. A missing agents dir or config downgrades to "skip that
//    check" rather than failing the write — the CLI has the same tolerance.
const agentsDir = flag("agents", join(KIT_ROOT, "agents"));
const agentCodes = (() => {
  if (!existsSync(agentsDir)) return null;
  const codes = new Set();
  for (const f of readdirSync(agentsDir)) {
    if (f.endsWith(".md")) codes.add(agentFileToCode(f.replace(/\.md$/, "")));
  }
  return codes.size ? codes : null;
})();
const config = (() => {
  const p = flag("config", join(dirname(dirname(dataPath)), "config.json"));
  if (!p || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
})();

// The plan beside this board, for checking `traces_to` at write time rather than leaving a
// typo'd trace to be discovered as a refused run. A missing, blank or unparsable plan reads as
// "no plan" and the trace checks are skipped — filing tickets must not require a plan to exist.
const plan = (() => {
  try {
    const p = readPlanForBoard(dataPath);
    // Gating OR initiative-defining. A plan can name initiatives before it names a single
    // requirement, and in that window ownership still has to be checked — otherwise the first
    // epics filed against a fresh initiative structure are the ones nothing verifies.
    return planIsGating(p) || initiativeModeActive(p) ? p : null;
  } catch {
    return null;
  }
})();

const validate = ({ data, archive }) => validateBoard(data, {
  archived: archive.tickets ?? [],
  archivedEpics: archive.epics ?? [],
  agentCodes,
  config,
  plan,
}).errors;

/**
 * Refuse a `traces_to` the plan can't honour.
 *
 * Two different mistakes, two different answers:
 *   - an `OUT-` id is a contradiction — the plan says "not this", so pointing a ticket at it is
 *     not an override, it's a category error. Never forceable; `--scope-exception` is the
 *     honest way to say "a human wants this anyway".
 *   - an id the plan doesn't define is usually a typo or a deleted requirement. Forceable,
 *     because a board mid-replan legitimately runs ahead of its plan — but the orchestrator
 *     will still refuse the ticket, and the message says so.
 *
 * @param {string[] | null | undefined} ids
 */
function assertTraceable(ids) {
  if (!plan || !ids?.length) return;
  const items = planItems(plan);
  const outOfScope = ids.filter((id) => items.get(id)?.prefix === "OUT");
  if (outOfScope.length) {
    throw usageError(
      `The plan lists ${outOfScope.join(", ")} as OUT of scope — tracing a ticket at it is a ` +
      `contradiction, not an override. If a human wants this to run anyway, say why: ` +
      `--scope-exception "<reason>".`);
  }
  const unknown = ids.filter((id) => !TRACEABLE_PREFIXES.includes(items.get(id)?.prefix ?? ""));
  if (unknown.length && !has("force")) {
    throw usageError(
      `The plan does not define ${unknown.join(", ")} as in-scope work. Add the requirement ` +
      `first ('maestro plan add …' or /plan-update), or pass --force to record the trace ` +
      `anyway — the orchestrator will still refuse the ticket until the plan covers it.`);
  }
}

/**
 * Refuse an `--initiative` the plan does not define.
 *
 * Deliberately NOT forceable, unlike an unknown `traces_to`. A trace running ahead of the plan
 * is a normal mid-replan state the orchestrator will simply refuse; an epic pointing at an
 * initiative that does not exist is a dangling reference with no reading under which it is
 * correct, and every ticket beneath it would inherit the same nonsense.
 *
 * There is no initiative id ALLOCATOR here on purpose: initiatives belong to the plan, and
 * `maestro ticket` may only ever reference one the plan already defines. Handing out `I-4`
 * from the board side would create an initiative nothing describes.
 */
function assertInitiativeExists(id) {
  if (id == null) return;
  if (!plan) {
    throw usageError(
      `Cannot set --initiative ${id}: there is no plan beside this board to define it. ` +
      `Write one first ('maestro plan init', then 'maestro plan initiative-add').`);
  }
  const known = initiativeMap(plan);
  if (!known.has(id)) {
    const list = known.size ? [...known.keys()].join(", ") : "none yet";
    throw usageError(
      `The plan does not define initiative ${id} (known: ${list}). ` +
      `Create it with 'maestro plan initiative-add --name … --outcome …'.`);
  }
}

/**
 * Refuse a change that would leave any epic or ticket wired across initiative boundaries.
 *
 * The board's own validator catches this too — mutateBoard runs it before writing, so nothing
 * invalid can land either way. This exists for the MESSAGE: reassigning an epic is a bulk
 * operation, and being told "the result would be invalid" followed by a wall of errors is a
 * worse answer than being told, up front, exactly which tickets stand in the way and that
 * nothing was written.
 *
 * @param {{epics:any[], tickets:any[]}} data the board AS IT WOULD BE after the change
 * @param {any[]} archivedEpics
 * @param {string} subject the epic being changed, for the message
 */
function assertNoCrossInitiative(data, archivedEpics, subject) {
  if (!initiativeModeActive(plan)) return;
  const conflicts = [];
  for (const e of data.epics ?? []) {
    const v = epicOwnershipVerdict(e, plan);
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(v.reason);
  }
  for (const t of data.tickets ?? []) {
    const v = ownershipVerdict(t, { plan, data, archivedEpics });
    if (v.state === "cross-initiative" || v.state === "unknown-initiative") conflicts.push(v.reason);
  }
  if (conflicts.length) {
    // Every conflicting id, not the first: one run has to tell the user the whole job.
    throw usageError(
      `Refusing to change ${subject} — ${conflicts.length} trace(s) would cross initiative ` +
      `boundaries and nothing has been written:\n${conflicts.map((c) => `  • ${c}`).join("\n")}`);
  }
}

/** @param {any[]} tickets @param {string} id */
const find = (tickets, id) => tickets.find((t) => t.id === id);

/**
 * Ops are pure functions of (on-disk board, args) → new board. They run inside the lock,
 * against freshly-read state, and may throw to abort the write.
 */
const RUN = {
  "set-routing": ({ data }) => {
    const t = find(data.tickets, ticketId);
    if (!t) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);
    const fields = {
      dev_runtime: flag("dev-runtime"), dev_model: flag("dev-model"),
      reviewer_runtime: flag("reviewer-runtime"), reviewer_model: flag("reviewer-model"),
    };
    if (has("clear")) {
      for (const field of Object.keys(fields)) delete t[field];
    } else {
      const entries = Object.entries(fields).filter(([, value]) => value != null);
      if (!entries.length) throw usageError("set-routing needs at least one routing flag, or --clear.");
      for (const [field, value] of entries) {
        if (!value.trim()) throw usageError(`--${field.replaceAll("_", "-")} needs a non-empty value.`);
        t[field] = value.trim();
      }
    }
    return {
      data,
      result: { id: ticketId, dev_runtime: t.dev_runtime, dev_model: t.dev_model,
        reviewer_runtime: t.reviewer_runtime, reviewer_model: t.reviewer_model },
      human: `${ticketId}: cross-review routing ${has("clear") ? "cleared" : "updated"}`,
    };
  },

  "set-testcmd": ({ data }) => {
    const t = find(data.tickets, ticketId);
    if (!t) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);
    if (has("clear")) {
      delete t.testCmd;
    } else {
      const cmd = flag("cmd");
      if (!cmd) throw usageError("set-testcmd needs --cmd <command>, or --clear.");
      if (!cmd.trim()) throw usageError("--cmd needs a non-empty value.");
      t.testCmd = cmd.trim();
    }
    return {
      data,
      result: { id: ticketId, testCmd: t.testCmd },
      human: `${ticketId}: testCmd ${has("clear") ? "cleared" : "updated"}`,
    };
  },

  block: ({ data, archive }) => {
    const name = flag("name");
    const desc = flag("desc");
    if (!name) throw usageError("block needs --name <text>.");
    if (!desc) throw usageError("block needs --desc <text>.");

    const t = find(data.tickets, ticketId);
    if (!t) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);

    // Allocated here, from the board as it is on disk inside the lock — never handed in
    // from a board the caller read earlier. A caller-chosen id computed from a stale read
    // is how two concurrent blockers collide on the same number.
    const blockerId = flag("blocker-id") ?? nextTicketId(data, archive);
    if (find(data.tickets, blockerId) || find(archive.tickets ?? [], blockerId)) {
      throw usageError(`Blocker id ${blockerId} is already in use. Omit --blocker-id and one ` +
        `will be allocated from the board's current state.`);
    }

    t.status = "blocked";
    const priority = flag("priority", "P0");
    const swag = flag("swag", "S");
    if (!PRIORITY.includes(priority)) throw usageError(`--priority must be one of ${PRIORITY.join(", ")}.`);
    if (!SWAG.includes(swag)) throw usageError(`--swag must be one of ${SWAG.join(", ")}.`);

    const blocker = {
      id: blockerId,
      name,
      desc,
      epicId: flag("epic", t.epicId ?? ""),
      area: flag("area", t.area ?? ""),
      priority,
      swag,
      status: "blocked",
      depends_on: [],
    };
    const kind = flag("failure-kind"); if (kind) blocker.failureKind = kind;
    data.tickets.push(blocker);

    return { data, result: { id: ticketId, blockerTicket: blockerId }, human: `${ticketId} blocked; filed ${blockerId}` };
  },

  // ── Scope ────────────────────────────────────────────────────────────────────
  // The repair path for a scope-blocked ticket. Without it the gate is enforceable but not
  // fixable: the orchestrator says "add it to the plan or set a scope_exception" and there is
  // no supported way to do the second half.
  retrace: ({ data }) => {
    const t = find(data.tickets, ticketId);
    if (!t) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);

    const traces = listFlag("traces-to");
    const exception = flag("scope-exception");
    const clearTraces = has("clear-traces");
    const clearException = has("clear-exception");
    if (!traces && exception == null && !clearTraces && !clearException) {
      throw usageError("Nothing to change — pass --traces-to <ids>, --scope-exception <reason>, " +
        "--clear-traces or --clear-exception.");
    }

    if (traces) { assertTraceable(traces); t.traces_to = traces; }
    if (clearTraces) delete t.traces_to;
    if (exception != null) {
      if (!exception.trim()) {
        throw usageError("--scope-exception needs a reason. An empty one would switch the scope " +
          "gate off for this ticket with nothing on record about why.");
      }
      t.scope_exception = exception.trim();
    }
    if (clearException) delete t.scope_exception;

    // Report the resulting verdict, not just the edit: the caller's actual question is "will
    // this run now?", and answering it here saves a round-trip through the orchestrator.
    const v = plan ? scopeVerdict(t, plan) : null;
    return {
      data,
      result: { id: ticketId, traces_to: t.traces_to ?? [], scope_exception: t.scope_exception, scope: v?.state ?? "no-plan", blocked: v?.blocks ?? false },
      human: `${ticketId}: ${v ? v.reason : "trace recorded (no plan to check it against yet)"}`,
    };
  },

  /**
   * Bulk creation, in one lock, one validation, one atomic write.
   *
   * ADD-ONLY, and that is the whole safety argument: an id already live or archived is a hard
   * error, never an overwrite. So an import cannot modify or delete existing work — the
   * read-modify-write damage this module exists to prevent stays unrepresentable, even though
   * this op takes a whole document. `--replace-sample` is the one removal it can do, and it can
   * only touch items explicitly marked `"sample": true` by a starter.
   */
  import: ({ data, archive }) => {
    const epics = Array.isArray(IMPORT_DOC.epics) ? IMPORT_DOC.epics : [];
    const tickets = Array.isArray(IMPORT_DOC.tickets) ? IMPORT_DOC.tickets : [];
    if (!epics.length && !tickets.length) {
      throw usageError("Nothing to import — the document needs an `epics` and/or `tickets` array.");
    }

    data.epics ??= [];
    data.tickets ??= [];

    const dropped = [];
    if (has("replace-sample")) {
      for (const t of data.tickets) if (t.sample) dropped.push(t.id);
      for (const e of data.epics) if (e.sample) dropped.push(e.id);
      data.tickets = data.tickets.filter((t) => !t.sample);
      data.epics = data.epics.filter((e) => !e.sample);
    }

    const liveEpics = new Set(data.epics.map((e) => e.id));
    const liveTickets = new Set(data.tickets.map((t) => t.id));
    const archivedTickets = new Set((archive.tickets ?? []).map((t) => t.id));
    const seen = new Set();

    for (const e of epics) {
      if (!e?.id) throw usageError(`Every imported epic needs an id: ${JSON.stringify(e).slice(0, 60)}`);
      if (seen.has(e.id)) throw usageError(`Epic ${e.id} appears twice in the import document.`);
      if (liveEpics.has(e.id)) throw usageError(`Epic ${e.id} already exists on the board. Import only ADDS — it never overwrites. Allocate free ids with 'maestro ticket next-id --epics --count N'.`);
      seen.add(e.id);
    }
    for (const t of tickets) {
      if (!t?.id) throw usageError(`Every imported ticket needs an id: ${JSON.stringify(t).slice(0, 60)}`);
      if (seen.has(t.id)) throw usageError(`Ticket ${t.id} appears twice in the import document.`);
      if (liveTickets.has(t.id)) throw usageError(`Ticket ${t.id} already exists on the board. Import only ADDS — it never overwrites. Allocate free ids with 'maestro ticket next-id --count N'.`);
      if (archivedTickets.has(t.id)) throw usageError(`Ticket ${t.id} is already in the archive. Reusing an archived id corrupts dependency resolution — allocate free ids with 'maestro ticket next-id --count N'.`);
      seen.add(t.id);
    }

    // Checked as one set: a document tracing half its tickets at a deleted requirement should
    // fail before any of it lands, not after the first eight tickets are already on the board.
    const traced = [...epics, ...tickets].flatMap((x) => (Array.isArray(x.traces_to) ? x.traces_to : []));
    assertTraceable([...new Set(traced)]);
    // Same one-set rule for initiatives: a document assigning half its epics to an initiative
    // that does not exist should fail before any of it lands.
    for (const id of new Set(epics.map((e) => e.initiativeId).filter(Boolean))) assertInitiativeExists(id);

    data.epics.push(...epics);
    data.tickets.push(...tickets);
    assertNoCrossInitiative(data, archive.epics ?? [], `this import`);

    const summary = `imported ${epics.length} epic(s) + ${tickets.length} ticket(s)` +
      (dropped.length ? `, replacing sample ${dropped.join(", ")}` : "");
    return {
      data,
      result: { epics: epics.map((e) => e.id), tickets: tickets.map((t) => t.id), dropped },
      human: summary,
    };
  },

};



/**
 * The import document, read and parsed OUTSIDE the lock — reading the caller's own input is not
 * board state, and doing it inside would hold the lock across a stdin read that may never end.
 */
const IMPORT_DOC = op === "import" ? readImportDoc() : null;

function readImportDoc() {
  const src = argv[1] && !argv[1].startsWith("--") ? argv[1] : flag("file");
  if (!src) die("import needs a document: maestro ticket import <file.json>  (or - for stdin)");
  let raw;
  try {
    raw = src === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(src), "utf8");
  } catch (e) {
    die(`Could not read ${src === "-" ? "stdin" : src}: ${e.message}`);
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object") throw new Error("not an object");
    return doc;
  } catch (e) {
    die(`${src === "-" ? "stdin" : src} is not valid JSON: ${e.message}`);
  }
}

function usageError(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

/**
 * Next free ticket id, in the board's own numbering. Mirrors the orchestrator's rule:
 * max numeric suffix across live AND archived tickets, +1, same width — the archive counts
 * because an id reused from it collides with a landed ticket the validator still tracks.
 *
 * @param {{tickets?: any[]}} data @param {{tickets?: any[]}} archive
 */
function nextTicketId(data, archive) {
  return publicNextTicketIds(data, archive, 1)[0];
}

let human = "";
try {
  const expectVersion = flag("expect-version") ?? undefined;

  if (DRY_RUN) {
    // Same code path, then throw to roll back — a dry run that used a different path
    // would not actually be testing the write it claims to preview.
    const before = boardVersion(dataPath);
    let preview;
    try {
      mutateBoard({
        dataPath, archivePath, expectVersion, validate, op: `${op}(dry-run)`,
        mutate: (ctx) => {
          const out = RUN[op](ctx);
          preview = out;
          const stop = new Error("__dry_run__");
          stop.dryRun = true;
          throw stop;
        },
      });
    } catch (e) {
      if (!e.dryRun) throw e;
    }
    ok({ dryRun: true, version: before, ...(preview?.result ?? {}) },
      `would apply: ${preview?.human ?? op} (nothing written)`);
  }

  const { result, version, changed } = mutateBoard({
    dataPath, archivePath, expectVersion, validate, op,
    mutate: (ctx) => {
      const out = RUN[op](ctx);
      human = out.human;
      return { data: out.data, archive: out.archive, result: out.result };
    },
  });

  ok({ ...result, version, changed }, `${human}${changed ? "" : " (already in that state)"}`);
} catch (e) {
  if (e instanceof BoardConflictError || e instanceof BoardLockError) die(e.message, 2);
  if (e.usage) die(e.message, 1);
  die(e.message, 1);
}
