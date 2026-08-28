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
  ownershipVerdict, epicOwnershipVerdict, initiativeModeActive, crossInitiativeConflicts,
  pickVerdict,
} from "../scripts/board-core.mjs";
import { assignLanes } from "../scripts/lane-core.mjs";
import { emptyPlan, scopeVerdict, planIsGating } from "../scripts/plan-core.mjs";
import {
  NO_INITIATIVE, reconcileEpicSelection, defaultEpicForNewTicket,
} from "../cockpit/src/boardFilters.mjs";

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

// ── The archived-epic hole, and the guard against reopening it ──────────────────
//
// Ownership is derived through a ticket's epic, and an epic that has landed lives in
// archive.json. A caller that passes `plan` but not `archivedEpics` therefore hands
// ownershipVerdict a ticket whose epic it cannot see: the verdict degrades to "unresolved",
// which never blocks, and a mis-wired ticket runs. The degradation is deliberate (the
// portfolio survey legitimately has boards without epics) which is exactly why the CALLERS
// have to be pinned — the function cannot tell "no epics supplied" from "epics supplied, one
// missing" and must not guess.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT_SRC = join(KIT, "cockpit", "src");

test("a live ticket under an ARCHIVED epic is still ownership-checked at pick time", () => {
  const archivedEpics = [{ id: "eA", initiativeId: "I-1", name: "Landed registration" }];
  const b = { epics: [], tickets: [ticket({ id: "T-1", epicId: "eA", traces_to: ["FR-2"] })] };
  // FR-2 belongs to I-2; the ticket's epic belongs to I-1. Cross-initiative either way — but
  // only visible if the archived epics were handed over.
  assert.deepEqual(eligibleTickets(b, [], { plan: plan(), archivedEpics }).map((t) => t.id), []);
  assert.deepEqual(
    eligibleTickets(b, [], { plan: plan() }).map((t) => t.id), ["T-1"],
    "documents the degradation: without archivedEpics the gate cannot see the epic and lets it through",
  );
  const [blocked] = scopeBlockedTickets(b, [], plan(), archivedEpics);
  assert.equal(blocked.verdict.state, "cross-initiative");
});

