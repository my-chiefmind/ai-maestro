/**
 * Initiative ownership on the board (T-024).
 *
 * WHY THIS EXISTS: ownership is the rule that keeps `Project → Initiative → Epic → Ticket`
 * honest, and it is enforced in two places with deliberately different force. An epic that has
 * not been assigned yet WARNS in the validator and BLOCKS at pick time — the same split the
 * scope gate uses (scripts/board-core.mjs header), because a board that gains its first
 * initiative would otherwise become invalid on the spot with no way to fix it: every epic is
 * unassigned at that moment, and the plan CLI cannot write a board. A trace wired to another
 * initiative's requirement is never a transitional state, so that ERRORS.
 *
 * Both failure modes are silent without tests. A gate that warns where it should block lets
 * mis-wired work run; one that errors where it should warn bricks a board mid-migration.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBoard, eligibleTickets, scopeBlockedTickets,
  ownershipVerdict, epicOwnershipVerdict, initiativeModeActive,
} from "../scripts/board-core.mjs";
import { assignLanes } from "../scripts/lane-core.mjs";
import { emptyPlan } from "../scripts/plan-core.mjs";

/** A plan with two initiatives, one owned requirement each, and one project-wide NFR. */
function plan({ initiatives = true } = {}) {
  const p = emptyPlan();
  if (initiatives) {
    p.sections.initiatives = [
      { id: "I-1", name: "Onboarding", outcome: "Customers activate", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
      { id: "I-2", name: "Billing", outcome: "Invoices reconcile", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
    ];
  }
  p.sections.functional = [
    { id: "FR-1", ...(initiatives ? { initiativeId: "I-1" } : {}), text: "verify email", verify: "npm test" },
    { id: "FR-2", ...(initiatives ? { initiativeId: "I-2" } : {}), text: "reconcile ledger", verify: "npm test" },
  ];
  p.sections.nonFunctional = [{ id: "NFR-1", text: "No PII in logs", budget: "zero" }];
  return p;
}

const ticket = (over) => ({ status: "todo", agent_plan: ["backend"], area: "backend", model: "sonnet", depends_on: [], ...over });

/** e1 → I-1, e2 → I-2, e3 unassigned. */
function board(over = {}) {
  return {
    epics: [
      { id: "e1", initiativeId: "I-1", name: "Registration", traces_to: ["FR-1"] },
      { id: "e2", initiativeId: "I-2", name: "Ledger", traces_to: ["FR-2"] },
      { id: "e3", name: "Unassigned", traces_to: ["NFR-1"] },
    ],
    tickets: [],
    ...over,
  };
}

// ── Legacy boards are untouched ─────────────────────────────────────────────────

test("a plan with no initiatives leaves the board exactly as it was", () => {
  const legacy = plan({ initiatives: false });
  const b = board({ epics: [{ id: "e1", name: "Registration", traces_to: ["FR-1"] }], tickets: [ticket({ id: "T-1", epicId: "e1", traces_to: ["FR-1"] })] });
  assert.equal(initiativeModeActive(legacy), false);
  const r = validateBoard(b, { plan: legacy });
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => /initiative/i.test(w)), r.warnings.join("\n"));
  assert.deepEqual(eligibleTickets(b, [], { plan: legacy }).map((t) => t.id), ["T-1"]);
});

test("initiative mode turns on only when the plan defines one", () => {
  assert.equal(initiativeModeActive(null), false);
  assert.equal(initiativeModeActive(emptyPlan()), false);
  assert.equal(initiativeModeActive(plan()), true);
});

// ── Unassigned epics: warn, but block the work ──────────────────────────────────

test("an unassigned epic warns and its tickets are refused at pick time", () => {
  const b = board({ tickets: [ticket({ id: "T-1", epicId: "e3", traces_to: ["NFR-1"] })] });
  const r = validateBoard(b, { plan: plan() });
  assert.deepEqual(r.errors, [], "an unassigned epic must never invalidate the board");
  assert.ok(r.warnings.some((w) => /Epic e3: belongs to no initiative/.test(w)), r.warnings.join("\n"));
  assert.deepEqual(eligibleTickets(b, [], { plan: plan() }).map((t) => t.id), [], "blocked at pick time");
  const [blocked] = scopeBlockedTickets(b, [], plan());
  assert.equal(blocked.verdict.state, "unassigned-epic");
  assert.match(blocked.verdict.reason, /maestro ticket edit-epic e3 --initiative/);
});

test("a sample epic seeded by a starter is exempt", () => {
  const b = board({ epics: [{ id: "e9", name: "Sample", sample: true }], tickets: [] });
  const r = validateBoard(b, { plan: plan() });
  assert.ok(!r.warnings.some((w) => /e9.*no initiative/.test(w)));
});

test("an epic naming an initiative the plan does not define is an error", () => {
  const b = board({ epics: [{ id: "e1", initiativeId: "I-9", name: "Ghost", traces_to: ["NFR-1"] }] });
  assert.ok(validateBoard(b, { plan: plan() }).errors.some((e) => /Epic e1: initiativeId "I-9" is not an initiative/.test(e)));
});

// ── Traces must respect ownership ───────────────────────────────────────────────

test("same-initiative and project-wide traces both pass", () => {
  const b = board({ tickets: [
    ticket({ id: "T-1", epicId: "e1", traces_to: ["FR-1"] }),          // own initiative
    ticket({ id: "T-2", epicId: "e1", traces_to: ["NFR-1"] }),         // project-wide
    ticket({ id: "T-3", epicId: "e2", traces_to: ["FR-2", "NFR-1"] }), // both
  ] });
  const r = validateBoard(b, { plan: plan() });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(eligibleTickets(b, [], { plan: plan() }).map((t) => t.id), ["T-1", "T-2", "T-3"]);
});

