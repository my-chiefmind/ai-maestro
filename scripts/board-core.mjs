/**
 * board-core.mjs — the one true board validator.
 *
 * Pure functions, no I/O, no process.exit — so both the CLI (validate-board.mjs) and the
 * cockpit server can share the exact same integrity rules. A board is never "valid in the
 * UI but invalid on the command line".
 *
 * The validator is archive-aware: a landed ticket moves from data.json to archive.json, so
 * dependency checks and eligibility must count archived tickets as existing + done.
 *
 * It is also plan-aware, but only when handed a plan. The scope gate WARNS here and BLOCKS at
 * pick time (see eligibleTickets): you must be able to jot a ticket before the plan covers it,
 * but nothing may run until someone decides it is in scope.
 */

import { scopeVerdict, planIsGating } from "./plan-core.mjs";

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

// kit-075 §2b: the alias map means the short code isn't always the obvious guess (`frontend`,
// not `fe`) — an unknown-agent error is more useful with a nearest-match hint attached.
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** The closest known code to an unrecognised one, or null if nothing is close enough to be
 * worth suggesting (distance > half the input's length, floor 2 — short codes need an exact
 * near-miss, not a same-length coincidence). */
export function suggestCode(unknown, knownCodes) {
  let best = null;
  let bestDist = Infinity;
  for (const code of knownCodes) {
    const d = levenshtein(unknown, code);
    if (d < bestDist) { bestDist = d; best = code; }
  }
  const threshold = Math.max(2, Math.floor(unknown.length / 2));
  return best && bestDist <= threshold ? best : null;
}

/**
 * Live `todo` tickets ready to run right now: every dependency satisfied (archived, or a live
 * ticket already `done`) and not blocked by a human gate. `archived` only needs `id`s here —
 * an archived ticket is done by definition (it left the board because it landed, or because it
 * carries one of the archive-only terminal states that also make it a satisfied dependency).
 * The single source of truth for "ready" — validateBoard's eligibleCount and the portfolio
 * survey (T-003) both call this rather than keeping their own copy of the rule.
 */
export function eligibleTickets(data, archived = [], opts = {}) {
  const archivedIds = new Set(archived.map((t) => t.id));
  const statusById = new Map((data.tickets ?? []).map((t) => [t.id, t.status]));
  const doneIds = new Set([
    ...archivedIds,
    ...[...statusById.keys()].filter((id) => statusById.get(id) === "done"),
  ]);
  const ready = (data.tickets ?? []).filter(
    (t) =>
      t.status === "todo" &&
      !t.human_gate &&
      (Array.isArray(t.depends_on) ? t.depends_on : []).every((d) => doneIds.has(d))
  );

  // The scope gate, applied at PICK time only. `plan` is opt-in because "is this ticket ready?"
  // and "is this ticket in the plan?" are different questions with different consequences: the
  // validator must keep answering the first about a board you are still drafting, while the
  // orchestrator must never start work the plan doesn't cover. Passing no plan leaves this a
  // no-op, so every existing caller behaves exactly as before.
  if (!opts.plan) return ready;
  return ready.filter((t) => !scopeVerdict(t, opts.plan).blocks);
}

/**
 * Ready-but-out-of-scope tickets: the ones eligibleTickets(…, {plan}) just refused, with the
 * reason. The orchestrator reports these rather than going idle in silence — "nothing to do" and
 * "three things to do, none of them in the plan" demand opposite responses from a human.
 */
