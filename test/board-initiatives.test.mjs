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
} from "../scripts/board-core.mjs";
import { assignLanes } from "../scripts/lane-core.mjs";
import { emptyPlan, TRACEABLE_PREFIXES } from "../scripts/plan-core.mjs";

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

// ── The cockpit's client-side preview must mirror these rules ───────────────────

test("usePlanScope mirrors the ownership rules it previews", () => {
  // cockpit/src/usePlanScope.ts restates the gate on purpose — its own docstring says the
  // authority stays server-side and the copy exists only to spare a save-and-see round trip.
  // A preview that disagrees is worse than none: a picker offering an option the save then
  // rejects teaches people to ignore it. Typecheck cannot catch a divergence in the RULE, so
  // this reads the file and pins the facts both sides have to agree on.
  const src = readFileSync(join(KIT_SRC, "usePlanScope.ts"), "utf8");

  // 1. The same traceable prefixes.
  const listed = src.match(/const TRACEABLE = \[([^\]]*)\]/)?.[1] ?? "";
  assert.deepEqual(
    listed.split(",").map((x) => x.trim().replace(/['"]/g, "")).filter(Boolean).sort(),
    [...TRACEABLE_PREFIXES].sort(),
    "TRACEABLE in usePlanScope.ts has drifted from TRACEABLE_PREFIXES",
  );

  // 2. Project-wide items (owner null) are available to every initiative — the rule that
  //    decides whether a shared NFR can be traced from anywhere.
  assert.match(src, /o\.initiativeId && o\.initiativeId !== \(own \?\? null\)/,
    "the foreign-item rule must treat a null owner as available to everyone");

  // 3. Ownership is checked after scope and is NOT cleared by a scope exception. Compared
  //    inside the verdict BODY — the state union at the top of the file mentions
  //    'cross-initiative' first, which would make a naive indexOf pass for the wrong reason.
  const body = src.slice(src.indexOf("const verdict ="));
  const exceptionAt = body.indexOf("scope_exception");
  const ownershipAt = body.indexOf("state: 'cross-initiative'");
  assert.ok(exceptionAt > -1 && ownershipAt > exceptionAt,
    "ownership must be evaluated after the exception branch, so an exception cannot clear it");
});

test("the states usePlanScope can report are states board-core also produces", () => {
  const src = readFileSync(join(KIT_SRC, "usePlanScope.ts"), "utf8");
  for (const state of ["unassigned-epic", "cross-initiative"]) {
    assert.ok(src.includes(`'${state}'`), `usePlanScope must be able to report ${state}`);
  }
  // And the server really does produce them, so the preview is not inventing verdicts.
  const p = plan();
  const b = board({ tickets: [ticket({ id: "T-1", epicId: "e3", traces_to: ["NFR-1"] })] });
  assert.equal(ownershipVerdict(b.tickets[0], { plan: p, data: b }).state, "unassigned-epic");
  const b2 = board({ tickets: [ticket({ id: "T-2", epicId: "e2", traces_to: ["FR-1"] })] });
  assert.equal(ownershipVerdict(b2.tickets[0], { plan: p, data: b2 }).state, "cross-initiative");
});
