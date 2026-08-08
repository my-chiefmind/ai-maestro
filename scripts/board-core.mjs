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

/**
 * Terminal states a ticket may carry ONLY in archive.json — for tickets that left the
 * board without being completed: shelved pending an owner decision (`archived`), filed
 * twice (`duplicate`), or deliberately declined (`wont-do`). Folding these into `done`
 * would record work as finished that never was, so a LIVE ticket carrying one of them
 * is a hard error.
 */
export const ARCHIVE_ONLY_STATUSES = ["archived", "duplicate", "wont-do"];
export const ARCHIVE_STATUSES = [...STATUSES, ...ARCHIVE_ONLY_STATUSES];

/**
 * Known values for `failureKind` on blocker tickets created after a failed merge —
 * an enum so merge failures are classifiable rather than free text. Unknown values
 * are a warning, not an error, so a newer board doesn't hard-fail an older validator.
 */
export const FAILURE_KINDS = ["merge-conflict", "merge-schema-invalid", "merge-unknown-status", "merge-missing-sha"];

export const PRIORITY = ["P0", "P1", "P2", "P3"];
export const SWAG = ["XS", "S", "M", "L", "XL"];
export const MODELS = ["haiku", "sonnet", "opus"];
export const MODES = ["single-agent", "multi-agent"];

// Terminal gates — appended to a ticket's plan by resolvePlan(). Always valid in an agent_plan.
export const TERMINAL = new Set(["qa", "pd", "merge"]);

// Model tiers, weakest → strongest. Used to apply per-area floors.
export const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };

// Agent files are named by role (backend-developer.md); agent_plan uses short codes (backend).
export const CODE_ALIASES = {
  "backend-developer": "backend",
  "frontend-developer": "frontend",
  "pipeline-developer": "pipeline",
  "principal-engineer": "pe",
  "principal-delivery": "pd",
  // `docs` matches the area name, like backend/frontend do. Without it the starter shipped a
  // `docs` area (and a model floor for it) that no agent could implement.
  "technical-writer": "docs",
};

/** Map an agent file basename (no extension) to the code used in agent_plan. */
export function agentFileToCode(basename) {
  return CODE_ALIASES[basename] ?? basename;
}

/**
 * The pipeline a ticket actually runs: its `agent_plan` with terminal gates guaranteed at the
 * end, in canonical order. `qa` and `merge` are always appended if absent; `pd` (delivery
 * gate) is added for multi-agent or human-gated tickets. This is the single source of truth
 * for "gates are appended automatically".
 */
export function resolvePlan(ticket) {
  const base = (Array.isArray(ticket.agent_plan) ? ticket.agent_plan : []).filter((c) => !TERMINAL.has(c));
  const gates = ["qa"];
  if (ticket.execution_mode === "multi-agent" || ticket.human_gate) gates.push("pd");
  gates.push("merge");
  return [...base, ...gates];
}

/**
 * The model tier a ticket actually runs on: the stronger of its own `model` and its area's
 * floor (`config.model.floors[area]`), falling back to `config.model.default`. This is how
 * per-area model floors are enforced.
 */
export function effectiveModel(ticket, config) {
  const base = ticket.model || config?.model?.default || "sonnet";
  const floor = config?.model?.floors?.[ticket.area];
  if (floor && (MODEL_RANK[floor] ?? -1) > (MODEL_RANK[base] ?? -1)) return floor;
  return base;
}

/**
 * Validate a board.
 *
 * @param {{epics?: any[], tickets?: any[]}} data        live board (data.json)
 * @param {object} [opts]
 * @param {any[]}  [opts.archived]       archived tickets (archive.json tickets)
 * @param {any[]}  [opts.archivedEpics]  archived epics (archive.json epics)
 * @param {Set<string>|null} [opts.agentCodes]  known agent codes, or null to skip the check
 * @param {object|null} [opts.config]  project config (for model-floor checks), or null to skip
 * @returns {{errors: string[], warnings: string[], eligibleCount: number}}
 */
