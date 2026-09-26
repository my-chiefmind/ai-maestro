import {
  ARCHIVE_ONLY_STATUSES, ARCHIVE_STATUSES, MODELS, MODES, PRIORITY, STATUSES, SWAG,
  epicOwnershipVerdict, initiativeModeActive, ownershipVerdict,
} from "./board-core.mjs";
import { initiativeMap, planIsGating, planItems, TRACEABLE_PREFIXES } from "./plan-core.mjs";
import { BoardDuplicateError, BoardInputError, BoardNotFoundError } from "./board-errors.mjs";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const find = (xs, id) => (xs ?? []).find((x) => x.id === id);
const input = (condition, message, detail = {}) => { if (!condition) throw new BoardInputError(message, detail); };

export function nextTicketIds(data, archive, count = 1) {
  input(Number.isInteger(count) && count > 0, "count must be a positive integer.", { field: "count" });
  const nums = [...(data.tickets ?? []), ...(archive.tickets ?? [])]
    .map((t) => String(t.id ?? "").match(/(\d+)$/)?.[1]).filter(Boolean).map(Number);
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => `T-${String(start + i).padStart(3, "0")}`);
}

export function nextEpicIds(data, archive, count = 1) {
  input(Number.isInteger(count) && count > 0, "count must be a positive integer.", { field: "count" });
  const nums = [...(data.epics ?? []), ...(archive.epics ?? [])]
    .map((e) => String(e.id ?? "").match(/(\d+)$/)?.[1]).filter(Boolean).map(Number);
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => `e${start + i}`);
}

function assertFreeTicket(id, data, archive) {
  if (find(data.tickets, id) || find(archive.tickets, id)) {
    throw new BoardDuplicateError(`Ticket id ${id} is already in use on the board or in the archive.`, { id, kind: "ticket" });
  }
}

function assertTraceable(ids, plan, force = false) {
  if (!plan || (!planIsGating(plan) && !initiativeModeActive(plan)) || !ids?.length) return;
  const items = planItems(plan);
  const excluded = ids.filter((id) => items.get(id)?.prefix === "OUT");
  input(!excluded.length, `The plan lists ${excluded.join(", ")} as OUT of scope.`, { ids: excluded });
  const unknown = ids.filter((id) => !TRACEABLE_PREFIXES.includes(items.get(id)?.prefix ?? ""));
  input(force || !unknown.length, `The plan does not define ${unknown.join(", ")} as in-scope work.`, { ids: unknown });
}

function assertInitiative(id, plan) {
  if (id == null) return;
  const known = plan ? initiativeMap(plan) : new Map();
  input(plan && known.has(id), `The plan does not define initiative ${id} (known: ${known.size ? [...known.keys()].join(", ") : "none yet"}).`, { id });
}

function assertOwnership(data, archive, plan, subject) {
  if (!initiativeModeActive(plan)) return;
  const conflicts = [];
  for (const epic of data.epics ?? []) {
    const verdict = epicOwnershipVerdict(epic, plan);
    if (["cross-initiative", "unknown-initiative"].includes(verdict.state)) conflicts.push(verdict.reason);
  }
  for (const ticket of data.tickets ?? []) {
    const verdict = ownershipVerdict(ticket, { plan, data, archivedEpics: archive.epics ?? [] });
    if (["cross-initiative", "unknown-initiative"].includes(verdict.state)) conflicts.push(verdict.reason);
  }
  input(!conflicts.length, `Refusing to change ${subject} — ${conflicts.length} trace(s) would cross initiative boundaries and nothing has been written:\n${conflicts.map((x) => `  • ${x}`).join("\n")}`, { conflicts });
}

export function createTicketOperation(ctx, values = {}) {
  const { data, archive, plan } = ctx;
  input(typeof values.name === "string" && values.name.length, "--name is required.", { field: "name" });
  input(typeof values.desc === "string" && values.desc.length, "--desc is required — a ticket needs acceptance criteria.", { field: "desc" });
  const id = values.id ?? nextTicketIds(data, archive)[0];
  assertFreeTicket(id, data, archive);
  const status = values.status ?? "todo", priority = values.priority ?? "P2", swag = values.swag ?? "M";
  input(STATUSES.includes(status), `--status must be one of ${STATUSES.join(", ")}.`, { field: "status" });
  input(PRIORITY.includes(priority), `--priority must be one of ${PRIORITY.join(", ")}.`, { field: "priority" });
  input(SWAG.includes(swag), `--swag must be one of ${SWAG.join(", ")}.`, { field: "swag" });
  if (values.model != null) input(MODELS.includes(values.model), `--model must be one of ${MODELS.join(", ")}.`, { field: "model" });
  if (values.execution_mode != null) input(MODES.includes(values.execution_mode), `--execution-mode must be one of ${MODES.join(", ")}.`, { field: "execution_mode" });
  const ticket = { id, name: values.name, desc: values.desc, status, priority, swag, depends_on: values.depends_on ?? [] };
  for (const key of ["epicId", "area", "model", "execution_mode", "agent_plan", "traces_to", "human_gate", "testCmd", "wave", "touches"]) {
    if (values[key] != null) ticket[key] = values[key];
  }
  assertTraceable(ticket.traces_to, plan, values.force);
  data.tickets ??= []; data.tickets.push(ticket);
  return { data, result: { id, status }, human: `${id} added (${status})` };
}

