/**
 * Unit tests for the project plan's shape, completeness maths, and scope gate.
 *
 * WHY THIS EXISTS: the completeness percentage and the scope verdict are both load-bearing —
 * one is the number a user is told to drive to 100, the other decides whether real work is
 * allowed to run. Both fail quietly when wrong: a plan that reads 100% while half its
 * requirements say "TBD" stops anyone from looking, and a gate that lets an untraced ticket
 * through does exactly nothing while appearing to work.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyPlan, normalisePlan, isPlaceholder, sectionFilled, planCompleteness, planCoverage,
  nextId, nextOutId, sectionForId, validatePlan, planIsGating, scopeVerdict, renderPlanMd,
  PLAN_SECTIONS,
} from "../scripts/plan-core.mjs";

/** A plan with every scoring section filled — 100% before any gap is raised. */
function fullPlan() {
  const p = emptyPlan();
  p.sections.goal = { text: "Ship the thing.", metrics: ["10 users in week one"] };
  p.sections.scope = { in: ["the web app"], out: [{ id: "OUT-1", text: "mobile apps" }] };
  p.sections.deliverables = [{ id: "D-1", text: "Web app" }];
  p.sections.useCases = [{ id: "UC-1", actor: "visitor", text: "signs up" }];
  p.sections.functional = [{ id: "FR-1", text: "Users can log in", verify: "npm test" }];
  p.sections.nonFunctional = [{ id: "NFR-1", text: "Fast", budget: "p95 < 300ms", verify: "k6" }];
  p.sections.milestones = [{ id: "M-1", text: "Beta" }];
  p.sections.risks = [{ id: "R-1", text: "Auth vendor lock-in" }];
  return p;
}

// ── Completeness ────────────────────────────────────────────────────────────────

test("an empty plan is 0% and a full one is 100%", () => {
  assert.equal(planCompleteness(emptyPlan()).percent, 0);
  assert.equal(planCompleteness(fullPlan()).percent, 100);
});

test("placeholder text does not count as filled", () => {
  for (const junk of ["", "  ", "TBD", "tbd", "propose one", "_propose one_", "N/A", "???", "Replace me"]) {
    assert.equal(isPlaceholder(junk), true, `"${junk}" should be a placeholder`);
  }
  assert.equal(isPlaceholder("Users can log in"), false);

  // The failure this guards: a seeded plan full of "propose one" reporting itself complete.
  const p = emptyPlan();
  p.sections.goal.text = "propose one";
  p.sections.functional = [{ id: "FR-1", text: "TBD" }];
  assert.equal(sectionFilled(p, "goal"), false);
  assert.equal(sectionFilled(p, "functional"), false);
  assert.equal(planCompleteness(p).percent, 0);
});

test("sections are weighted, not counted — goal is worth more than milestones", () => {
  const goalOnly = emptyPlan();
  goalOnly.sections.goal.text = "Ship the thing.";
  const milestonesOnly = emptyPlan();
  milestonesOnly.sections.milestones = [{ id: "M-1", text: "Beta" }];
  assert.ok(planCompleteness(goalOnly).percent > planCompleteness(milestonesOnly).percent);
});

test("an open REQUIRED gap lowers the percentage; an optional one never does", () => {
  const base = planCompleteness(fullPlan()).percent;

  const withOptional = fullPlan();
  withOptional.sections.gaps = [{ id: "G-1", text: "consider dark mode", need: "optional", status: "open" }];
  assert.equal(planCompleteness(withOptional).percent, base);

  const withRequired = fullPlan();
  withRequired.sections.gaps = [{ id: "G-1", text: "no rollback story", need: "required", status: "open" }];
  assert.ok(planCompleteness(withRequired).percent < base);

  // Answering it — either way — gives the points back. That is what makes triage worth doing.
  for (const status of ["accepted", "declined"]) {
    const answered = fullPlan();
    answered.sections.gaps = [{ id: "G-1", text: "no rollback story", need: "required", status, resolvedAs: "NFR-1" }];
    assert.equal(planCompleteness(answered).percent, base, `${status} should restore the percentage`);
  }
});