export function validateBoard(data, opts = {}) {
  const { archived = [], archivedEpics = [], agentCodes = null, config = null } = opts;
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

  // ── Archived tickets are validated too: they stay dependency targets forever, so a
  //    malformed or duplicated archive entry corrupts eligibility just as surely as a
  //    live one. Ids must be unique ACROSS active + archive — a collision here is how
  //    archive-on-done tooling has historically deleted the wrong ticket.
  const archivedIds = new Set();
  for (const t of archived) {
    const id = t.id ?? "(no id)";
    if (!t.id) err(`archive: ticket missing id: ${JSON.stringify(t).slice(0, 60)}`);
    if (archivedIds.has(t.id)) err(`archive: duplicate ticket id "${t.id}" — ids must be unique across data.json + archive.json.`);
    archivedIds.add(t.id);

    // Archived tickets may additionally carry the archive-only terminal states.
    if (!t.status || !ARCHIVE_STATUSES.includes(t.status)) err(`archive ${id}: invalid status "${t.status}".`);
    if (t.priority && !PRIORITY.includes(t.priority)) err(`archive ${id}: invalid priority "${t.priority}".`);
    if (t.swag && !SWAG.includes(t.swag)) err(`archive ${id}: invalid swag "${t.swag}".`);
    if (t.model && !MODELS.includes(t.model)) err(`archive ${id}: invalid model "${t.model}".`);
    if (t.execution_mode && !MODES.includes(t.execution_mode)) err(`archive ${id}: invalid execution_mode "${t.execution_mode}".`);
    if (t.failureKind && !FAILURE_KINDS.includes(t.failureKind)) {
      warn(`archive ${id}: unknown failureKind "${t.failureKind}" — known: ${FAILURE_KINDS.join(", ")}.`);
    }
  }

  // ── Ids that exist somewhere, and ids that count as "done" for dependency purposes ──
  const ticketIds = new Set(); // live only
  const deps = new Map();
  const statusById = new Map();

  for (const t of data.tickets) {
    const id = t.id ?? "(no id)";
    if (!t.id) err(`Ticket missing id: ${JSON.stringify(t).slice(0, 60)}`);
    if (ticketIds.has(t.id)) err(`Duplicate ticket id: ${t.id}`);
    if (archivedIds.has(t.id)) err(`${id}: also present in archive.json — ids must be unique across data.json + archive.json.`);
    ticketIds.add(t.id);
    statusById.set(t.id, t.status);

    if (ARCHIVE_ONLY_STATUSES.includes(t.status)) {
      // A declined or duplicate ticket belongs in the archive; leaving it live either
      // clutters the board or, worse, gets "resolved" by flipping it to done — recording
      // work as finished that never was.
      err(`${id}: status "${t.status}" is archive-only — move the ticket to archive.json (live statuses: ${STATUSES.join(", ")}).`);
    } else if (!t.status || !STATUSES.includes(t.status)) {
      err(`${id}: invalid status "${t.status}".`);
    }
    if (t.priority && !PRIORITY.includes(t.priority)) err(`${id}: invalid priority "${t.priority}".`);
    if (t.swag && !SWAG.includes(t.swag)) err(`${id}: invalid swag "${t.swag}".`);
    if (t.model && !MODELS.includes(t.model)) err(`${id}: invalid model "${t.model}".`);
    else if (!t.model) warn(`${id}: no model set (will fall back to the area default).`);
    if (t.execution_mode && !MODES.includes(t.execution_mode)) err(`${id}: invalid execution_mode "${t.execution_mode}".`);
    if (t.failureKind && !FAILURE_KINDS.includes(t.failureKind)) {
      warn(`${id}: unknown failureKind "${t.failureKind}" — known: ${FAILURE_KINDS.join(", ")}.`);
    }

    // A human gate makes the ticket ineligible for auto-pick, so `todo`/`in-progress`
    // is misleading — it looks runnable on the board but never runs. Flag it so a
    // human notices and either clears the gate or moves it back to backlog.
    if (t.human_gate && (t.status === "todo" || t.status === "in-progress")) {
      warn(`${id}: human-gated ticket is "${t.status}" — the gate makes it ineligible; clear the gate or move it to backlog.`);
    }

    // Model floor: surface when a ticket will be raised to its area's floor at run time.
    if (config && t.model && MODELS.includes(t.model)) {
      const eff = effectiveModel(t, config);
      if (eff !== t.model) warn(`${id}: model "${t.model}" is below the "${t.area}" floor — it will run on "${eff}".`);
    }

    // Human gate must come from the project's configured vocabulary, or the orchestrator can't
    // match it reliably (this is what the board-validate skill promises).
    if (config?.humanGates?.length && t.human_gate && !config.humanGates.includes(t.human_gate)) {
      warn(`${id}: human_gate "${t.human_gate}" isn't in config.humanGates — use one of: ${config.humanGates.join(", ")}.`);
    }

    // Routing contract: a runnable ticket needs the fields the orchestrator dispatches on.
    if (!t.name) warn(`${id}: no name.`);
    if (t.status === "todo" || t.status === "in-progress") {
      if (!(Array.isArray(t.agent_plan) && t.agent_plan.length)) warn(`${id}: ${t.status} ticket has no agent_plan to route.`);
      if (!t.area) warn(`${id}: ${t.status} ticket has no area (no model floor or area test command applies).`);
    }

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

  // A dependency exists if it's a live ticket OR an archived ticket — landed tickets move
  // to archive.json by design, so deps legitimately point into the archive.
  const existingIds = new Set([...ticketIds, ...archivedIds]);
  // A dependency is satisfied if it's archived (all archived work is done) or a live done ticket.
  const doneIds = new Set([
    ...archivedIds,
    ...[...ticketIds].filter((id) => statusById.get(id) === "done"),
  ]);

  // ── Dependency integrity ──
  // An id found in NEITHER data.json nor archive.json is a hard error, not a warning:
  // the runtime treats an absent dependency as satisfied, so a typo'd dep silently
  // UNBLOCKS the ticket instead of holding it — the opposite of what the author meant.
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (!existingIds.has(d)) err(`${id}: depends_on "${d}" which does not exist in data.json or archive.json.`);
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
