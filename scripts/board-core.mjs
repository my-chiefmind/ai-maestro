/**
 * board-core.mjs — the one true board validator.
 *
 * Pure functions, no I/O, no process.exit — so both the CLI (validate-board.mjs) and the
 * cockpit server can share the exact same integrity rules. A board is never "valid in the
 * UI but invalid on the command line".
 *
 * The validator is archive-aware: a landed ticket moves from data.json to archive.json, so
 * dependency checks and eligibility must count archived tickets as existing + done.
 */

export const STATUSES = ["backlog", "todo", "in-progress", "review", "blocked", "done"];
export const PRIORITY = ["P0", "P1", "P2", "P3"];
export const SWAG = ["XS", "S", "M", "L", "XL"];
export const MODELS = ["haiku", "sonnet", "opus"];
export const MODES = ["single-agent", "multi-agent"];

// Gates the orchestrator appends automatically — always valid in an agent_plan.
export const TERMINAL = new Set(["qa", "pd", "merge"]);

// Agent files are named by role (backend-developer.md); agent_plan uses short codes (backend).
export const CODE_ALIASES = {
  "backend-developer": "backend",
  "frontend-developer": "frontend",
  "principal-engineer": "pe",
  "principal-delivery": "pd",
};

/** Map an agent file basename (no extension) to the code used in agent_plan. */
export function agentFileToCode(basename) {
  return CODE_ALIASES[basename] ?? basename;
}

/**
 * Validate a board.
 *
 * @param {{epics?: any[], tickets?: any[]}} data        live board (data.json)
 * @param {object} [opts]
 * @param {any[]}  [opts.archived]       archived tickets (archive.json tickets)
 * @param {any[]}  [opts.archivedEpics]  archived epics (archive.json epics)
 * @param {Set<string>|null} [opts.agentCodes]  known agent codes, or null to skip the check
 * @returns {{errors: string[], warnings: string[], eligibleCount: number}}
 */
export function validateBoard(data, opts = {}) {
  const { archived = [], archivedEpics = [], agentCodes = null } = opts;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!Array.isArray(data?.epics)) err("Missing or non-array `epics`.");
  if (!Array.isArray(data?.tickets)) err("Missing or non-array `tickets`.");
  if (errors.length) return { errors, warnings, eligibleCount: 0 };

  // ── Epics (live + archived ids are both valid targets for a ticket's epicId) ──
  const epicIds = new Set();
  for (const e of data.epics) {
    if (!e.id) err(`Epic missing id: ${JSON.stringify(e).slice(0, 60)}`);
    if (!e.name) warn(`Epic ${e.id} missing name.`);
    if (epicIds.has(e.id)) err(`Duplicate epic id: ${e.id}`);
    epicIds.add(e.id);
  }
  const allEpicIds = new Set([...epicIds, ...archivedEpics.map((e) => e.id)]);

  // ── Ids that exist somewhere, and ids that count as "done" for dependency purposes ──
  const archivedIds = new Set(archived.map((t) => t.id));
  const ticketIds = new Set(); // live only
  const deps = new Map();
  const statusById = new Map();

  for (const t of data.tickets) {
    const id = t.id ?? "(no id)";
    if (!t.id) err(`Ticket missing id: ${JSON.stringify(t).slice(0, 60)}`);
    if (ticketIds.has(t.id)) err(`Duplicate ticket id: ${t.id}`);
    if (archivedIds.has(t.id)) warn(`${id}: also present in archive.json (live copy wins).`);
    ticketIds.add(t.id);
    statusById.set(t.id, t.status);

    if (!t.status || !STATUSES.includes(t.status)) err(`${id}: invalid status "${t.status}".`);
    if (t.priority && !PRIORITY.includes(t.priority)) err(`${id}: invalid priority "${t.priority}".`);
    if (t.swag && !SWAG.includes(t.swag)) err(`${id}: invalid swag "${t.swag}".`);
    if (t.model && !MODELS.includes(t.model)) err(`${id}: invalid model "${t.model}".`);
    else if (!t.model) warn(`${id}: no model set (will fall back to the area default).`);
    if (t.execution_mode && !MODES.includes(t.execution_mode)) err(`${id}: invalid execution_mode "${t.execution_mode}".`);

    if (t.epicId && !allEpicIds.has(t.epicId)) err(`${id}: epicId "${t.epicId}" does not exist.`);

    if (t.agent_plan) {
      if (!Array.isArray(t.agent_plan)) err(`${id}: agent_plan must be an array.`);
      else if (agentCodes) {
        for (const code of t.agent_plan) {
          if (!agentCodes.has(code) && !TERMINAL.has(code)) {
            err(`${id}: agent_plan references unknown agent "${code}".`);
          }
        }
      }
    }

    deps.set(t.id, Array.isArray(t.depends_on) ? t.depends_on : []);
  }

  // A dependency exists if it's a live ticket OR an archived ticket.
  const existingIds = new Set([...ticketIds, ...archivedIds]);
  // A dependency is satisfied if it's archived (all archived work is done) or a live done ticket.
  const doneIds = new Set([
    ...archivedIds,
    ...[...ticketIds].filter((id) => statusById.get(id) === "done"),
  ]);

  // ── Dependency integrity ──
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (!existingIds.has(d)) err(`${id}: depends_on "${d}" which does not exist.`);
    }
  }

  // ── Cycle detection (over live tickets; archived deps are terminal) ──
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...ticketIds].map((id) => [id, WHITE]));
  const stack = [];
  const visit = (id) => {
    color.set(id, GREY);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!ticketIds.has(d)) continue; // archived / missing deps aren't part of a live cycle
      if (color.get(d) === GREY) {
        const cyc = stack.slice(stack.indexOf(d)).concat(d).join(" → ");
        err(`Dependency cycle: ${cyc}`);
      } else if (color.get(d) === WHITE) {
        visit(d);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const id of ticketIds) if (color.get(id) === WHITE) visit(id);

  // ── Eligibility sanity ──
  const eligible = data.tickets.filter(
    (t) =>
      t.status === "todo" &&
      !t.human_gate &&
      (deps.get(t.id) ?? []).every((d) => doneIds.has(d))
  );
  if (eligible.length === 0) {
    warn("No eligible `todo` ticket right now — the orchestrator will report idle.");
  }

  return { errors, warnings, eligibleCount: eligible.length };
}