test("every plan-aware eligibility call in the shipped sources passes archived epics", () => {
  // A source-level guard, because the defect is a MISSING ARGUMENT: no behavioural test of one
  // call site can prove the next one added will be right. This reads the real files.
  //
  // Comments are stripped first — the docstrings legitimately write `eligibleTickets(…, {plan})`
  // while explaining the rule, and a guard that fails on its own documentation gets deleted.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const files = [
    ...readdirSync(join(KIT, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => join("scripts", f)),
    join("cockpit", "server", "portfolio.mjs"),
    join("cockpit", "server", "index.mjs"),
  ];
  const offenders = [];
  for (const rel of files) {
    const src = stripComments(readFileSync(join(KIT, rel), "utf8"));
    for (const m of src.matchAll(/\b(eligibleTickets|scopeBlockedTickets)\s*\(/g)) {
      // Brace-match the argument list so a nested call cannot truncate it.
      let i = m.index + m[0].length, depth = 1;
      while (i < src.length && depth > 0) {
        if ("([{".includes(src[i])) depth++;
        else if (")]}".includes(src[i])) depth--;
        i++;
      }
      const args = src.slice(m.index + m[0].length, i - 1);
      if (!/\bplan\b/.test(args)) continue; // no plan, no ownership gate to weaken
      // Either spelling counts: eligibleTickets takes `archivedEpics` in its opts, while
      // scopeBlockedTickets takes the archived epics as its fourth positional argument.
      if (!/epics/i.test(args)) offenders.push(`${rel}: ${m[1]}(${args.replace(/\s+/g, " ").slice(0, 90)})`);
    }
  }
  assert.deepEqual(offenders, [], `these pass a plan but no archived epics, so ownership silently degrades:\n${offenders.join("\n")}`);
});

test("validate-board.mjs reports a cross-initiative ticket whose epic is archived", () => {
  // End-to-end through a real production entry point, not the library.
  const dir = mkdtempSync(join(tmpdir(), "init-arch-"));
  const boardDir = join(dir, "board");
  mkdirSync(boardDir, { recursive: true });
  const write = (f, o) => writeFileSync(join(boardDir, f), JSON.stringify(o, null, 2));
  write("plan.json", plan());
  write("data.json", { epics: [], tickets: [ticket({ id: "T-1", epicId: "eA", traces_to: ["FR-2"] })] });
  write("archive.json", { epics: [{ id: "eA", initiativeId: "I-1", name: "Landed" }], tickets: [] });
  try {
    let out = "";
    try {
      out = execFileSync("node", [join(KIT, "scripts", "validate-board.mjs"), join(boardDir, "data.json")], { encoding: "utf8" });
    } catch (e) {
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.match(out, /T-1 belongs to initiative I-1 through epic eA, but traces to FR-2 owned by I-2/);
    assert.match(out, /Board invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Dangling initiative references outlive initiative mode ──────────────────────

test("an epic pointing at an initiative the plan no longer defines is an error, mode or not", () => {
  // Deleting the LAST initiative turns initiative mode off. Every ownership check that is
  // gated on that mode therefore goes quiet at exactly the moment the board is most likely to
  // be wrong — the epics are all still carrying ids that now point at nothing.
  const gone = plan();
  gone.sections.initiatives = [];
  const b = board({ epics: [{ id: "e1", initiativeId: "I-1", name: "Registration" }], tickets: [] });

  assert.equal(initiativeModeActive(gone), false);
  const errs = validateBoard(b, { plan: gone }).errors;
  assert.ok(errs.some((e) => /Epic e1 names initiative I-1, which the plan does not define/.test(e)), errs.join("\n"));
  assert.deepEqual(crossInitiativeConflicts(gone, { data: b }).length, 1);
});

test("an archived epic's dangling reference is reported too", () => {
  const gone = plan();
  gone.sections.initiatives = [];
  const archivedEpics = [{ id: "eA", initiativeId: "I-2", name: "Landed" }];
  const errs = validateBoard({ epics: [], tickets: [] }, { plan: gone, archivedEpics }).errors;
  assert.ok(errs.some((e) => /^archive: Epic eA names initiative I-2/.test(e)), errs.join("\n"));
});

test("a legacy board with no initiativeId anywhere is untouched by that check", () => {
  const gone = plan();
  gone.sections.initiatives = [];
  const legacy = { epics: [{ id: "e1", name: "Registration", traces_to: ["FR-1"] }], tickets: [] };
  assert.deepEqual(validateBoard(legacy, { plan: gone }).errors, []);
  assert.deepEqual(crossInitiativeConflicts(gone, { data: legacy }), []);
});

test("a sample epic is exempt from the dangling check, as it is from the rest", () => {
  const gone = plan();
  gone.sections.initiatives = [];
  const b = { epics: [{ id: "e9", initiativeId: "I-1", name: "Sample", sample: true }], tickets: [] };
  assert.deepEqual(validateBoard(b, { plan: gone }).errors, []);
});

// ── The rules the cockpit's preview runs, executably ───────────────────────────
//
// usePlanScope.ts no longer restates these — it imports scopeVerdict and ownershipVerdict from
// scripts/ and composes them exactly as eligibleTickets does. That is the fix for two
// divergences a source-ordering check could not see, and these tests pin the COMPOSED
// behaviour rather than the arrangement of the source.

// `preview` IS pickVerdict — the production function both eligibleTickets and usePlanScope
// call. A test-local reimplementation of the composition would stay green while production
// regressed to returning scope alone, which is the exact failure mode the earlier
// source-ordering guard had.
const preview = (ticket, ctx) => pickVerdict(ticket, ctx);

test("a scope exception does NOT clear ownership in the preview", () => {
  // The bug: the hand-written preview returned early on scope_exception, so a ticket with an
  // exception showed as runnable while the server refused it. An exception is a decision about
  // project SCOPE; it says nothing about which initiative a requirement belongs to.
  const p = plan();
  const b = board({ tickets: [ticket({ id: "T-1", epicId: "e2", traces_to: ["FR-1"], scope_exception: "owner said so" })] });

  assert.equal(scopeVerdict(b.tickets[0], p).state, "exception", "scope alone is satisfied");
  assert.equal(scopeVerdict(b.tickets[0], p).blocks, false);
  const v = preview(b.tickets[0], { plan: p, data: b });
  assert.equal(v.state, "cross-initiative");
  assert.equal(v.blocks, true, "the preview must agree with the server, which still refuses it");
  // And the server does refuse it, which is what makes the preview correct rather than merely strict.
  assert.deepEqual(eligibleTickets(b, [], { plan: p }).map((t) => t.id), []);
});

test("ownership still applies when the ordinary scope gate is OFF", () => {
  // The bug: the preview short-circuited on "no plan yet" — computed from D/UC/FR — so a plan
  // that defines initiatives and only NFRs turned ownership off in the UI while the server
  // kept enforcing it. planIsGating and initiativeModeActive are independent switches.
  const p = emptyPlan();
  p.sections.initiatives = [
    { id: "I-1", name: "A", outcome: "x", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
    { id: "I-2", name: "B", outcome: "y", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
  ];
  p.sections.nonFunctional = [{ id: "NFR-1", initiativeId: "I-1", text: "No PII", budget: "zero" }];

  assert.equal(planIsGating(p), false, "no deliverable, use case or functional requirement");
  assert.equal(initiativeModeActive(p), true, "but the plan does define initiatives");

  const b = {
    epics: [{ id: "e2", initiativeId: "I-2", name: "Billing" }],
    tickets: [ticket({ id: "T-1", epicId: "e2", traces_to: ["NFR-1"] })],
  };
  assert.equal(scopeVerdict(b.tickets[0], p).state, "no-plan", "the scope gate really is off");
  const v = preview(b.tickets[0], { plan: p, data: b });
  assert.equal(v.state, "cross-initiative");
  assert.equal(v.blocks, true);
  assert.deepEqual(eligibleTickets(b, [], { plan: p }).map((t) => t.id), [], "the server refuses it too");
});

test("the preview reports the same verdicts the server acts on, across the states", () => {
  const p = plan();
  const cases = [
    ["own initiative", { id: "T-1", epicId: "e1", traces_to: ["FR-1"] }, "in-scope", false],
    ["project-wide item", { id: "T-2", epicId: "e1", traces_to: ["NFR-1"] }, "in-scope", false],
    ["another initiative's item", { id: "T-3", epicId: "e2", traces_to: ["FR-1"] }, "cross-initiative", true],
    ["unassigned epic", { id: "T-4", epicId: "e3", traces_to: ["NFR-1"] }, "unassigned-epic", true],
    ["untraced", { id: "T-5", epicId: "e1", traces_to: [] }, "untraced", true],
  ];
  for (const [label, t, state, blocks] of cases) {
    const b = board({ tickets: [ticket(t)] });
    const v = preview(b.tickets[0], { plan: p, data: b });
    assert.equal(v.state, state, `${label}: expected ${state}, got ${v.state}`);
    assert.equal(v.blocks, blocks, label);
    // Whatever the preview says about blocking, the orchestrator must do.
    assert.equal(eligibleTickets(b, [], { plan: p }).length, blocks ? 0 : 1, `${label}: server disagrees`);
  }
});

test("the cockpit calls pickVerdict rather than composing the gates itself", () => {
  // Structural, and narrow on purpose: the behaviour above is pinned by calling the production
  // function, so all this has to establish is that the hook calls THAT function and does not
  // rebuild the composition beside it.
  const src = readFileSync(join(KIT_SRC, "usePlanScope.ts"), "utf8");
  assert.match(src, /import \{ pickVerdict[^}]*\} from '\.\.\/\.\.\/scripts\/board-core\.mjs'/);
  assert.match(src, /return pickVerdict\(ticket, \{/);
  assert.ok(!src.includes("const TRACEABLE = ["), "the restated prefix list must be gone");
  assert.ok(!/scope\.blocks\)\s*return scope/.test(src), "the hook must not re-compose the two gates");
});

test("pickVerdict is what eligibleTickets filters on, so preview and pick cannot diverge", () => {
  const p = plan();
  for (const t of [
    { id: "T-1", epicId: "e1", traces_to: ["FR-1"] },
    { id: "T-2", epicId: "e2", traces_to: ["FR-1"] },
    { id: "T-3", epicId: "e3", traces_to: ["NFR-1"] },
    { id: "T-4", epicId: "e1", traces_to: [] },
    { id: "T-5", epicId: "e1", traces_to: ["FR-1"], scope_exception: "owner said so" },
  ]) {
    const b = board({ tickets: [ticket(t)] });
    const blocked = pickVerdict(b.tickets[0], { plan: p, data: b }).blocks;
    assert.equal(eligibleTickets(b, [], { plan: p }).length, blocked ? 0 : 1,
      `${t.id}: pickVerdict says blocks=${blocked}, eligibleTickets disagrees`);
  }
});

// ── Board filters cannot contradict each other ─────────────────────────────────
//
// Two filters that can disagree are not just confusing: "+ ticket" defaults from them, so an
// impossible combination files work somewhere other than the view implies and then hides it.
// The rules live in cockpit/src/boardFilters.mjs as plain ESM precisely so they are pinnable.

const EPICS = [
  { id: "e1", initiativeId: "I-1" },
  { id: "e2", initiativeId: "I-2" },
  { id: "e3" }, // unassigned
];
const filters = (over = {}) => ({ status: "", priority: "", area: "", q: "", focus: "active", epic: "", initiative: "", ...over });

test("selecting an epic outside the active initiative retunes the initiative filter", () => {
  // Filter I-2, click an I-1 epic: leaving both would show zero tickets AND file the next new
  // ticket into the invisible I-1 epic.
  const next = reconcileEpicSelection(filters({ initiative: "I-2" }), EPICS[0], "e1");
  assert.equal(next.epic, "e1");
  assert.equal(next.initiative, "I-1", "the initiative filter follows the epic");
  assert.equal(defaultEpicForNewTicket(next, EPICS), "e1", "and the new ticket lands where the view says");
});

test("selecting an unassigned epic switches the filter to NO_INITIATIVE", () => {
  const next = reconcileEpicSelection(filters({ initiative: "I-1" }), EPICS[2], "e3");
  assert.equal(next.initiative, NO_INITIATIVE);
  assert.equal(defaultEpicForNewTicket(next, EPICS), "e3");
});

test("selecting an assigned epic while filtered to NO_INITIATIVE switches to its initiative", () => {
  const next = reconcileEpicSelection(filters({ initiative: NO_INITIATIVE }), EPICS[1], "e2");
  assert.equal(next.initiative, "I-2");
});

test("a matching selection leaves the initiative filter alone", () => {
  for (const [initiative, epic, id] of [["I-1", EPICS[0], "e1"], [NO_INITIATIVE, EPICS[2], "e3"]]) {
    const next = reconcileEpicSelection(filters({ initiative }), epic, id);
    assert.equal(next.initiative, initiative);
    assert.equal(next.epic, id);
  }
});

test("with no initiative filter, selecting an epic does not invent one", () => {
  const next = reconcileEpicSelection(filters(), EPICS[0], "e1");
  assert.equal(next.initiative, "", "a user who has not filtered by initiative is not opted into one");
});

test("'All epics' keeps the initiative in force rather than clearing both", () => {
  const next = reconcileEpicSelection(filters({ initiative: "I-2", epic: "e2" }), undefined, "");
  assert.equal(next.epic, "");
  assert.equal(next.initiative, "I-2");
});

test("a new ticket defaults into the filtered initiative, never simply the board's first epic", () => {
  assert.equal(defaultEpicForNewTicket(filters({ initiative: "I-2" }), EPICS), "e2");
  assert.equal(defaultEpicForNewTicket(filters({ initiative: NO_INITIATIVE }), EPICS), "e3");
  assert.equal(defaultEpicForNewTicket(filters(), EPICS), "e1", "unfiltered, the board's first is right");
  assert.equal(defaultEpicForNewTicket(filters({ initiative: "I-9" }), EPICS), "",
    "an initiative with no epics yields no default rather than a wrong one");
});
