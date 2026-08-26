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
import { validateBoard, agentFileToCode, STATUSES, ARCHIVE_STATUSES, ARCHIVE_ONLY_STATUSES, PRIORITY, SWAG, MODELS, MODES } from "./board-core.mjs";
import { mutateBoard, boardVersion, BoardConflictError, BoardLockError } from "./board-io.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import { planItems, planIsGating, scopeVerdict, TRACEABLE_PREFIXES } from "./plan-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const argv = process.argv.slice(2);
const OPS = new Set([
  "set-status", "set-routing", "block", "archive", "version",
  "add", "add-epic", "import", "next-id", "retrace", "drop",
]);

// Ops that name a ticket as argv[1]. The rest either take no subject (version, next-id, add,
// add-epic) or take a file path (import), and must not be forced through the id guard below.
const OPS_TAKING_ID = new Set(["set-status", "set-routing", "block", "archive", "retrace", "drop"]);

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
    maestro ticket add-epic                   file a new epic
    maestro ticket import <file.json|->       bulk-add epics + tickets in one atomic write
    maestro ticket next-id [--count N]        allocate free ids (add --epics for epic ids)
    maestro ticket set-status <id> <status>   move a ticket between statuses
    maestro ticket set-routing <id>           set/clear cross-review role routing
    maestro ticket retrace <id>               set the plan items a ticket serves
    maestro ticket block <id>                 mark blocked and file a blocker ticket
    maestro ticket archive <id>               land-and-archive a finished ticket
    maestro ticket drop <id>                  archive a ticket that will never be done
    maestro ticket version                    print the board's content version

  Statuses: ${STATUSES.join(", ")}

  add flags:
    --name <text>  --desc <text>  (required)
    --id  --epic  --area  --priority <P0-P3>  --swag <XS-XL>  --status  --depends-on a,b
    --agent-plan a,b  --model  --execution-mode  --traces-to FR-1,FR-2  --human-gate  --test-cmd

  add-epic flags:
    --name <text>  (required)   --id  --desc  --traces-to

  import flags:
    --replace-sample   remove starter items marked "sample": true before adding
    Import only ADDS: an id already live or archived is an error, never an overwrite.

  set-status flags:
    --execution-mode <m>   --agent-plan <a,b,c>   --current-agent <c>   --next-agent <c>

  set-routing flags:
    --dev-runtime <id>  --dev-model <id>  --reviewer-runtime <id>  --reviewer-model <id>
    --clear             remove all four cross-review overrides (project defaults may apply)

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
  const v = boardVersion(dataPath);
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, version: v, board: dataPath }) + "\n");
  else process.stdout.write(`${v}\n`);
  process.exit(0);
}

if (!existsSync(dataPath)) die(`Board file not found: ${dataPath}. Pass --board <path>.`);

if (op === "next-id") {
  // Read-only, so it deliberately does NOT take the lock: these ids are a proposal, not a
  // reservation. The write that uses them re-checks for collisions inside the lock and fails
  // loudly if another writer got there first — which is the only guarantee worth having.
  const data = readJSONOr(dataPath, { epics: [], tickets: [] });
  const archive = readJSONOr(archivePath, { epics: [], tickets: [] });
  const count = Math.max(1, Number(flag("count", "1")) || 1);
  const ids = has("epics")
    ? nextEpicIds(data, archive, count)
    : nextTicketIds(data, archive, count);
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ids, version: boardVersion(dataPath) }) + "\n");
  else process.stdout.write(ids.join("\n") + "\n");
  process.exit(0);
}

const ticketId = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
if (OPS_TAKING_ID.has(op) && !ticketId) die(`${op} needs a ticket id: maestro ticket ${op} <id> …`);

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
    return planIsGating(p) ? p : null;
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

/** @param {any[]} tickets @param {string} id */
const find = (tickets, id) => tickets.find((t) => t.id === id);

/**
 * Ops are pure functions of (on-disk board, args) → new board. They run inside the lock,
 * against freshly-read state, and may throw to abort the write.
 */