test("a ticket tracing to another initiative's requirement is an error and is never picked", () => {
  const b = board({ tickets: [ticket({ id: "T-14", epicId: "e2", traces_to: ["FR-1"] })] });
  const errs = validateBoard(b, { plan: plan() }).errors;
  // The message must name all three ways out, or it reads as a dead end.
  assert.ok(errs.some((e) =>
    /T-14 belongs to initiative I-2 through epic e2, but traces to FR-1 owned by I-1\./.test(e) &&
    /Move the ticket\/epic, reassign FR-1, or trace to an I-2\/project-wide item\./.test(e)), errs.join("\n"));
  assert.deepEqual(eligibleTickets(b, [], { plan: plan() }).map((t) => t.id), []);
});

test("an epic tracing across initiatives is an error", () => {
  const b = board({ epics: [{ id: "e1", initiativeId: "I-1", name: "Registration", traces_to: ["FR-2"] }] });
  assert.ok(validateBoard(b, { plan: plan() }).errors.some((e) => /Epic e1 belongs to initiative I-1, but traces to FR-2 owned by I-2/.test(e)));
});

test("a ticket with no epic may trace only to project-wide items", () => {
  const ok = board({ tickets: [ticket({ id: "T-1", traces_to: ["NFR-1"] })] });
  assert.deepEqual(validateBoard(ok, { plan: plan() }).errors, []);
  const bad = board({ tickets: [ticket({ id: "T-2", traces_to: ["FR-1"] })] });
  assert.ok(validateBoard(bad, { plan: plan() }).errors.some((e) => /T-2 has no epic, so it derives no initiative/.test(e)));
});

// ── The archive is not exempt ───────────────────────────────────────────────────

test("an archived epic still resolves its initiative", () => {
  const archivedEpics = [{ id: "eA", initiativeId: "I-9", name: "Landed", traces_to: [] }];
  const r = validateBoard(board(), { plan: plan(), archivedEpics, archived: [] });
  assert.ok(r.errors.some((e) => /^archive: Epic eA: initiativeId "I-9" is not an initiative/.test(e)));
});

test("a live ticket resolves ownership through an ARCHIVED epic", () => {
  const archivedEpics = [{ id: "eA", initiativeId: "I-1", name: "Landed" }];
  const b = { epics: [], tickets: [ticket({ id: "T-1", epicId: "eA", traces_to: ["FR-2"] })] };
  const v = ownershipVerdict(b.tickets[0], { plan: plan(), data: b, archivedEpics });
  assert.equal(v.state, "cross-initiative");
  assert.equal(v.initiativeId, "I-1");
});

// ── The exception does not reach this far ───────────────────────────────────────

test("a scope_exception clears the scope gate but never ownership", () => {
  const b = board({ tickets: [ticket({ id: "T-1", epicId: "e2", traces_to: ["FR-1"], scope_exception: "owner said so" })] });
  const errs = validateBoard(b, { plan: plan() }).errors;
  assert.ok(errs.some((e) => /T-1 belongs to initiative I-2/.test(e)), "an exception is about project scope, not organisational consistency");
  assert.deepEqual(eligibleTickets(b, [], { plan: plan() }).map((t) => t.id), []);
});

// ── Precedence and degradation ──────────────────────────────────────────────────

test("a dangling epicId is reported as a dangling epicId, not as an ownership problem", () => {
  const b = board({ tickets: [ticket({ id: "T-1", epicId: "e404", traces_to: ["FR-1"] })] });
  const errs = validateBoard(b, { plan: plan() }).errors;
  assert.ok(errs.some((e) => /T-1: epicId "e404" does not exist/.test(e)));
  assert.ok(!errs.some((e) => /cross-initiative|belongs to initiative/.test(e)), "the reader must not be sent hunting the wrong bug");
});

test("ownership is skipped, not guessed, when epics were never supplied", () => {
  // The portfolio survey used to pass tickets alone. Blocking on an epic we were never given
  // would report a healthy board as jammed.
  const v = ownershipVerdict(ticket({ id: "T-1", epicId: "e1", traces_to: ["FR-1"] }), { plan: plan(), data: { tickets: [] } });
  assert.equal(v.state, "unresolved");
  assert.equal(v.blocks, false);
});

test("epicOwnershipVerdict is off entirely without initiatives", () => {
  assert.equal(epicOwnershipVerdict({ id: "e1", traces_to: ["FR-1"] }, plan({ initiatives: false })).state, "off");
});

// ── Scheduling is not initiative-aware, and must not become so ──────────────────

test("lane assignment ignores initiatives completely", () => {
  // Initiative depends_on is planning metadata. If it ever leaks into scheduling, two tickets
  // that are safe to run together would start serialising for a reason nothing on the board
  // explains. assignLanes takes no plan at all — this pins that.
  const ready = [
    ticket({ id: "T-1", epicId: "e1", area: "backend", touches: ["src/a/**"] }),
    ticket({ id: "T-2", epicId: "e2", area: "frontend", touches: ["src/b/**"] }),
  ];
  const before = assignLanes(ready);
  const after = assignLanes(ready.map((t) => ({ ...t })));
  assert.deepEqual(after, before);
  assert.equal(assignLanes.length <= 2, true, "assignLanes(ready, config) — no plan parameter");
});