// Per-ticket cross-review routing — the same rule `ticket set-routing` and the validator apply:
// a non-empty (trimmed) string sets the field; null or an empty string clears it (= inherit).
const ROUTING_FIELDS = ["dev_runtime", "dev_model", "reviewer_runtime", "reviewer_model"];
function normalizeRouting(changes) {
  const out = { ...changes };
  for (const field of ROUTING_FIELDS) {
    if (!own(out, field) || out[field] === null) continue;
    input(typeof out[field] === "string", `${field} must be a non-empty string, or null to inherit.`, { field, value: out[field] });
    out[field] = out[field].trim() || null;
  }
  return out;
}

const EDITABLE_TICKET = new Set(["name", "desc", "epicId", "area", "priority", "swag", "depends_on", "agent_plan", "model", "execution_mode", "traces_to", "scope_exception", "human_gate", "testCmd", "touches", "wave", "currentAgent", "nextAgent", ...ROUTING_FIELDS]);
export function editTicketOperation(ctx, { id, changes = {}, force = false } = {}) {
  input(id, "Ticket id is required.", { field: "id" });
  const ticket = find(ctx.data.tickets, id);
  if (!ticket) throw new BoardNotFoundError(`Ticket ${id} is not on the active board.`, { id, kind: "ticket" });
  input(changes && typeof changes === "object" && !Array.isArray(changes), "changes must be an object.", { field: "changes" });
  const unknown = Object.keys(changes).filter((key) => !EDITABLE_TICKET.has(key));
  input(!unknown.length, `Unsupported ticket field(s): ${unknown.join(", ")}.`, { fields: unknown });
  input(!own(changes, "id") && !own(changes, "status"), "Ticket id and status cannot be edited here; use setTicketStatus for status.");
  changes = normalizeRouting(changes);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete ticket[key]; else ticket[key] = value;
  }
  if (ticket.priority != null) input(PRIORITY.includes(ticket.priority), `priority must be one of ${PRIORITY.join(", ")}.`);
  if (ticket.swag != null) input(SWAG.includes(ticket.swag), `swag must be one of ${SWAG.join(", ")}.`);
  if (ticket.model != null) input(MODELS.includes(ticket.model), `model must be one of ${MODELS.join(", ")}.`);
  if (ticket.execution_mode != null) input(MODES.includes(ticket.execution_mode), `execution_mode must be one of ${MODES.join(", ")}.`);
  assertTraceable(ticket.traces_to, ctx.plan, force);
  assertOwnership(ctx.data, ctx.archive, ctx.plan, `ticket ${id}`);
  return { data: ctx.data, result: { id, ticket }, human: `${id} updated` };
}

export function setTicketStatusOperation(ctx, { id, status, coordination = {} } = {}) {
  input(STATUSES.includes(status), `"${status}" is not a live status. Live boards use: ${STATUSES.join(", ")}. Terminal states leave the board via archive.`, { field: "status" });
  const ticket = find(ctx.data.tickets, id);
  if (!ticket) {
    if (find(ctx.archive.tickets, id)) throw new BoardNotFoundError(`Ticket ${id} is archived. Archived work is history — it is not edited in place.`, { id, kind: "ticket", archived: true });
    throw new BoardNotFoundError(`Ticket ${id} is not on the active board.`, { id, kind: "ticket" });
  }
  const from = ticket.status; ticket.status = status;
  for (const key of ["execution_mode", "agent_plan", "currentAgent", "nextAgent"]) if (own(coordination, key)) ticket[key] = coordination[key];
  return { data: ctx.data, result: { id, from, to: status }, human: `${id}: ${from} → ${status}` };
}