test("filled is not the same as usable — thin sections say what is missing", () => {
  const p = fullPlan();
  p.sections.functional = [{ id: "FR-1", text: "Users can log in" }];  // no verify
  p.sections.nonFunctional = [{ id: "NFR-1", text: "Fast" }];          // no budget
  p.sections.goal.metrics = [];
  const byKey = new Map(planCompleteness(p).sections.map((s) => [s.key, s]));
  assert.match(byKey.get("functional").detail, /FR-1/);
  assert.match(byKey.get("nonFunctional").detail, /NFR-1/);
  assert.match(byKey.get("goal").detail, /metric/i);
});

// ── Ids ─────────────────────────────────────────────────────────────────────────

test("nextId is max-plus-one, so a deleted id is never handed out again", () => {
  const p = emptyPlan();
  p.sections.functional = [{ id: "FR-1", text: "a" }, { id: "FR-7", text: "b" }];
  assert.equal(nextId(p, "functional"), "FR-8");

  // The bug this prevents: length-plus-one would return FR-3 here, silently re-pointing every
  // ticket that traced to the deleted FR-3 at unrelated work.
  p.sections.functional = [{ id: "FR-1", text: "a" }, { id: "FR-5", text: "b" }];
  assert.equal(nextId(p, "functional"), "FR-6");
});

test("nextOutId and sectionForId agree on prefixes", () => {
  const p = emptyPlan();
  assert.equal(nextOutId(p), "OUT-1");
  p.sections.scope.out = [{ id: "OUT-3", text: "x" }];
  assert.equal(nextOutId(p), "OUT-4");
  assert.equal(sectionForId("FR-2"), "functional");
  assert.equal(sectionForId("NFR-2"), "nonFunctional");
  assert.equal(sectionForId("OUT-1"), "scopeOut");
  assert.equal(sectionForId("G-9"), "gaps");
  assert.equal(sectionForId("nonsense"), null);
});

// ── Validation ──────────────────────────────────────────────────────────────────

test("duplicate ids across the whole plan are an error", () => {
  const p = fullPlan();
  p.sections.functional.push({ id: "FR-1", text: "duplicate" });
  const { errors } = validatePlan(p);
  assert.ok(errors.some((e) => /Duplicate plan id "FR-1"/.test(e)), errors.join("; "));
});

test("malformed ids and unknown fields are errors; thin items are only warnings", () => {
  const bad = emptyPlan();
  bad.sections.functional = [{ id: "REQ-1", text: "wrong prefix" }];
  assert.ok(validatePlan(bad).errors.length);

  const unknownField = emptyPlan();
  unknownField.sections.deliverables = [{ id: "D-1", text: "x", budget: "nope" }];
  assert.ok(validatePlan(unknownField).errors.some((e) => /unknown field "budget"/.test(e)));

  // An incomplete plan must stay WRITABLE, or /plan-update could never fill it in.
  const thin = emptyPlan();
  thin.sections.functional = [{ id: "FR-1", text: "no verify method" }];
  const r = validatePlan(thin);
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /FR-1/.test(w)));
});

test("normalisePlan repairs a plan missing keys rather than crashing on it", () => {
  const p = normalisePlan({ sections: { functional: [{ id: "FR-1", text: "x" }] } });
  for (const s of PLAN_SECTIONS) assert.ok(p.sections[s.key] !== undefined, `${s.key} missing`);
  assert.deepEqual(p.sections.scope, { in: [], out: [] });
  assert.equal(planCompleteness(p).percent > 0, true);
});

// ── The scope gate ──────────────────────────────────────────────────────────────

test("a plan with nothing in it does not gate", () => {
  // Otherwise a project one minute past `maestro setup` has every ticket refused, and the
  // fastest way out is to delete the plan.
  const blank = emptyPlan();
  blank.sections.goal.text = "Ship the thing.";
  assert.equal(planIsGating(blank), false);
  const v = scopeVerdict({ id: "T-1" }, blank);
  assert.equal(v.state, "no-plan");
  assert.equal(v.blocks, false);
});

