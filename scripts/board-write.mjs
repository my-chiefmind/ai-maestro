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
import { validateBoard, agentFileToCode, STATUSES, ARCHIVE_STATUSES, PRIORITY, SWAG } from "./board-core.mjs";
import { mutateBoard, boardVersion, BoardConflictError, BoardLockError } from "./board-io.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const argv = process.argv.slice(2);
const OPS = new Set(["set-status", "block", "archive", "version"]);

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

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

    maestro ticket set-status <id> <status>   move a ticket between statuses
    maestro ticket block <id>                 mark blocked and file a blocker ticket
    maestro ticket archive <id>               land-and-archive a finished ticket
    maestro ticket version                    print the board's content version

  Statuses: ${STATUSES.join(", ")}

  set-status flags:
    --execution-mode <m>   --agent-plan <a,b,c>   --current-agent <c>   --next-agent <c>

  block flags:
    --blocker-id <id>  --name <text>  --desc <text>  (required)
    --epic <id>  --area <a>  --priority <P0-P3>  --swag <XS-XL>  --failure-kind <k>

  archive flags:
    --evidence <text>  (required)   --done-at <YYYY-MM-DD>

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

const ticketId = argv[1];
if (!ticketId || ticketId.startsWith("--")) die(`${op} needs a ticket id: maestro ticket ${op} <id> …`);

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

const validate = ({ data, archive }) => validateBoard(data, {
  archived: archive.tickets ?? [],
  archivedEpics: archive.epics ?? [],
  agentCodes,
  config,
}).errors;

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
};

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
  const nums = [...(data.tickets ?? []), ...(archive.tickets ?? [])]
    .map((t) => { const m = String(t.id ?? "").match(/(\d+)$/); return m ? parseInt(m[1], 10) : NaN; })
    .filter((n) => !Number.isNaN(n));
  return `T-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0")}`;
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