export function setTicketEpicOperation(ctx, { id, epicId } = {}) {
  const ticket = find(ctx.data.tickets, id);
  if (!ticket) {
    if (find(ctx.archive.tickets, id)) throw new BoardNotFoundError(`Ticket ${id} is archived. Archived work is history — it is not edited in place.`, { id, kind: "ticket", archived: true });
    throw new BoardNotFoundError(`Ticket ${id} is not on the active board.`, { id, kind: "ticket" });
  }
  const from = ticket.epicId ?? null;
  if (epicId === null) delete ticket.epicId;
  else {
    input(typeof epicId === "string" && epicId.length, "epicId must be a string or null.", { field: "epicId" });
    if (!find(ctx.data.epics, epicId)) {
      const known = (ctx.data.epics ?? []).map((epic) => epic.id).join(", ") || "(none)";
      throw new BoardNotFoundError(`Epic ${epicId} does not exist on this board. Live epics: ${known}.`, { id: epicId, kind: "epic" });
    }
    ticket.epicId = epicId;
  }
  assertOwnership(ctx.data, ctx.archive, ctx.plan, `ticket ${id}`);
  return { data: ctx.data, result: { id, from, to: ticket.epicId ?? null, unchanged: from === (ticket.epicId ?? null) }, human: `${id}: ${from ?? "(no epic)"} → ${ticket.epicId ?? "(no epic)"}` };
}

export function createEpicOperation(ctx, values = {}) {
  input(typeof values.name === "string" && values.name.length, "Epic name is required.", { field: "name" });
  const id = values.id ?? nextEpicIds(ctx.data, ctx.archive)[0];
  if (find(ctx.data.epics, id) || find(ctx.archive.epics, id)) throw new BoardDuplicateError(`Epic id ${id} is already in use.`, { id, kind: "epic" });
  assertInitiative(values.initiativeId, ctx.plan);
  const epic = { id, name: values.name };
  for (const key of ["desc", "initiativeId", "traces_to"]) if (values[key] != null) epic[key] = values[key];
  assertTraceable(epic.traces_to, ctx.plan, values.force);
  ctx.data.epics ??= []; ctx.data.epics.push(epic);
  assertOwnership(ctx.data, ctx.archive, ctx.plan, `epic ${id}`);
  return { data: ctx.data, result: { id, initiativeId: epic.initiativeId ?? null }, human: `epic ${id} added` };
}

export function editEpicOperation(ctx, { id, changes = {}, force = false } = {}) {
  const epic = find(ctx.data.epics, id);
  if (!epic) {
    if (find(ctx.archive.epics, id)) throw new BoardNotFoundError(`Epic ${id} is archived. Archived work is history — it is not edited in place.`, { id, kind: "epic", archived: true });
    throw new BoardNotFoundError(`Epic ${id} does not exist on this board.`, { id, kind: "epic" });
  }
  const allowed = new Set(["name", "desc", "initiativeId", "traces_to"]);
  const unknown = Object.keys(changes).filter((key) => !allowed.has(key));
  input(!unknown.length, `Unsupported epic field(s): ${unknown.join(", ")}.`, { fields: unknown });
  if (own(changes, "initiativeId") && changes.initiativeId != null) assertInitiative(changes.initiativeId, ctx.plan);
  if (own(changes, "traces_to") && changes.traces_to != null) assertTraceable(changes.traces_to, ctx.plan, force);
  const shadow = find(ctx.archive.epics, id);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete epic[key]; else epic[key] = value;
    if (key === "initiativeId" && shadow) { if (value === null) delete shadow[key]; else shadow[key] = value; }
  }
  assertOwnership(ctx.data, ctx.archive, ctx.plan, `epic ${id}`);
  return { data: ctx.data, archive: ctx.archive, result: {
    id, initiativeId: epic.initiativeId ?? null, name: epic.name, traces_to: epic.traces_to ?? [],
    syncedArchivedCopy: Boolean(shadow) && own(changes, "initiativeId"), epic,
  }, human: `epic ${id} updated` };
}

function moveToArchive(ctx, { id, status, evidence, doneAt, force = false, dropping = false }) {
  const index = (ctx.data.tickets ?? []).findIndex((ticket) => ticket.id === id);
  if (index < 0) throw new BoardNotFoundError(`Ticket ${id} is not on the active board.`, { id, kind: "ticket" });
  if (find(ctx.archive.tickets, id)) throw new BoardDuplicateError(`Ticket ${id} is already archived.`, { id, kind: "ticket" });
  const dependents = (ctx.data.tickets ?? []).filter((t) => (t.depends_on ?? []).includes(id)).map((t) => t.id);
  input(!dropping || force || !dependents.length, `${id} is a dependency of ${dependents.join(", ")}; dropping it would mark that dependency satisfied.`, { dependents });
  const [ticket] = ctx.data.tickets.splice(index, 1);
  const archived = { ...ticket, status, evidence };
  if (doneAt) archived.done_at = doneAt;
  ctx.archive.epics ??= []; ctx.archive.tickets ??= [];
  if (archived.epicId && !find(ctx.archive.epics, archived.epicId)) {
    const epic = find(ctx.data.epics, archived.epicId); if (epic) ctx.archive.epics.push(epic);
  }
  ctx.archive.tickets.push(archived);
  return { data: ctx.data, archive: ctx.archive, writeFirst: "archive", result: { id, status, dependents }, human: `${id} archived as ${status}` };
}