test("the gate turns on as soon as the plan names in-scope work", () => {
  const p = fullPlan();
  assert.equal(planIsGating(p), true);

  const cases = [
    [{ traces_to: ["FR-1"] }, "in-scope", false],
    [{ traces_to: ["D-1", "UC-1"] }, "in-scope", false],
    [{}, "untraced", true],
    [{ traces_to: [] }, "untraced", true],
    [{ traces_to: ["FR-99"] }, "unknown", true],
    [{ traces_to: ["OUT-1"] }, "out", true],
    [{ traces_to: ["FR-1", "OUT-1"] }, "out", true],       // one foot out is still out
    [{ scope_exception: "owner approved a spike" }, "exception", false],
  ];
  for (const [ticket, state, blocks] of cases) {
    const v = scopeVerdict(ticket, p);
    assert.equal(v.state, state, `${JSON.stringify(ticket)} -> ${v.state}`);
    assert.equal(v.blocks, blocks, `${JSON.stringify(ticket)} blocks=${v.blocks}`);
  }
});

test("tracing at a gap, risk or open question does not smuggle a ticket past the gate", () => {
  // A gap is by definition something the plan does NOT yet cover; a risk commits to nothing.
  // Accept the gap into the plan first — then the ticket traces to whatever it became.
  const p = fullPlan();
  p.sections.gaps = [{ id: "G-1", text: "no rollback story", need: "required", status: "open" }];
  p.sections.openQuestions = [{ id: "Q-1", text: "which cloud?" }];
  for (const id of ["G-1", "R-1", "Q-1"]) {
    const v = scopeVerdict({ traces_to: [id] }, p);
    assert.equal(v.blocks, true, `${id} should not clear the gate`);
    assert.equal(v.state, "unknown");
  }
});

test("a partly-dangling trace still runs, but says the dangling id is gone", () => {
  const p = fullPlan();
  const v = scopeVerdict({ traces_to: ["FR-1", "FR-99"] }, p);
  assert.equal(v.blocks, false);
  assert.deepEqual(v.unknown, ["FR-99"]);
  assert.match(v.reason, /FR-99/);
});

// ── Coverage ────────────────────────────────────────────────────────────────────

test("coverage counts live and archived tickets, and ignores non-scope ids", () => {
  const p = fullPlan();
  p.sections.gaps = [{ id: "G-1", text: "x", need: "optional" }];
  const rows = planCoverage(
    p,
    [{ id: "T-1", status: "todo", traces_to: ["FR-1"] }],
    [{ id: "T-9", status: "done", traces_to: ["D-1"] }],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId.get("FR-1").tickets, ["T-1"]);
  assert.equal(byId.get("FR-1").done, false);
  assert.deepEqual(byId.get("D-1").tickets, ["T-9"]);
  assert.equal(byId.get("D-1").done, true);
  assert.deepEqual(byId.get("UC-1").tickets, []);
  // Gaps, risks and open questions are not deliverable work — they never appear as coverage.
  for (const id of ["G-1", "R-1", "OUT-1"]) assert.equal(byId.has(id), false, `${id} should not be a coverage row`);
});

// ── The Markdown mirror ─────────────────────────────────────────────────────────

test("renderPlanMd is deterministic and reflects the plan", () => {
  const p = fullPlan();
  const a = renderPlanMd(p, "demo");
  const b = renderPlanMd(p, "demo");
  assert.equal(a, b, "same plan must render identical bytes — the git history depends on it");
  assert.match(a, /# demo — project plan/);
  assert.match(a, /Plan completeness: 100%/);
  assert.match(a, /`OUT-1`/);
  assert.match(a, /do not edit this file/);
});

test("the mirror separates required from optional gaps", () => {
  const p = fullPlan();
  p.sections.gaps = [
    { id: "G-1", text: "no rollback story", need: "required", from: "atomic-report", status: "open" },
    { id: "G-2", text: "consider dark mode", need: "optional", from: "scale", status: "open" },
  ];
  const md = renderPlanMd(p, "demo");
  assert.match(md, /Required — the plan is incomplete without these/);
  assert.match(md, /Optional — worth considering/);
  assert.ok(md.indexOf("G-1") < md.indexOf("G-2"), "required gaps come first");
});