export function scopeBlockedTickets(data, archived = [], plan = null) {
  if (!plan) return [];
  const ready = eligibleTickets(data, archived);
  return ready
    .map((t) => ({ ticket: t, verdict: scopeVerdict(t, plan) }))
    .filter((r) => r.verdict.blocks);
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
 * @param {object|null} [opts.plan]    board/plan.json, or null to skip the scope gate entirely
 * @returns {{errors: string[], warnings: string[], eligibleCount: number, scopeBlocked: string[]}}
 */
export function validateBoard(data, opts = {}) {
  const { archived = [], archivedEpics = [], agentCodes = null, config = null, plan = null } = opts;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!Array.isArray(data?.epics)) err("Missing or non-array `epics`.");
  if (!Array.isArray(data?.tickets)) err("Missing or non-array `tickets`.");
  if (errors.length) return { errors, warnings, eligibleCount: 0, scopeBlocked: [] };

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
    for (const field of ["dev_runtime", "reviewer_runtime", "dev_model", "reviewer_model"]) {
      if (t[field] !== undefined && (typeof t[field] !== "string" || !t[field].trim())) {
        err(`archive ${id}: ${field} must be a non-empty string.`);
      }
    }
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
    for (const field of ["dev_runtime", "reviewer_runtime", "dev_model", "reviewer_model"]) {
      if (t[field] !== undefined && (typeof t[field] !== "string" || !t[field].trim())) {
        err(`${id}: ${field} must be a non-empty string.`);
      }
    }
    const effectiveDevRuntime = t.dev_runtime || config?.crossReview?.dev?.runtime;
    const effectiveReviewerRuntime = t.reviewer_runtime || config?.crossReview?.reviewer?.runtime;
    const hasCrossReview = [t.dev_runtime, t.dev_model, t.reviewer_runtime, t.reviewer_model,
      config?.crossReview?.dev?.runtime, config?.crossReview?.dev?.model,
      config?.crossReview?.reviewer?.runtime, config?.crossReview?.reviewer?.model].some(Boolean);
    if (hasCrossReview && (!effectiveDevRuntime || !effectiveReviewerRuntime)) {
      warn(`${id}: cross-review needs both a developer runtime and a reviewer runtime (on the ticket or in config.crossReview).`);
    }
    // Runtimes are project-defined in the canonical board. An adapter that is explicitly
    // disabled is suspicious; an absent target key means the renderer's default applies.
    for (const [field, runtime] of [["dev_runtime", effectiveDevRuntime], ["reviewer_runtime", effectiveReviewerRuntime]]) {
      if (runtime && config?.targets?.[runtime] === false) {
        warn(`${id}: effective ${field} "${runtime}" is not enabled in config.targets — that runtime won't have rendered agent files.`);
      }
    }
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

    if (t.traces_to !== undefined && !Array.isArray(t.traces_to)) err(`${id}: traces_to must be an array of plan item ids.`);
    if (t.scope_exception !== undefined && (typeof t.scope_exception !== "string" || !t.scope_exception.trim())) {
      err(`${id}: scope_exception must be a non-empty reason string — an empty one silently disables the scope gate for this ticket.`);
    }

    if (t.agent_plan) {
      if (!Array.isArray(t.agent_plan)) err(`${id}: agent_plan must be an array.`);
      else if (agentCodes) {
        for (const code of t.agent_plan) {
          if (!agentCodes.has(code) && !TERMINAL.has(code)) {
            const hint = suggestCode(code, agentCodes);
            err(`${id}: agent_plan references unknown agent "${code}".${hint ? ` Did you mean "${hint}"?` : ""}`);
          }
        }
      }
    }

    deps.set(t.id, Array.isArray(t.depends_on) ? t.depends_on : []);
  }

  // A dependency exists if it's a live ticket OR an archived ticket — landed tickets move
  // to archive.json by design, so deps legitimately point into the archive.
  const existingIds = new Set([...ticketIds, ...archivedIds]);

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

  // ── The scope gate (warn here, block at pick time) ──
  // Only once the plan says something. A blank plan gating every ticket would make the fastest
  // fix "delete the plan", which is the opposite of the point.
  const scopeIssues = [];
  if (plan && planIsGating(plan)) {
    for (const t of data.tickets) {
      const v = scopeVerdict(t, plan);
      if (v.state === "exception") {
        warn(`${t.id}: running outside the plan on a scope exception — "${t.scope_exception.trim()}".`);
      } else if (v.blocks) {
        scopeIssues.push(t.id);
        warn(`${t.id}: ${v.reason} The orchestrator will not pick it — add it to the plan (/plan-update) or set scope_exception.`);
      } else if (v.unknown.length) {
        warn(`${t.id}: traces to ${v.unknown.join(", ")}, which the plan no longer defines — re-trace it.`);
      }
    }
    for (const e of data.epics) {
      const ids = Array.isArray(e.traces_to) ? e.traces_to : [];
      if (!ids.length) warn(`Epic ${e.id}: traces to nothing in the plan.`);
    }
  }

  // ── Eligibility sanity ──
  // Counted WITHOUT the scope gate: this number answers "is the dependency graph unstuck?",
  // and folding scope into it would report a perfectly good board as jammed for a reason the
  // dependency-shaped message doesn't explain. Scope gets its own line below.
  const eligible = eligibleTickets(data, archived);
  if (eligible.length === 0) {
    warn("No eligible `todo` ticket right now — the orchestrator will report idle.");
  } else if (scopeIssues.length) {
    const runnable = eligibleTickets(data, archived, { plan }).length;
    if (runnable === 0) {
      warn(`Every eligible ticket is out of the plan's scope (${scopeIssues.join(", ")}) — the orchestrator will refuse them all. Run /plan-update.`);
    }
  }

  return { errors, warnings, eligibleCount: eligible.length, scopeBlocked: scopeIssues };
}