const RUN = {
  "set-status": ({ data }) => {
    const status = argv[2];
    if (!status || status.startsWith("--")) throw usageError(`set-status needs a status: ${STATUSES.join(" | ")}`);
    if (!STATUSES.includes(status)) {
      throw usageError(`"${status}" is not a live status. Live boards use: ${STATUSES.join(", ")}. ` +
        `Terminal states leave the board via \`maestro ticket archive\`.`);
    }
    const t = find(data.tickets, ticketId);
    if (!t) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);

    const from = t.status;
    t.status = status;
    // Coordination fields are set in the same atomic write as the status they describe —
    // split across two writes, a crash between them leaves the board claiming a stage that
    // is not running.
    const em = flag("execution-mode"); if (em) t.execution_mode = em;
    const plan = flag("agent-plan"); if (plan) t.agent_plan = plan.split(",").map((s) => s.trim()).filter(Boolean);
    const cur = flag("current-agent"); if (cur != null && has("current-agent")) t.currentAgent = cur;
    const nxt = flag("next-agent"); if (nxt != null && has("next-agent")) t.nextAgent = nxt;

    return { data, result: { id: ticketId, from, to: status }, human: `${ticketId}: ${from} → ${status}` };
  },

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

  archive: ({ data, archive }) => {
    const evidence = flag("evidence");
    if (!evidence) throw usageError("archive needs --evidence <text> — a landed ticket records how it was verified.");
    const status = flag("status", "done");
    if (!ARCHIVE_STATUSES.includes(status)) {
      throw usageError(`--status must be one of ${ARCHIVE_STATUSES.join(", ")}.`);
    }

    const i = data.tickets.findIndex((t) => t.id === ticketId);
    if (i === -1) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);
    if (find(archive.tickets ?? [], ticketId)) {
      throw usageError(`Ticket ${ticketId} is already in ${archivePath}. Archiving twice would duplicate the id.`);
    }

    const [t] = data.tickets.splice(i, 1);
    const landed = { ...t, status, evidence };
    const doneAt = flag("done-at"); if (doneAt) landed.done_at = doneAt;

    archive.epics ??= [];
    archive.tickets ??= [];
    // An archived ticket's epic must still resolve, or dependency checks on it break once
    // the live epic is eventually removed.
    if (landed.epicId && !archive.epics.some((e) => e.id === landed.epicId)) {
      const epic = (data.epics ?? []).find((e) => e.id === landed.epicId);
      if (epic) archive.epics.push(epic);
    }
    archive.tickets.push(landed);

    return { data, archive, result: { id: ticketId, status }, human: `${ticketId} archived as ${status}` };
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

  // ── Creation ─────────────────────────────────────────────────────────────────
  add: ({ data, archive }) => {
    const name = flag("name");
    const desc = flag("desc");
    if (!name) throw usageError("add needs --name <text>.");
    if (!desc) throw usageError("add needs --desc <text> — a ticket with no description has no acceptance criteria, and the release gate treats that as an automatic no-go.");

    const id = flag("id") ?? nextTicketId(data, archive);
    assertFreeId(id, data, archive);

    const ticket = ticketFromFlags(id, name, desc);
    assertTraceable(ticket.traces_to);
    data.tickets.push(ticket);
    return { data, result: { id, status: ticket.status }, human: `${id} added (${ticket.status})` };
  },

  "add-epic": ({ data, archive }) => {
    const name = flag("name");
    if (!name) throw usageError("add-epic needs --name <text>.");
    const id = flag("id") ?? nextEpicIds(data, archive, 1)[0];
    if ((data.epics ?? []).some((e) => e.id === id) || (archive.epics ?? []).some((e) => e.id === id)) {
      throw usageError(`Epic id ${id} is already in use. Omit --id and one will be allocated from the board's current state.`);
    }
    const epic = { id, name };
    const desc = flag("desc"); if (desc) epic.desc = desc;
    const traces = listFlag("traces-to");
    if (traces) { assertTraceable(traces); epic.traces_to = traces; }
    data.epics ??= [];
    data.epics.push(epic);
    return { data, result: { id }, human: `epic ${id} added` };
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

    data.epics.push(...epics);
    data.tickets.push(...tickets);

    const summary = `imported ${epics.length} epic(s) + ${tickets.length} ticket(s)` +
      (dropped.length ? `, replacing sample ${dropped.join(", ")}` : "");
    return {
      data,
      result: { epics: epics.map((e) => e.id), tickets: tickets.map((t) => t.id), dropped },
      human: summary,
    };
  },

  /**
   * The honest delete: a ticket that will never be done leaves the board through the archive,
   * carrying WHY, rather than being erased. `done` is deliberately not accepted — recording
   * abandoned work as finished is the exact failure the archive-only statuses exist to prevent.
   */
  drop: ({ data, archive }) => {
    const reason = flag("reason");
    if (!reason) throw usageError("drop needs --reason <text> — a ticket leaving the board unfinished has to say why.");
    const status = flag("status", "wont-do");
    if (!ARCHIVE_ONLY_STATUSES.includes(status)) {
      throw usageError(`--status must be one of ${ARCHIVE_ONLY_STATUSES.join(", ")}. A ticket that was actually completed lands with 'maestro ticket archive' instead.`);
    }

    const i = data.tickets.findIndex((t) => t.id === ticketId);
    if (i === -1) throw usageError(`Ticket ${ticketId} is not on the active board at ${dataPath}.`);

    // The trap this guard exists for: eligibility treats EVERY archived id as a satisfied
    // dependency, regardless of the status it carries. So dropping a ticket as "wont-do"
    // silently UNBLOCKS everything waiting on it — work whose prerequisite was just declined
    // becomes runnable. Almost never what the caller meant.
    const dependents = data.tickets
      .filter((t) => (Array.isArray(t.depends_on) ? t.depends_on : []).includes(ticketId))
      .map((t) => t.id);
    if (dependents.length && !has("force")) {
      throw usageError(
        `${ticketId} is a dependency of ${dependents.join(", ")}. Archiving it — for any reason — ` +
        `marks it satisfied, so those tickets become eligible even though the work was never done. ` +
        `Re-point or drop them first, or pass --force if that really is what you want.`);
    }

    const [t] = data.tickets.splice(i, 1);
    const landed = { ...t, status, evidence: reason };
    archive.epics ??= [];
    archive.tickets ??= [];
    if (landed.epicId && !archive.epics.some((e) => e.id === landed.epicId)) {
      const epic = (data.epics ?? []).find((e) => e.id === landed.epicId);
      if (epic) archive.epics.push(epic);
    }
    archive.tickets.push(landed);
    return {
      data, archive,
      result: { id: ticketId, status, dependents },
      human: `${ticketId} dropped as ${status}${dependents.length ? ` (forced; ${dependents.join(", ")} may now be eligible)` : ""}`,
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

/** @param {string} id @param {{tickets?: any[]}} data @param {{tickets?: any[]}} archive */
function assertFreeId(id, data, archive) {
  if (find(data.tickets, id) || find(archive.tickets ?? [], id)) {
    throw usageError(`Ticket id ${id} is already in use on the board or in the archive. Omit --id ` +
      `and one will be allocated from the board's current state.`);
  }
}

/**
 * A ticket built from the `add` flags, with the defaults a runnable ticket needs. Enum fields
 * are checked here rather than left to the whole-board validator so the error names the flag
 * the caller actually typed.
 *
 * @param {string} id @param {string} name @param {string} desc
 */
function ticketFromFlags(id, name, desc) {
  const status = flag("status", "todo");
  const priority = flag("priority", "P2");
  const swag = flag("swag", "M");
  if (!STATUSES.includes(status)) throw usageError(`--status must be one of ${STATUSES.join(", ")}. Terminal states leave the board via 'maestro ticket archive' or 'drop'.`);
  if (!PRIORITY.includes(priority)) throw usageError(`--priority must be one of ${PRIORITY.join(", ")}.`);
  if (!SWAG.includes(swag)) throw usageError(`--swag must be one of ${SWAG.join(", ")}.`);

  /** @type {Record<string, any>} */
  const t = { id, name, desc, status, priority, swag, depends_on: listFlag("depends-on") ?? [] };
  const epic = flag("epic"); if (epic) t.epicId = epic;
  const area = flag("area"); if (area) t.area = area;
  const model = flag("model");
  if (model) {
    if (!MODELS.includes(model)) throw usageError(`--model must be one of ${MODELS.join(", ")}.`);
    t.model = model;
  }
  const mode = flag("execution-mode");
  if (mode) {
    if (!MODES.includes(mode)) throw usageError(`--execution-mode must be one of ${MODES.join(", ")}.`);
    t.execution_mode = mode;
  }
  const agentPlan = listFlag("agent-plan"); if (agentPlan) t.agent_plan = agentPlan;
  const traces = listFlag("traces-to"); if (traces) t.traces_to = traces;
  const gate = flag("human-gate"); if (gate) t.human_gate = gate;
  const testCmd = flag("test-cmd"); if (testCmd) t.testCmd = testCmd;
  const wave = flag("wave"); if (wave) t.wave = Number(wave);
  return t;
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
  return nextTicketIds(data, archive, 1)[0];
}

/**
 * The next `count` free ticket ids, contiguous. Handed out as a block so a planner can wire
 * `depends_on` between tickets that do not exist yet — the alternative is allocating one at a
 * time and discovering mid-import that the graph refers to ids it never got.
 *
 * @param {{tickets?: any[]}} data @param {{tickets?: any[]}} archive @param {number} count
 */
function nextTicketIds(data, archive, count) {
  const nums = [...(data.tickets ?? []), ...(archive.tickets ?? [])]
    .map((t) => { const m = String(t.id ?? "").match(/(\d+)$/); return m ? parseInt(m[1], 10) : NaN; })
    .filter((n) => !Number.isNaN(n));
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => `T-${String(start + i).padStart(3, "0")}`);
}

/** The same, for epics. Epic ids are `e1`, `e2` … in every board this kit ships. */
function nextEpicIds(data, archive, count) {
  const nums = [...(data.epics ?? []), ...(archive.epics ?? [])]
    .map((e) => { const m = String(e.id ?? "").match(/(\d+)$/); return m ? parseInt(m[1], 10) : NaN; })
    .filter((n) => !Number.isNaN(n));
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => `e${start + i}`);
}

/** @param {string} p @param {any} fallback */
function readJSONOr(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
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