export function archiveTicketOperation(ctx, { id, evidence, status = "done", doneAt } = {}) {
  input(typeof evidence === "string" && evidence.length, "Archive evidence is required.", { field: "evidence" });
  input(ARCHIVE_STATUSES.includes(status), `status must be one of ${ARCHIVE_STATUSES.join(", ")}.`, { field: "status" });
  return moveToArchive(ctx, { id, evidence, status, doneAt });
}

export function dropTicketOperation(ctx, { id, reason, status = "wont-do", force = false } = {}) {
  input(typeof reason === "string" && reason.length, "Drop reason is required.", { field: "reason" });
  input(ARCHIVE_ONLY_STATUSES.includes(status), `status must be one of ${ARCHIVE_ONLY_STATUSES.join(", ")}.`, { field: "status" });
  return moveToArchive(ctx, { id, evidence: reason, status, force, dropping: true });
}

/**
 * Fields only an archived ticket carries — exactly what moveToArchive adds on the way out
 * (`evidence`, which also holds a drop's reason, and `done_at`), plus the camelCase `doneAt`
 * spelling hand edits have produced. Status is overwritten rather than stripped.
 */
export const ARCHIVE_ONLY_FIELDS = ["evidence", "done_at", "doneAt"];

/** moveToArchive in reverse: one ticket from archive.tickets back to data.tickets. */
export function unarchiveTicketOperation(ctx, { id, status = "review", withEpic = false } = {}) {
  input(STATUSES.includes(status) && status !== "done",
    `"${status}" is not a restorable status. Use one of: ${STATUSES.filter((s) => s !== "done").join(", ")}.`, { field: "status" });
  const index = (ctx.archive.tickets ?? []).findIndex((ticket) => ticket.id === id);
  if (index < 0) throw new BoardNotFoundError(`Ticket ${id} is not in the archive.`, { id, kind: "ticket" });
  if (find(ctx.data.tickets, id)) throw new BoardDuplicateError(`Ticket ${id} is already on the active board.`, { id, kind: "ticket" });
  const [archived] = ctx.archive.tickets.splice(index, 1);
  const restored = { ...archived, status };
  for (const field of ARCHIVE_ONLY_FIELDS) delete restored[field];
  ctx.data.epics ??= []; ctx.data.tickets ??= [];
  let restoredEpic = null;
  if (restored.epicId && !find(ctx.data.epics, restored.epicId)) {
    const epic = find(ctx.archive.epics, restored.epicId);
    if (epic) {
      input(withEpic, `Ticket ${id}'s epic ${restored.epicId} exists only in the archive. Pass --with-epic to restore it too.`,
        { field: "epicId", epicId: restored.epicId });
      // Copy, not move: other archived tickets still resolve their epic through archive.epics.
      ctx.data.epics.push({ ...epic }); restoredEpic = epic.id;
    }
  }
  ctx.data.tickets.push(restored);
  // The ticket moves INTO data.json, so mutateBoard writes it first (T-063).
  return { data: ctx.data, archive: ctx.archive, writeFirst: "data", result: { id, status, restoredEpic },
    human: `${id} restored as ${status}${restoredEpic ? ` with epic ${restoredEpic}` : ""}` };
}

/**
 * Retire an epic with no live tickets: move it from data.epics to archive.epics. Archiving a
 * ticket may already have left a shadow copy of the epic there; the live copy replaces it so the
 * archive holds exactly one entry, carrying the epic's latest fields (initiativeId included).
 */
export function archiveEpicOperation(ctx, { id } = {}) {
  const index = (ctx.data.epics ?? []).findIndex((epic) => epic.id === id);
  if (index < 0) {
    const archived = Boolean(find(ctx.archive.epics, id));
    throw new BoardNotFoundError(`Epic ${id} is not on the active board${archived ? " (it is already archived)" : ""}.`,
      { id, kind: "epic", archived });
  }
  const live = (ctx.data.tickets ?? []).filter((ticket) => ticket.epicId === id).map((ticket) => ticket.id);
  input(!live.length, `Epic ${id} still has live tickets: ${live.join(", ")}. Archive, drop or move them first.`,
    { field: "id", tickets: live });
  const [epic] = ctx.data.epics.splice(index, 1);
  ctx.archive.epics ??= []; ctx.archive.tickets ??= [];
  const shadow = ctx.archive.epics.findIndex((e) => e.id === id);
  if (shadow >= 0) ctx.archive.epics[shadow] = epic; else ctx.archive.epics.push(epic);
  // The epic moves INTO archive.json, so mutateBoard writes it first (T-063).
  return { data: ctx.data, archive: ctx.archive, writeFirst: "archive",
    result: { id, replacedShadow: shadow >= 0 }, human: `epic ${id} archived` };
}
