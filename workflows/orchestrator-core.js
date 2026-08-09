/**
 * AI Maestro — Orchestrator Core
 *
 * Shared orchestration logic, embedded into a project's generated orchestrate workflow by
 * render/sync.mjs (opt-in via config.targets.workflow). Project-specific constants are
 * injected by the generated wrapper via the PROJECT_CONFIG object defined before this file
 * is embedded.
 *
 * DO NOT EDIT the generated copy in a project — edit config.json / context.md and re-run
 * sync. This file is the source of truth (ai-maestro/workflows/orchestrator-core.js).
 *
 * This is a Claude Code Workflow script: `agent()`, `phase()`, `log()`, and `args` are
 * provided by the Workflow runtime. All file/git IO happens through agents — the script
 * itself has no filesystem access, which is what makes every step auditable.
 *
 * Required PROJECT_CONFIG shape (injected by the generated wrapper):
 * {
 *   PROJECT_ROOT: string,  // absolute path to the repo root
 *   BOARD:        string,  // absolute path to board/data.json
 *   ARCHIVE:      string,  // absolute path to board/archive.json
 *   WORKTREES:    string,  // absolute path to the worktree directory
 *   RUNS:         string,  // absolute path to the run-record directory
 *   VALIDATE_CMD: string,  // command that validates the board (run after every board write)
 *   MERGE_STRATEGY: "local-push" | "pr",
 *   PUBLISH_BOARD: boolean, // commit+push board transitions (false = write locally only)
 *   REPO_PATH: { [area]: string },   // area → repo directory (single-repo: all → PROJECT_ROOT)
 *   TEST_CMD:  { [area]: string },   // area → test command
 *   AGENT_TYPE: { [area]: string },  // area → default agent type (fallback when no agent_plan)
 *   AGENTS:    { [code]: { type: string, role: "writer"|"reader" } },
 *   AREA_PLAN: { [area]: string[] }, // optional per-area implementer plans
 *   FIX_AGENT_HINTS: { [code]: string }, // regex strings routing qa-block fixes by file path
 * }
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FIX_LOOPS      = 3;
const MAX_STAGE_ATTEMPTS = 2;
const SCHEMA_VERSION     = 1;

// Pull from injected project config (defined in the wrapper before this embed).
const { PROJECT_ROOT, BOARD, ARCHIVE, WORKTREES, RUNS, VALIDATE_CMD,
        REPO_PATH, TEST_CMD, AGENT_TYPE, AGENTS, FIX_AGENT_HINTS } = PROJECT_CONFIG;
// Merge strategy — "pr" (push branch, PR, squash-merge via gh; required for protected
// mains) or "local-push" (local --no-ff merge, then push main). Never local-only.
const MERGE_STRATEGY = PROJECT_CONFIG.MERGE_STRATEGY || "local-push";
// Whether board transitions are committed + pushed (projects that publish their board) or
// only written to disk (projects whose board is local-only — e.g. a private board in a
// public repo). Default: local writes only.
const PUBLISH_BOARD = !!PROJECT_CONFIG.PUBLISH_BOARD;
// Where board/ lives — board transitions are committed here when PUBLISH_BOARD is on.
const BOARD_REPO = BOARD.replace(/[\/\\]board[\/\\][^\/\\]+$/, "");

// Board write epilogue, appended to every agent prompt that edits the board: validate, and
// publish only when the project opts in.
const BOARD_EPILOGUE = `
  After writing the board, VERIFY it: run \`${VALIDATE_CMD}\` — if it reports errors, fix the
  write (or revert to the previous content) and report what happened; an invalid board must
  never be left on disk.${PUBLISH_BOARD ? `
  Then publish the transition:
    git -C ${BOARD_REPO} add ${BOARD} ${ARCHIVE} && git -C ${BOARD_REPO} commit -m "board: transition" && git -C ${BOARD_REPO} push
  If the commit or push fails, report it — an unpublished transition does not count as recorded.` : `
  Do NOT commit or push the board — this project keeps its board data local (PUBLISH_BOARD=false).`}`;

// ── Schemas ───────────────────────────────────────────────────────────────────

export const meta = {
  name: "orchestrate",
  description:
    "Plan-driven multi-stage orchestrator: ONE ticket, ONE worktree, ONE active writer. " +
    "Derives a per-ticket agent plan, runs stages under a writer lease (qa/pd are read-only), " +
    "validates a structured handoff from each agent, enforces the security/release gates, and " +
    "owns the terminal merge + archive. State of record lives in the run-record directory. " +
    "Verbs via args: 'start <id>' | 'status <id>' | 'resume <id>' | 'abort <id>'. " +
    "Empty args = pick the next unblocked TODO ticket. BACKLOG SAFEGUARD: only TODO tickets are auto-picked.",
  phases: [
    { title: "Route",   detail: "Parse args verb; load board / run-record" },
    { title: "Plan",    detail: "Resolve the agent plan from agent_plan or area" },
    { title: "Execute", detail: "Iterate stages under a single writer lease" },
    { title: "Deliver", detail: "qa + pd gates, merge, archive, cleanup" },
  ],
};

const BOARD_SCHEMA = {
  type: "object",
  required: ["epics", "tickets"],
  properties: {
    epics: { type: "array" },
    tickets: { type: "array" },
    archiveTickets: { type: "array", items: { type: "object" } },
  },
};

const TICKET_PICK_SCHEMA = {
  type: "object",
  required: ["ticketId", "reason", "repoPath", "area"],
  properties: {
    ticketId:  { type: "string" },
    reason:    { type: "string" },
    repoPath:  { type: "string" },
    area:      { type: "string" },
    blockers:  { type: "array", items: { type: "string" } },
  },
};

const HANDOFF_SCHEMA = {
  type: "object",
  required: ["status", "summary", "filesChanged", "testsRun", "decisions", "risks", "recommendedNextAgent"],
  properties: {
    status:                 { type: "string", enum: ["done", "blocked", "error", "ship", "block"] },
    agentCode:              { type: "string" },
    summary:                { type: "string" },
    filesChanged:           { type: "array", items: { type: "string" } },
    testsRun:               { type: "array", items: { type: "string" } },
    commit:                 { type: ["string", "null"] },
    decisions:              { type: "array", items: { type: "string" } },
    risks:                  { type: "array", items: { type: "string" } },
    recommendedNextAgent:   { type: ["string", "null"] },
    blockerDesc:            { type: "string" },
    findings:               { type: "array", items: { type: "string" } },
    leasedTs:               { type: ["string", "null"] },
    // Dedicated reviewer gate verdicts. qa sets securityReview; pd sets releaseGate.
    // Persisted to record.gates and enforced at merge.
    securityReview:         { type: "string", enum: ["ship", "block", "n/a"] },
    releaseGate:            { type: "string", enum: ["go", "no-go"] },
  },
};

// T-008 AC1: a writer's "done" is only credible with a commit. Same shape as
// HANDOFF_SCHEMA but `commit` is REQUIRED and must be a non-empty string — an uncommitted
// worktree is not a valid handoff state (a concurrent reset would destroy the work, and
// once did, 60 seconds shy of unrecoverable). Readers keep the base schema: they don't commit.
const WRITER_HANDOFF_SCHEMA = {
  ...HANDOFF_SCHEMA,
  required: [...HANDOFF_SCHEMA.required, "commit"],
  properties: {
    ...HANDOFF_SCHEMA.properties,
    commit: { type: ["string", "null"], description: "REQUIRED for status=done: the SHA of the commit holding this stage's work." },
  },
};

const WORKTREE_VERIFICATION_SCHEMA = {
  type: "object",
  required: ["clean", "newCommits", "commitExists"],
  properties: {
    clean:        { type: "boolean" },
    newCommits:   { type: "integer" },
    commitExists: { type: "boolean" },
  },
};

const RUN_RECORD_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "ticket", "branch", "worktree", "status", "stage",
             "plan", "completedStages", "handoffs", "ownedFiles", "writerLease", "fixLoops"],
  properties: {
    schemaVersion:   { type: "integer" },
    ticket:          { type: "string" },
    epicId:          { type: "string" },
    name:            { type: "string" },
    desc:            { type: "string" },
    area:            { type: "string" },
    repoPath:        { type: "string" },
    testCmd:         { type: "string" },
    branch:          { type: "string" },
    worktree:        { type: "string" },
    status:          { type: "string", enum: ["running", "blocked", "aborted", "done", "idle"] },
    stage:           { type: "integer" },
    plan:            { type: "array", items: { type: "string" } },
    completedStages: { type: "array", items: { type: "string" } },
    activeAgent:     { type: "string" },
    nextAgent:       { type: "string" },
    writerLease: {
      type: "object",
      required: ["holder", "stageIndex", "acquiredTs", "staleAfterStages"],
      properties: {
        holder:           { type: ["string", "null"] },
        stageIndex:       { type: "integer" },
        acquiredTs:       { type: ["string", "null"] },
        staleAfterStages: { type: "integer" },
      },
    },
    ownedFiles:      { type: "object" },
    handoffs:        { type: "array", items: { type: "object" } },
    blockerTicket:   { type: "string" },
    fixLoops:        { type: "integer" },
  },
};

const OUTCOME_SCHEMA = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome:      { type: "string", enum: ["done", "blocked", "idle", "merge-failed", "aborted", "status"] },
    ticketId:     { type: "string" },
    branch:       { type: "string" },
    merged:       { type: "boolean" },
    blockerTicket:{ type: "string" },
    blockerDesc:  { type: "string" },
    summary:      { type: "string" },
  },
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Resolve legacy dep key variants to a normalized array. Writers emit only `depends_on`.
function resolveDeps(ticket) {
  return ticket.depends_on || ticket.dependsOn || ticket.deps || [];
}

// A dependency is met if the referenced ticket is done on the active board OR lives in
// board/archive.json at all — the archive holds finished work in this method (terminal
// states are archive-only), so presence there counts as satisfied.
function depsMet(ticket, board) {
  const deps = resolveDeps(ticket);
  if (!deps.length) return true;
  return deps.every(depId => {
    const active = board.tickets.find(t => t.id === depId);
    if (active) return active.status === "done";
    return (board.archiveTickets || []).some(t => t.id === depId);
  });
}

// Human gates are explicit board data. A ticket is gated iff it declares a non-empty
// human_gate (a phrase from the project's configured humanGates vocabulary). Never a
// substring match over name/desc — that gated tickets that merely mentioned a gate phrase.
function ticketIsHumanGated(ticket) {
  return typeof ticket.human_gate === "string" && ticket.human_gate.trim().length > 0;
}

// A placeholder test command means no real verification is configured (the fallback
// "no test command configured"). Distinct from intentional per-area no-test commands like
// "echo 'no tests for docs area'", which do NOT contain "configured".
function isPlaceholderTestCmd(cmd) {
  return typeof cmd === "string" && /\bno\b.*\btest\b.*\bconfigured\b/i.test(cmd);
}

function pickNextTicket(board) {
  // BACKLOG SAFEGUARD: only picks from "todo". NEVER auto-promotes backlog.
  const todos = board.tickets.filter(t =>
    t.status === "todo" && depsMet(t, board) && !ticketIsHumanGated(t)
  );
  if (todos.length === 0) return null;
  const priorities = ["P0", "P1", "P2", "P3"];
  for (const p of priorities) {
    const atPriority = todos.filter(t => t.priority === p);
    if (atPriority.length > 0) return atPriority[0];
  }
  return todos[0];
}

function nextTicketId(board) {
  // Numeric-suffix ids (T-012, tl-045, …): next = max + 1 in the same width.
  const ids = board.tickets
    .concat(board.archiveTickets || [])
    .map(t => {
      const m = t.id.match(/(\d+)$/);
      return m ? parseInt(m[1], 10) : NaN;
    })
    .filter(n => !isNaN(n));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return `T-${String(max + 1).padStart(3, "0")}`;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

function recordPath(id) { return `${RUNS}/${id}.json`; }

function stageAgentType(code) {
  const a = AGENTS[code];
  if (!a) throw new Error(`unknown agent code: ${code}`);
  return a.type;
}
function isWriter(code) { return !!AGENTS[code] && AGENTS[code].role === "writer"; }
function isReader(code) { return !!AGENTS[code] && AGENTS[code].role === "reader"; }

// Default ordered implementer sequence per area (implementation stages only; terminal gates
// appended by resolvePlan).
function defaultPlanForArea(area) {
  const impl = (AGENT_TYPE && AGENT_TYPE[area])
    ? [Object.keys(AGENTS).find(k => AGENTS[k].type === AGENT_TYPE[area]) || "pe"]
    : ["pe"];
  const areaPlan = (PROJECT_CONFIG.AREA_PLAN || {})[area];
  return areaPlan || impl;
}

// Canonical field wins (agent_plan), then legacy alias (agentPlan).
// Always end qa -> pd -> merge exactly once.
function resolvePlan(ticket) {
  const explicit =
    Array.isArray(ticket.agent_plan) ? ticket.agent_plan :
    Array.isArray(ticket.agentPlan)  ? ticket.agentPlan  : null;
  let plan = (explicit && explicit.length) ? explicit.slice() : defaultPlanForArea(ticket.area);
  for (const term of ["qa", "pd", "merge"]) {
    plan = plan.filter(c => c !== term);
    plan.push(term);
  }
  return plan;
}

function leaseAcquire(record, code) {
  record.writerLease = {
    holder: stageAgentType(code),
    stageIndex: record.stage,
    acquiredTs: null,
    staleAfterStages: 1,
  };
  record.activeAgent = stageAgentType(code);
}
function leaseRelease(record) {
  record.writerLease = { holder: null, stageIndex: record.stage, acquiredTs: null, staleAfterStages: 1 };
}
function leaseIsStale(record) {
  const L = record.writerLease;
  return !!L.holder && (record.stage - L.stageIndex) > L.staleAfterStages;
}

// Choose the fix agent for a qa BLOCK from the finding's files.
// NEVER returns a reader (qa/pd). Must be a writer present in the plan.
function fixAgentForFindings(record, handoff) {
  const files = (handoff.filesChanged || []).concat(handoff.findings || []);
  const hints = FIX_AGENT_HINTS || {};
  const planWriters = record.plan.filter(isWriter);

  // hints is { agentCode: regexString } — the first hint whose pattern matches a touched
  // file wins, provided that writer is actually in the plan.
  for (const [code, pattern] of Object.entries(hints)) {
    if (!pattern || !planWriters.includes(code)) continue;
    const re = new RegExp(pattern);
    if (files.some(f => re.test(f))) return code;
  }

  if (planWriters.includes("pe")) return "pe";
  return planWriters[0] || "pe";
}

function lastSummary(record) {
  const h = record.handoffs[record.handoffs.length - 1];
  return h ? h.summary : "";
}

// ── Writer-lease enforcement (T-008) ──────────────────────────────────────────
// The lease convention was documented and modelled but nothing enforced it; a live
// two-writer collision produced a false `blocked` verdict on green work. These two pure
// rules are the enforcement core — the engine applies them, tests pin them.

// T-008 AC1: reject a writer's "done" handoff unless the work is actually, verifiably
// committed. `verification` comes from a read-only git check of the worktree (see
// verifyWriterState). Returns a human-readable rejection reason, or null to accept.
function writerHandoffRejection(handoff, verification) {
  if (!handoff || handoff.status !== "done") return null; // blocked/error take other paths
  if (!handoff.commit) {
    return "handoff has no commit SHA — an uncommitted worktree is not a valid handoff state";
  }
  if (!verification.commitExists) {
    return `handoff names commit ${handoff.commit} but the worktree branch does not contain it`;
  }
  if (!verification.clean) {
    return "worktree has uncommitted changes after the handoff — commit everything before handing off";
  }
  if (verification.newCommits < 1) {
    return "worktree branch has no new commits vs its base — nothing was actually handed off";
  }
  return null;
}

// T-008 AC2/AC3: a process may only touch a worktree whose lease is free or its own.
// `record` is the run record as read FRESH from disk (not from memory — the whole point is
// catching a concurrent process), `expectedHolder` is who is asking (null = a reader/gate,
// which requires the lease to be fully free). Returns a conflict reason, or null.
function leaseConflict(record, expectedHolder) {
  const holder = record && record.writerLease && record.writerLease.holder;
  if (!holder) return null;
  if (expectedHolder && holder === expectedHolder) return null;
  return `writer lease is held by "${holder}" — do not run anything in this worktree until the lease is released`;
}

// The reviewer gate verdicts must be POSITIVE before a merge is allowed. The qa stage owns
// the security-review gate (record.gates.securityReview) and the pd stage owns the release
// gate (record.gates.releaseGate). Reviewers can return status="ship" overall while still
// flagging a problem in these dedicated verdicts, so the merge decision reads the verdicts
// directly instead of trusting status alone. A gate whose reviewer is in the plan but whose
// verdict is absent fails CLOSED — an ungated merge is exactly the hole this closes.
// Returns a human-readable block reason, or null when every relevant gate passes.
function mergeGateBlock(record) {
  const gates = record.gates || {};
  const plan = record.plan || [];
  if (plan.includes("qa")) {
    const sr = gates.securityReview;
    if (sr !== "ship" && sr !== "n/a") {
      return `security-review gate not satisfied (securityReview=${sr ?? "missing"}); merge blocked`;
    }
  }
  if (plan.includes("pd")) {
    const rg = gates.releaseGate;
    if (rg !== "go") {
      return `release gate not satisfied (releaseGate=${rg ?? "missing"}); merge blocked`;
    }
  }
  return null;
}

// Deterministic board preflight. Runs before any ticket is started or resumed, over the
// in-memory board only (no agent, no IO), so the gate is reproducible and lives in code —
// not merely in the orchestrator prompt. Mirrors the validator's blocking checks. Returns
// an array of hard-error strings; empty means the board is safe to orchestrate.
function preflightBoard(board) {
  const errors = [];
  const tickets = (board && board.tickets) || [];
  const archive = (board && board.archiveTickets) || [];
  // Live statuses (scripts/board-core.mjs STATUSES). Terminal states beyond "done" are
  // archive-only in this method and are invalid on the active board.
  const STATUSES = ["backlog", "todo", "in-progress", "review", "blocked", "done"];

  const seen = new Set();
  for (const t of tickets) {
    if (!t.id) { errors.push("ticket with no id"); continue; }
    if (seen.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    seen.add(t.id);
    if (t.status && !STATUSES.includes(t.status)) errors.push(`${t.id}: unknown status "${t.status}"`);
    for (const code of (t.agent_plan || t.agentPlan || [])) {
      if (code !== "merge" && !AGENTS[code]) errors.push(`${t.id}: unknown agent code "${code}" in agent_plan`);
    }
  }

  const epicSeen = new Set();
  for (const e of (board.epics || [])) {
    if (e.id && epicSeen.has(e.id)) errors.push(`duplicate epic id: ${e.id}`);
    if (e.id) epicSeen.add(e.id);
  }

  const known = new Set([...tickets.map(t => t.id), ...archive.map(t => t.id)]);
  for (const t of tickets) {
    for (const dep of resolveDeps(t)) {
      if (dep === t.id) errors.push(`${t.id}: depends on itself`);
      else if (!known.has(dep)) errors.push(`${t.id}: depends on missing ticket "${dep}"`);
    }
  }

  // Cycle detection over active tickets (back-edge to a node still on the stack).
  const byId = new Map(tickets.map(t => [t.id, t]));
  const state = new Map(); // 0 = visiting, 1 = done
  const visit = (id, stack) => {
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) { errors.push(`dependency cycle: ${[...stack, id].join(" → ")}`); return; }
    state.set(id, 0);
    const t = byId.get(id);
    if (t) for (const dep of resolveDeps(t)) if (byId.has(dep)) visit(dep, [...stack, id]);
    state.set(id, 1);
  };
  for (const t of tickets) if (!state.has(t.id)) visit(t.id, []);

  return errors;
}

// Ticket-inflation telemetry. ADVISORY ONLY — fuzzy heuristics that false-positive, so the
// result never blocks a run; it is surfaced as informational warnings alongside the
// deterministic preflight. Pure (board in, warnings out).
function boardInflationReport(board) {
  const warnings = [];
  const tickets = ((board && board.tickets) || []).filter(t => t.status !== "done");
  const text = (t) => `${t.name || ""} ${t.desc || ""}`;

  const blockers = tickets.filter(t => /^blocker[:\s-]/i.test(t.name || ""));
  if (blockers.length >= 3) {
    warnings.push(`ticket inflation: ${blockers.length} BLOCKER tickets — collapse coordination blockers into their parent unless they unlock separate ownership (${blockers.slice(0, 4).map(t => t.id).join(", ")}…)`);
  }

  const verifyOnly = tickets.filter(t => /^(verify|verification|smoke[\s-]?test|qa)\b/i.test((t.name || "").trim()));
  if (verifyOnly.length) {
    warnings.push(`ticket inflation: ${verifyOnly.length} verification-only ticket(s) — fold verification into the parent's acceptance criteria unless it is a standalone release gate (${verifyOnly.map(t => t.id).join(", ")})`);
  }

  const docsOnly = tickets.filter(t => t.area === "docs" || /^(docs?|documentation|write[\s-]?docs)\b/i.test((t.name || "").trim()));
  if (docsOnly.length) {
    warnings.push(`ticket inflation: ${docsOnly.length} docs-only ticket(s) — keep docs with the parent unless the doc itself is the deliverable (${docsOnly.map(t => t.id).join(", ")})`);
  }

  const migrations = tickets.filter(t => /\b(migrat|refactor)/i.test(text(t)) && !/fan-?out/i.test(text(t)));
  if (migrations.length >= 2) {
    warnings.push(`ticket inflation: ${migrations.length} migration/refactor ticket(s) without a stated fan-out budget — cap fan-out up front (${migrations.slice(0, 4).map(t => t.id).join(", ")}…)`);
  }

  return warnings;
}

// ── Agent-wrapped IO ──────────────────────────────────────────────────────────

async function readBoard() {
  return await agent(
    `Read ${BOARD} as the active board and ${ARCHIVE} as the archive. Return the active board's epics and tickets arrays plus archiveTickets containing every archived ticket. If a file is absent or empty, use an empty array. Do not treat a missing dependency as archived.`,
    { label: "read-board", schema: BOARD_SCHEMA }
  );
}

async function readRecord(id) {
  return await agent(
    `Read the JSON file at ${recordPath(id)} and return its full content as a structured object. If the file does NOT exist, return an object with schemaVersion=${SCHEMA_VERSION}, ticket="", branch="", worktree="", status="idle", stage=0, plan=[], completedStages=[], handoffs=[], ownedFiles={}, fixLoops=0, and writerLease={holder:null,stageIndex:0,acquiredTs:null,staleAfterStages:1}. Do NOT modify the file.`,
    { label: `read-run-${id || "none"}`, schema: RUN_RECORD_SCHEMA }
  );
}

async function writeRecord(record) {
  const json = JSON.stringify(record);
  await agent(
    `Create the directory ${RUNS} if missing, then overwrite the file at ${recordPath(record.ticket)} with EXACTLY this JSON (do not add, drop, reorder, or reformat fields), then read it back and return the parsed object to confirm:\n${json}`,
    { label: `write-run-${record.ticket}`, schema: RUN_RECORD_SCHEMA }
  );
}

async function markBoard(id, status, coord) {
  const coordLine = coord
    ? ` Also set these coordination fields on the ticket (create them if absent, preserve all other fields): execution_mode="${coord.executionMode}", agent_plan=${JSON.stringify(coord.agentPlan)}, currentAgent="${coord.currentAgent}", nextAgent="${coord.nextAgent}".`
    : "";
  await agent(
    `Update the board file at ${BOARD}: set the status of ticket ${id} to "${status}", preserving every other field and every other ticket exactly.${coordLine} Write the full updated JSON back to the file.
${BOARD_EPILOGUE}
  Return the updated ticket object.`,
    { label: `board-${id}-${status}` }
  );
}

// Terminal transition: in this method, finished work leaves the active board. The ticket
// moves to board/archive.json with status "done" (the land-and-archive convention), so the
// active board never carries a terminal state the validator would reject.
async function archiveTicketDone(record) {
  await agent(
    `Land ticket ${record.ticket} on the board, following the land-and-archive convention:
  1. Read ${BOARD} and ${ARCHIVE}.
  2. Remove ticket ${record.ticket} from the active board's tickets array (preserve every other ticket and epic exactly).
  3. Append the removed ticket object to the archive's tickets array with: status="done", done_at=<today's date, YYYY-MM-DD>, evidence="merged branch ${record.branch}: ${String(lastSummary(record)).replace(/"/g, "'").slice(0, 300)}". Preserve its other fields.
  4. Write both files back.
${BOARD_EPILOGUE}
  Return a short confirmation naming the archived ticket id.`,
    { label: `archive-${record.ticket}` }
  );
}

// T-008 AC1: read-only git audit of a writer's handoff claim. Never trusts the handoff —
// checks the worktree itself. Every command here is non-mutating on purpose: this runs in
// a worktree the engine does not hold the lease on (the writer just released it).
async function verifyWriterState(record, handoff) {
  return await agent(
    `Verify the state of the worktree at ${record.worktree} after a writer handoff. Run ONLY these read-only commands (do NOT run anything that writes — no checkout, reset, clean, fix, or formatters):
       git -C ${record.worktree} status --porcelain          # clean = empty output
       git -C ${record.worktree} rev-list --count origin/main..HEAD   # newCommits
       ${handoff.commit ? `git -C ${record.worktree} merge-base --is-ancestor ${handoff.commit} HEAD && echo COMMIT_OK || echo COMMIT_MISSING` : `echo COMMIT_MISSING   # the handoff named no commit`}
     Return: clean (boolean — status output was empty), newCommits (the count), commitExists (boolean — COMMIT_OK).`,
    { label: `verify-handoff-${record.ticket}`, schema: WORKTREE_VERIFICATION_SCHEMA }
  );
}

// T-008 AC2: the on-disk run record is the shared lease state across processes. Re-read it
// and refuse to touch the worktree while another writer holds the lease — the in-memory
// copy can't see a concurrent orchestrator or a live developer agent.
async function preflightLease(ticketId, expectedHolder) {
  const onDisk = await readRecord(ticketId);
  return leaseConflict(onDisk, expectedHolder);
}

async function confirmTicket(ticket, repoPath, agentType, branch) {
  return await agent(
    `Confirm this ticket selection for the orchestrate workflow:
  Ticket: ${ticket.id} — ${ticket.name}
  Desc: ${ticket.desc}
  Area: ${ticket.area}, Priority: ${ticket.priority}, Swag: ${ticket.swag}
  Repo: ${repoPath}
  Agent: ${agentType}
  Branch: ${branch}

  Check if there are any obvious blockers (missing dependencies, human approval required before code can be written). Do NOT flag test command wording, agent assignments, or implementation details as blockers — only flag things that make it impossible to begin implementation. Return ticketId, reason (why this ticket is a good next pick), repoPath, area, and any blockers found.`,
    { label: "ticket-confirmation", schema: TICKET_PICK_SCHEMA }
  );
}

async function setupWorktree(repoPath, worktreePath, branch) {
  await agent(
    `Set up an isolated git worktree for the orchestrate workflow. The target repo is at ${repoPath}.

  Run these steps in order, and STOP/report if any fails:
  1. Confirm the primary checkout is on main:
       git -C ${repoPath} rev-parse --abbrev-ref HEAD   # must print "main"; if not, git -C ${repoPath} checkout main
  2. Clean up any stale residue from a previous run:
       git -C ${repoPath} worktree remove ${worktreePath} --force  2>/dev/null || true
       git -C ${repoPath} branch -D ${branch}  2>/dev/null || true
  3. Fetch and create the worktree off the remote main:
       git -C ${repoPath} fetch origin
       git -C ${repoPath} worktree add ${worktreePath} -b ${branch} origin/main
  4. Copy the local .env into the worktree so tests don't fail on missing config:
       cp ${repoPath}/.env ${worktreePath}/.env  2>/dev/null || true
  5. Verify: the worktree dir exists and HEAD is ${branch}:
       git -C ${worktreePath} rev-parse --abbrev-ref HEAD   # must print "${branch}"
  6. Re-confirm the PRIMARY checkout is still on main:
       git -C ${repoPath} rev-parse --abbrev-ref HEAD   # must still print "main"

  Return a short confirmation that the worktree at ${worktreePath} is on branch ${branch} and the primary checkout is on main.`,
    { label: `worktree-setup-${branch}` }
  );
}

async function verifyWorktree(repoPath, worktreePath, branch) {
  const res = await agent(
    `Verify an existing git worktree is intact for a resume. Run:
       git -C ${repoPath} worktree list
       git -C ${worktreePath} rev-parse --abbrev-ref HEAD   # should print "${branch}"
       test -d ${worktreePath} && echo DIR_OK || echo DIR_MISSING
     Return a one-line text answer that starts with "OK" if the worktree exists AND is on branch ${branch}, otherwise starts with "MISSING".`,
    { label: `verify-worktree-${branch}` }
  );
  return typeof res === "string" && res.trim().toUpperCase().startsWith("OK");
}

async function mergeAgent(repoPath, worktreePath, branch, id, name) {
  // Two strategies, both end PUSHED — a local-only merge is not done.
  const prFlow = `Land branch "${branch}" via a PULL REQUEST (protected main — never merge locally), then tear down the isolated worktree.

  Instructions:
  1. git -C ${worktreePath} push -u origin ${branch}
  2. From ${worktreePath}: gh pr create --head ${branch} --title "${name} (${id})" --body "Automated orchestrator delivery for ticket ${id}."
  3. From ${worktreePath}: gh pr merge ${branch} --squash --delete-branch — if required checks are pending, wait (gh pr checks ${branch} --watch); if checks FAIL or the merge is refused, return status="conflict" with the failing check/conflict details and STOP — do NOT remove the worktree.
  4. If the PR merges:
       git -C ${repoPath} checkout main && git -C ${repoPath} pull --ff-only
       git -C ${repoPath} worktree remove ${worktreePath} --force
       git -C ${repoPath} branch -D ${branch} 2>/dev/null || true
  5. Confirm: git -C ${repoPath} rev-parse --abbrev-ref HEAD   # must print "main", up to date with origin/main
  6. Return status="merged" with the squash-merge commit SHA and PR number, or status="conflict" with details.`;

  const localFlow = `Merge branch "${branch}" into main in the PRIMARY checkout at ${repoPath}, PUSH it, then tear down the isolated worktree.

  Instructions:
  1. git -C ${repoPath} checkout main && git -C ${repoPath} pull --ff-only
  2. git -C ${repoPath} merge --no-ff ${branch} -m "Merge ${id}: ${name}"
  3. If there are conflicts: return status="conflict" and list the conflicting files. Abort the merge and STOP — do NOT remove the worktree.
  4. If merge succeeds:
       git -C ${repoPath} push origin main    # REQUIRED — a local-only merge is not done
       git -C ${repoPath} worktree remove ${worktreePath} --force
       git -C ${repoPath} branch -D ${branch}
  5. Confirm the primary checkout is on main and pushed:
       git -C ${repoPath} rev-parse --abbrev-ref HEAD   # must print "main"
       git -C ${repoPath} rev-list --count origin/main..main   # must print 0 after push
  6. If the push is rejected (protected branch / non-fast-forward): return status="conflict" with the rejection — do NOT force-push.
  7. Return status="merged" with the merge commit SHA, or status="conflict" with details.`;

  return await agent(MERGE_STRATEGY === "pr" ? prFlow : localFlow, { label: `merge-${id}` });
}

// ── Blocker / terminal helpers ────────────────────────────────────────────────

async function idleReport(board) {
  const outcome = await agent(
    `The board has no todo tickets. Count: todo=${board.tickets.filter(t=>t.status==="todo").length}, in-progress=${board.tickets.filter(t=>t.status==="in-progress").length}, blocked=${board.tickets.filter(t=>t.status==="blocked").length}, backlog=${board.tickets.filter(t=>t.status==="backlog").length}. Return outcome="idle" with a summary of the board state.`,
    { label: "idle-report", schema: OUTCOME_SCHEMA }
  );
  log(`Board is idle: ${outcome.summary}`);
  return outcome;
}

async function blockTicket(record, board, desc, tag, blockerArea, blockerAgent) {
  const blockerId = nextTicketId(board);
  const area = blockerArea || record.area || "";
  const outcome = await agent(
    `Ticket ${record.ticket} is blocked (${tag}): ${desc}

    VERIFY BEFORE FILING (T-008 AC4) — run these read-only commands first and include their
    output as evidence in the blocker desc. An agent must never declare work lost, destroyed,
    or missing without checking git:
       git -C ${record.repoPath} branch --list ${record.branch}
       git -C ${record.repoPath} log -5 --oneline ${record.branch} --  2>/dev/null || true
       git -C ${record.worktree} status --porcelain  2>/dev/null || echo WORKTREE_GONE
       git -C ${record.repoPath} reflog --date=iso -10  2>/dev/null | head -10
    If this blocker claims work was lost/destroyed but the branch shows the commits, DO NOT
    file it as written — report the discrepancy as the finding instead (the work exists; the
    coordination failed).

    Update the board file at ${BOARD}, preserving every other field/ticket exactly:
    1. Set ticket ${record.ticket} status to "blocked"
    2. Add a new blocker ticket: id="${blockerId}", name="BLOCKER: ${record.ticket} ${tag}", desc="${desc}", epicId="${record.epicId}", area="${area}", priority="P0", swag="S", status="blocked", depends_on=[]
${BOARD_EPILOGUE}
    Then clean up the isolated worktree (the work is preserved on branch ${record.branch}):
       git -C ${record.repoPath} worktree remove ${record.worktree} --force  2>/dev/null || true
    Confirm ${record.repoPath} is on main afterward.

    Return outcome="blocked", ticketId="${record.ticket}", blockerTicket="${blockerId}", blockerDesc="${desc}", summary.`,
    { label: `block-${record.ticket}-${tag}`, schema: OUTCOME_SCHEMA }
  );
  record.status = "blocked";
  record.blockerTicket = blockerId;
  leaseRelease(record);
  await writeRecord(record);
  log(`Blocked: ${record.ticket} (${tag}) — blocker ${blockerId} created`);
  return outcome;
}

async function mergeFailed(record, board, detail) {
  const blockerId = nextTicketId(board);
  const outcome = await agent(
    `Merge of ${record.ticket} failed with conflicts.
    Merge result: ${detail}

    Update board at ${BOARD}, preserving every other field/ticket exactly:
    1. Set ${record.ticket} status to "blocked"
    2. Add blocker: id="${blockerId}", name="BLOCKER: ${record.ticket} merge-conflict", desc="Merge conflict on branch ${record.branch}: ${detail}", epicId="${record.epicId}", area="${record.area || ""}", priority="P0", swag="S", status="blocked", depends_on=[]
${BOARD_EPILOGUE}
    Leave the worktree at ${record.worktree} intact for conflict inspection.

    Return outcome="merge-failed", ticketId="${record.ticket}", branch="${record.branch}", blockerTicket="${blockerId}", blockerDesc, summary.`,
    { label: `merge-failed-${record.ticket}`, schema: OUTCOME_SCHEMA }
  );
  record.status = "blocked";
  record.blockerTicket = blockerId;
  await writeRecord(record);
  log(`Merge failed for ${record.ticket} — blocker ${blockerId} created`);
  return outcome;
}

// ── Stage runner ──────────────────────────────────────────────────────────────

async function runStage(record, code) {
  const type = stageAgentType(code);
  const writer = isWriter(code);
  const priorHandoffs = JSON.stringify(record.handoffs.slice(-6));
  const leaseLine = writer
    ? `You HOLD THE WRITER LEASE for this task. You are the ONLY agent that may edit files right now.`
    : `You are a READ-ONLY reviewer (no writer lease). Do NOT edit any files — inspect the worktree diff and report only.
  READ-ONLY means read-only (T-008): never run a mutating command in this worktree — no git reset/clean/checkout/commit, no --fix, no formatters. Run linters in check mode. If the test command itself mutates state, say so in risks[] rather than working around it.`;

  const workBlock = writer
    ? `Implement/fix your part of the ticket fully. Every file you Write/Edit MUST live under ${record.worktree}.
       1. Confirm the worktree branch: git -C ${record.worktree} rev-parse --abbrev-ref HEAD   # must be ${record.branch}
       2. Read prior handoffs (below) so you build on, not redo, earlier stages.
       3. Do your stage's work. Run tests from ${record.worktree}: ${record.testCmd}
       4. If you changed files, commit them:
            git -C ${record.worktree} add -A
            git -C ${record.worktree} commit -m "feat(${record.ticket}): ${type} stage"
          Then capture the commit: git -C ${record.worktree} log -1 --format=%H,%ct
       5. status="done" on success; "blocked" if you hit a genuine blocker; "error" if tests can't be made to pass.`
    : code === "qa"
      ? `Review the change in the worktree:
       1. git -C ${record.worktree} diff origin/main...HEAD
       2. Look for correctness bugs, security issues, missing error handling, breaking API changes, test gaps.
       3. Run the security-review skill, then run checks from ${record.worktree}: ${record.testCmd}
       4. status="ship" to pass, or "block" with specific file:line findings[] the next agent must fix.
       5. REQUIRED gate verdict — set securityReview="ship" if the security-review skill found no security issue, "block" if it found one (you MUST also status="block" with the finding), or "n/a" if the change has no security-relevant surface. A merge cannot proceed without a positive securityReview.`
      : `Principal-delivery validation in the worktree:
       1. Confirm implementation matches the ticket spec (git -C ${record.worktree} diff origin/main...HEAD).
       2. Verify acceptance criteria, runbook completeness (if applicable), and no hardcoded secrets.
       3. Run the release-gate skill, then run tests from ${record.worktree}: ${record.testCmd}
       4. status="ship" to approve the merge, or "block" with issues in findings[].
       5. REQUIRED gate verdict — set releaseGate="go" to approve release or "no-go" to hold. A merge cannot proceed without releaseGate="go".`;

  let attempt = 0, handoff, retryNote = "";
  while (attempt < MAX_STAGE_ATTEMPTS) {
    attempt++;
    handoff = await agent(
      `You are the ${type} (agent code "${code}") contributing to ONE task in ONE shared worktree. The run record is the source of truth, NOT chat history.

  Ticket: ${record.ticket} — ${record.name}
  Description: ${record.desc}
  Area: ${record.area}   Branch: ${record.branch}
  WORKTREE (do ALL work here; NEVER the primary checkout at ${record.repoPath}): ${record.worktree}
  Test command (run from the worktree root): ${record.testCmd}${isPlaceholderTestCmd(record.testCmd) ? `
  ⚠ PLACEHOLDER test command — no real tests are configured for this ticket. Gate stages (qa, pd) MUST status="block" and require a real test command (set a ticket-level testCmd or configure the area) unless this ticket genuinely has no testable surface.` : ""}
  ${leaseLine}${retryNote}

  Prior handoffs (most recent last; [] if you are first): ${priorHandoffs}

  ${workBlock}

  Do NOT push to remote. Do NOT merge to main. Do NOT edit anything outside ${record.worktree}.

  Return the STRUCTURED HANDOFF: status, agentCode="${code}", summary, filesChanged[], testsRun[], commit (${writer ? "REQUIRED SHA for status=\"done\" — an uncommitted worktree is not a valid handoff" : "SHA or null"}), decisions[], risks[], recommendedNextAgent (an agent code or null), findings[] (for a block), blockerDesc (if blocked), leasedTs (the %ct value from your commit, or null)${code === "qa" ? ", securityReview (REQUIRED: \"ship\" | \"block\" | \"n/a\")" : code === "pd" ? ", releaseGate (REQUIRED: \"go\" | \"no-go\")" : ""}.`,
      { label: `${code}-${record.ticket}-a${attempt}`, schema: writer ? WRITER_HANDOFF_SCHEMA : HANDOFF_SCHEMA }
    );
    if (handoff.status === "error" && attempt < MAX_STAGE_ATTEMPTS) {
      log(`${type} errored (attempt ${attempt}/${MAX_STAGE_ATTEMPTS}) — retrying, worktree kept`);
      continue;
    }
    // T-008 AC1: never trust a writer's "done" — audit the worktree read-only and reject a
    // handoff whose work isn't committed. One retry with the reason spelled out, then block.
    if (writer && handoff.status === "done") {
      const verification = await verifyWriterState(record, handoff);
      const rejection = writerHandoffRejection(handoff, verification);
      if (rejection) {
        log(`✗ ${type} handoff rejected: ${rejection}`);
        if (attempt < MAX_STAGE_ATTEMPTS) {
          retryNote = `\n  ⚠ YOUR PREVIOUS HANDOFF WAS REJECTED BY THE ENGINE: ${rejection}. Fix that — commit ALL work in the worktree and return the real commit SHA.`;
          continue;
        }
        handoff = { ...handoff, status: "blocked", blockerDesc: `writer handoff rejected after ${MAX_STAGE_ATTEMPTS} attempts: ${rejection}` };
      }
    }
    break;
  }

  let outcome = "advance", fixAgent = null;
  if (isReader(code)) {
    // Persist the dedicated gate verdict so the merge decision is auditable and
    // enforceable, independent of the coarse ship/block status.
    record.gates = record.gates || {};
    if (code === "qa" && handoff.securityReview) record.gates.securityReview = handoff.securityReview;
    if (code === "pd" && handoff.releaseGate)    record.gates.releaseGate    = handoff.releaseGate;
    if (handoff.status === "ship") {
      outcome = "advance";
    } else {
      outcome = "fix";
      fixAgent = code === "qa" ? fixAgentForFindings(record, handoff) : "pe";
    }
  } else {
    if (handoff.status === "done")        outcome = "advance";
    else if (handoff.status === "blocked") outcome = "block";
    else                                   outcome = "block";
  }
  return { stageCode: code, outcome, handoff, nextStageIndex: record.stage + 1, fixAgent };
}

// ── Core loop ─────────────────────────────────────────────────────────────────

async function runPlan(record, board) {
  phase("Execute");

  while (record.stage < record.plan.length) {
    const code = record.plan[record.stage];

    if (leaseIsStale(record)) {
      log(`Stale writer lease (${record.writerLease.holder}) — releasing`);
      leaseRelease(record);
      await writeRecord(record);
    }

    const writer = isWriter(code);

    // T-008 AC2/AC3: check the lease ON DISK before touching the worktree — the in-memory
    // copy cannot see a concurrent orchestrator or a live developer agent. A writer stage
    // may proceed when the lease is free or already its own; a reader/gate stage (and the
    // merge) requires it fully free. A conflict fails loudly instead of running mutating
    // commands in someone else's leased worktree — the tl-213 incident, structurally closed.
    const conflict = await preflightLease(record.ticket, writer && code !== "merge" ? stageAgentType(code) : null);
    if (conflict) {
      return await blockTicket(record, board,
        `${conflict} (stage ${code} refused to run; if the holder is a crashed run, resume or abort it first)`,
        "lease-conflict");
    }

    if (code === "merge") { return await doMerge(record, board); }

    if (writer) {
      leaseAcquire(record, code);
      record.nextAgent = record.plan[record.stage + 1] || "";
      await writeRecord(record);
    } else {
      record.activeAgent = stageAgentType(code);
      record.nextAgent = record.plan[record.stage + 1] || "";
    }

    log(`Stage ${record.stage}/${record.plan.length - 1}: ${code} (${stageAgentType(code)})`);
    const step = await runStage(record, code);
    record.handoffs.push(step.handoff);

    if (writer) leaseRelease(record);

    switch (step.outcome) {
      case "advance":
        record.completedStages.push(code);
        record.stage += 1;
        await writeRecord(record);
        break;

      case "fix": {
        record.fixLoops += 1;
        if (record.fixLoops > MAX_FIX_LOOPS) {
          return await blockTicket(
            record, board,
            `${code} BLOCK unresolved after ${MAX_FIX_LOOPS} fix loops: ${(step.handoff.findings || []).join("; ")}`,
            `${code}-failed`
          );
        }
        const fixCode = step.fixAgent || fixAgentForFindings(record, step.handoff);
        record.plan.splice(record.stage, 0, fixCode);
        log(`${code} BLOCK → inserting fix stage "${fixCode}" (fix loop ${record.fixLoops}/${MAX_FIX_LOOPS})`);
        await writeRecord(record);
        break;
      }

      case "block":
        return await blockTicket(
          record, board,
          step.handoff.blockerDesc || (step.handoff.findings || []).join("; ") || step.handoff.summary,
          `${code}-block`
        );
    }
  }
  return await blockTicket(record, board, "plan ended without a merge stage", "plan-error");
}

async function doMerge(record, board) {
  phase("Deliver");
  // Gate enforcement. Even when every reviewer returned status="ship", refuse to merge
  // unless the dedicated security/release verdicts are positive.
  const gateBlock = mergeGateBlock(record);
  if (gateBlock) {
    log(`Merge refused for ${record.ticket}: ${gateBlock}`);
    return await blockTicket(record, board, gateBlock, "gate-block");
  }
  log(`Merging ${record.ticket} (${record.branch}) into ${record.repoPath} main...`);
  const mergeResult = await mergeAgent(record.repoPath, record.worktree, record.branch, record.ticket, record.name);
  const ok = mergeResult && !String(mergeResult).toLowerCase().includes("conflict");
  if (!ok) return await mergeFailed(record, board, mergeResult);

  record.status = "done";
  record.completedStages.push("merge");
  record.stage += 1;
  leaseRelease(record);
  await writeRecord(record);
  await archiveTicketDone(record);

  log(`Done: ${record.ticket} merged + archived — ${lastSummary(record)}`);
  return {
    outcome: "done", ticketId: record.ticket, branch: record.branch,
    merged: true, summary: lastSummary(record),
  };
}

// ── Start / verb entry points ─────────────────────────────────────────────────

async function startTicket(ticket, board) {
  phase("Plan");
  const area      = ticket.area;
  // A ticket may carry its own testCmd, which overrides the area default. Carried into the
  // run record so the release gate verifies THIS ticket, not a single rendered command.
  const repoPath  = REPO_PATH[area] || PROJECT_ROOT;
  const testCmd   = (typeof ticket.testCmd === "string" && ticket.testCmd.trim())
                    || TEST_CMD[area] || "echo 'no test command configured'";
  const agentType = AGENT_TYPE[area] || "principal-engineer";
  const branch    = `feature/${ticket.id.toLowerCase()}-${slugify(ticket.name)}`;
  const worktree  = `${WORKTREES}/${ticket.id}`;
  const plan      = resolvePlan(ticket);

  log(`Planning ${ticket.id} — ${ticket.name} (${ticket.priority}, ${area}); plan: ${plan.join(" → ")}`);

  const pre = await confirmTicket(ticket, repoPath, agentType, branch);
  if (pre.blockers && pre.blockers.length > 0) {
    const blockerId = nextTicketId(board);
    const outcome = await agent(
      `The ticket ${ticket.id} has pre-implementation blockers: ${pre.blockers.join("; ")}.

      Update the board file at ${BOARD}, preserving every other field/ticket exactly:
      1. Set ticket ${ticket.id} status to "blocked"
      2. Add a new blocker ticket: id="${blockerId}", name="BLOCKER: ${ticket.name}", desc="${pre.blockers.join("; ")}", epicId="${ticket.epicId}", area="${area}", priority="P0", swag="S", status="blocked", depends_on=[]
${BOARD_EPILOGUE}
      Return outcome="blocked", ticketId="${ticket.id}", blockerTicket="${blockerId}", blockerDesc="${pre.blockers.join("; ")}", summary.`,
      { label: "create-blocker", schema: OUTCOME_SCHEMA }
    );
    log(`Blocked (pre-impl): ${ticket.id} — blocker ${outcome.blockerTicket}`);
    return outcome;
  }

  await markBoard(ticket.id, "in-progress", {
    executionMode: "multi-agent", agentPlan: plan,
    currentAgent: plan[0] || "", nextAgent: plan[1] || "",
  });

  const record = {
    schemaVersion: SCHEMA_VERSION,
    ticket: ticket.id, epicId: ticket.epicId || "", name: ticket.name, desc: ticket.desc || "",
    area, repoPath, testCmd, branch, worktree,
    status: "running", stage: 0, plan,
    completedStages: [], activeAgent: "", nextAgent: plan[1] || "",
    writerLease: { holder: null, stageIndex: 0, acquiredTs: null, staleAfterStages: 1 },
    ownedFiles: {}, handoffs: [], blockerTicket: "", fixLoops: 0, gates: {},
  };
  await writeRecord(record);

  log(`Setting up isolated worktree for ${ticket.id}...`);
  await setupWorktree(repoPath, worktree, branch);

  return await runPlan(record, board);
}

// Deterministic preflight gate. Returns a blocked outcome (and logs) when the in-memory
// board fails validation, so start/resume fail fast instead of orchestrating against a
// broken board.
function preflightGate(board) {
  const errors = preflightBoard(board);
  if (!errors.length) return null;
  const summary = `preflight board validation failed (${errors.length}): `
    + errors.slice(0, 5).join("; ") + (errors.length > 5 ? " …" : "");
  log(`⛔ ${summary}`);
  return { outcome: "blocked", summary, preflightErrors: errors };
}

// Orchestration-health advisory. Read-only diagnostics run at a wave boundary; warnings
// are logged but NEVER block (the deterministic board gate above is the hard stop).
async function runHealthAdvisory() {
  try {
    const report = await agent(
      `Run the orchestration-health skill (read-only) over ${RUNS} and ${WORKTREES} against the board at ${BOARD}. Do NOT modify anything. Return a one-line summary of ERROR/WARNING counts and the single most important finding, or "healthy" if clean.`,
      { label: "orchestration-health" }
    );
    if (report) log(`orchestration-health: ${String(report).split("\n")[0]}`);
  } catch (e) {
    log(`orchestration-health advisory skipped: ${e && e.message ? e.message : e}`);
  }
}

async function doStartNext() {
  const board = await readBoard();
  const gate = preflightGate(board);
  if (gate) return gate;
  // Advisory ticket-inflation telemetry — logged, never blocking.
  for (const w of boardInflationReport(board)) log(`⚠ ${w}`);
  await runHealthAdvisory();
  const ticket = pickNextTicket(board);
  if (!ticket) return await idleReport(board);
  return await startTicket(ticket, board);
}

async function doStart(id) {
  const board = await readBoard();
  const gate = preflightGate(board);
  if (gate) return gate;
  const ticket = board.tickets.find(t => t.id === id);
  if (!ticket) return { outcome: "idle", summary: `no ticket ${id} on the board` };
  if (ticket.status !== "todo") return { outcome: "blocked", ticketId: id, summary: `ticket ${id} is ${ticket.status}, not todo` };
  if (!depsMet(ticket, board)) return { outcome: "blocked", ticketId: id, summary: `ticket ${id} has missing or incomplete dependencies` };
  if (ticketIsHumanGated(ticket)) return { outcome: "blocked", ticketId: id, summary: `ticket ${id} requires explicit human approval` };
  return await startTicket(ticket, board);
}

async function doStatus(id) {
  const r = await readRecord(id);
  if (r.status === "idle" || !r.ticket) {
    return { outcome: "idle", ticketId: id, summary: `no run record for ${id}` };
  }
  const cur = r.plan[r.stage] || "—";
  return {
    outcome: "status", ticketId: id, branch: r.branch,
    summary: `stage ${r.stage}/${r.plan.length} (${cur}); status=${r.status}; lease=${r.writerLease.holder || "free"}; done=[${r.completedStages.join(",")}]; fixLoops=${r.fixLoops}; handoffs=${r.handoffs.length}`,
  };
}

async function doResume(id) {
  const r = await readRecord(id);
  if (r.status === "idle" || !r.ticket) return { outcome: "idle", ticketId: id, summary: `no run record for ${id}` };
  if (r.status === "done")    return { outcome: "done", ticketId: id, branch: r.branch, merged: true, summary: "already done" };
  if (r.status === "aborted") return { outcome: "blocked", ticketId: id, summary: "run record was aborted; start fresh" };
  if (r.schemaVersion !== SCHEMA_VERSION) {
    const board = await readBoard();
    return await blockTicket(r, board, `run-record schemaVersion ${r.schemaVersion} != ${SCHEMA_VERSION}; manual migration needed`, "schema-mismatch");
  }
  // Deterministic preflight before resuming against the board.
  const resumeGate = preflightGate(await readBoard());
  if (resumeGate) return resumeGate;
  const ok = await verifyWorktree(r.repoPath, r.worktree, r.branch);
  if (!ok) {
    const board = await readBoard();
    return await blockTicket(r, board, `worktree ${r.worktree} missing or not on ${r.branch} on resume`, "resume-worktree");
  }
  r.status = "running";
  if (leaseIsStale(r)) leaseRelease(r);
  await writeRecord(r);
  log(`Resuming ${id} from stage ${r.stage} (${r.plan[r.stage] || "—"})`);
  return await runPlan(r, await readBoard());
}

async function doAbort(id) {
  const r = await readRecord(id);
  if (r.status === "idle" || !r.ticket) return { outcome: "idle", ticketId: id, summary: `no run record for ${id}` };
  r.status = "aborted";
  leaseRelease(r);
  await writeRecord(r);
  await agent(
    `Abort the orchestrate run for ${r.ticket}. Remove the isolated worktree but KEEP the branch for inspection:
       git -C ${r.repoPath} worktree remove ${r.worktree} --force  2>/dev/null || true
     Confirm ${r.repoPath} is on main: git -C ${r.repoPath} rev-parse --abbrev-ref HEAD
     Then update the board at ${BOARD}: set ticket ${r.ticket} status back to "todo" (preserve every other field).
${BOARD_EPILOGUE}
     Return a short confirmation.`,
    { label: `abort-${r.ticket}` }
  );
  log(`Aborted ${id} at stage ${r.stage}; worktree removed, branch ${r.branch} kept`);
  return { outcome: "aborted", ticketId: id, branch: r.branch, summary: `aborted at stage ${r.stage}; worktree removed, branch kept, ticket back to todo` };
}

// ── Entry: parse args verb and dispatch ───────────────────────────────────────

phase("Route");

let verb = "", argTicket = "";
if (typeof args === "string") {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  verb = (tokens[0] || "").toLowerCase();
  argTicket = tokens[1] || "";
} else if (args && typeof args === "object") {
  verb = String(args.command || args.verb || "").toLowerCase();
  argTicket = args.ticket || args.ticketId || "";
}

if (verb === "status" && argTicket) return await doStatus(argTicket);
if (verb === "abort"  && argTicket) return await doAbort(argTicket);
if (verb === "resume" && argTicket) return await doResume(argTicket);
if (verb === "start"  && argTicket) return await doStart(argTicket);
return await doStartNext();
