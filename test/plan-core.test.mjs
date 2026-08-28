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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  emptyPlan, normalisePlan, isPlaceholder, sectionFilled, planCompleteness, planCoverage,
  nextId, nextOutId, sectionForId, validatePlan, planIsGating, scopeVerdict, renderPlanMd,
  planItems, initiativeCycles, PLAN_SECTIONS, TRACEABLE_PREFIXES, OWNED_SECTIONS,
  initiativeMap, initiativeForItem, initiativeProgress, projectWideProgress,
} from "../scripts/plan-core.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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

// ── Initiatives (T-022) ─────────────────────────────────────────────────────────
//
// The initiative layer is additive by contract: a plan that never defines one must behave
// EXACTLY as it did before this section existed. Half these tests are about the new feature;
// the other half exist to prove it stayed out of everyone else's way.

/** A plan with two initiatives, one owned item each, and one project-wide item. */
function initiativePlan() {
  const p = emptyPlan();
  p.sections.goal = { text: "Ship the thing.", metrics: ["10 users in week one"] };
  p.sections.initiatives = [
    { id: "I-1", name: "Customer onboarding", outcome: "Customers activate without support", scope: { in: ["Registration"], out: ["Billing migration"] }, metrics: ["80% self-serve"], depends_on: [] },
    { id: "I-2", name: "Billing migration", outcome: "Invoices come from the new system", scope: { in: [], out: [] }, metrics: [], depends_on: ["I-1"] },
  ];
  p.sections.deliverables = [{ id: "D-1", initiativeId: "I-1", text: "Onboarding workflow" }];
  p.sections.functional = [
    { id: "FR-1", initiativeId: "I-1", text: "Customer verifies their email", verify: "npm test" },
    { id: "FR-2", initiativeId: "I-2", text: "Invoices reconcile against the ledger", verify: "npm test" },
  ];
  p.sections.nonFunctional = [{ id: "NFR-1", text: "No PII in logs", budget: "zero occurrences", enforce: "npm run check:no-pii" }];
  return p;
}

test("a legacy plan with no initiatives key normalises to an empty array", () => {
  const raw = { planVersion: 1, sections: { goal: { text: "x", metrics: [] }, functional: [{ id: "FR-1", text: "a" }] } };
  const n = normalisePlan(raw);
  assert.deepEqual(n.sections.initiatives, []);
  // planVersion is NOT bumped — the layer is additive, so there is nothing to migrate.
  assert.equal(n.planVersion, 1);
  assert.equal(emptyPlan().planVersion, 1);
});

test("initiatives carry weight 0 — the completeness denominator is unchanged", () => {
  // 17 = goal 3 + scope 3 + deliverables 2 + useCases 2 + functional 3 + nonFunctional 2
  //      + milestones 1 + risks 1. Initiatives, gaps and open questions all score 0.
  assert.equal(planCompleteness(emptyPlan()).possible, 17);
  assert.equal(SECTIONS_BY_KEY_WEIGHT("initiatives"), 0);
  // Adding initiatives to a full plan must not move the number in either direction.
  const before = planCompleteness(fullPlan()).percent;
  const withInit = fullPlan();
  withInit.sections.initiatives = [{ id: "I-1", name: "A", outcome: "B", scope: { in: [], out: [] }, metrics: [], depends_on: [] }];
  assert.equal(planCompleteness(withInit).percent, before);
});

function SECTIONS_BY_KEY_WEIGHT(key) {
  return PLAN_SECTIONS.find((s) => s.key === key).weight;
}

test("initiative ids allocate max-plus-one over the ids currently in the plan", () => {
  const p = initiativePlan();
  assert.equal(nextId(p, "initiatives"), "I-3");
  // Max-plus-one is computed over what is PERSISTED, so removing the highest id frees it for
  // reuse. That is the honest description of this allocator: it is not a monotonic counter,
  // and nothing here prevents a deleted id from being handed out again. Making reuse
  // impossible would need tombstones or a ban on deletion, neither of which exists — so the
  // protection against re-pointing a live trace at unrelated work lives elsewhere: T-025's
  // `initiative-remove` refuses while any plan item, live epic, or archived epic still
  // references the initiative, with no force flag.
  p.sections.initiatives = p.sections.initiatives.filter((i) => i.id !== "I-2");
  assert.equal(nextId(p, "initiatives"), "I-2");
});

test("sectionForId resolves an initiative id, and I- is not traceable", () => {
  assert.equal(sectionForId("I-1"), "initiatives");
  assert.ok(!TRACEABLE_PREFIXES.includes("I"));
});

test("a ticket tracing to an initiative is refused as unknown", () => {
  const p = initiativePlan();
  const v = scopeVerdict({ id: "T-1", traces_to: ["I-1"] }, p);
  assert.equal(v.state, "unknown");
  assert.equal(v.blocks, true);
  assert.deepEqual(v.unknown, ["I-1"]);
});

test("initiatives are excluded from coverage", () => {
  const ids = planCoverage(initiativePlan(), [], []).map((r) => r.id);
  assert.ok(!ids.includes("I-1"), "an initiative must never appear as a plan item awaiting a ticket");
  assert.deepEqual(ids.sort(), ["D-1", "FR-1", "FR-2", "NFR-1"]);
});

test("planItems includes initiatives for id uniqueness and reports ownership", () => {
  const items = planItems(initiativePlan());
  assert.equal(items.get("I-1").prefix, "I");
  assert.equal(items.get("I-1").text, "Customer onboarding");
  assert.equal(items.get("FR-1").initiativeId, "I-1");
  assert.equal(items.get("NFR-1").initiativeId, null, "a project-wide item reports null, not undefined");
});

test("a valid initiative plan passes validation", () => {
  assert.deepEqual(validatePlan(initiativePlan()).errors, []);
});

test("an initiative needs a name and an outcome", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].outcome = "";
  assert.ok(validatePlan(p).errors.some((e) => /I-1: an initiative needs an `outcome`/.test(e)));
  p.sections.initiatives[0].name = "";
  assert.ok(validatePlan(p).errors.some((e) => /I-1: an initiative needs a `name`/.test(e)));
});

test("a duplicate initiative id collides in the shared plan id space", () => {
  const p = initiativePlan();
  p.sections.initiatives.push({ id: "I-1", name: "Dup", outcome: "x", scope: { in: [], out: [] }, metrics: [], depends_on: [] });
  assert.ok(validatePlan(p).errors.some((e) => /Duplicate plan id "I-1"/.test(e)));
});

test("a malformed initiative id is rejected", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].id = "INIT-1";
  assert.ok(validatePlan(p).errors.some((e) => /must look like I-1/.test(e)));
});

test("depends_on must name a real initiative, and never itself", () => {
  const p = initiativePlan();
  p.sections.initiatives[1].depends_on = ["I-9"];
  assert.ok(validatePlan(p).errors.some((e) => /I-2: depends_on "I-9"/.test(e)));
  p.sections.initiatives[1].depends_on = ["I-2"];
  assert.ok(validatePlan(p).errors.some((e) => /I-2: depends on itself/.test(e)));
});

test("a dependency cycle among initiatives is an error", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].depends_on = ["I-2"]; // I-1 → I-2 → I-1
  const errs = validatePlan(p).errors;
  assert.ok(errs.some((e) => /Initiative dependency cycle/.test(e)), errs.join("\n"));
  assert.equal(initiativeCycles(normalisePlan(p).sections.initiatives).length, 1);
  // A dangling dependency is reported as a dangling dependency, not as a phantom cycle.
  assert.deepEqual(initiativeCycles([{ id: "I-1", depends_on: ["I-404"] }]), []);
});

test("an item may not name an initiative the plan does not define", () => {
  const p = initiativePlan();
  p.sections.functional[0].initiativeId = "I-9";
  assert.ok(validatePlan(p).errors.some((e) => /FR-1: initiativeId "I-9" is not an initiative/.test(e)));
});

test("an item with no initiativeId is project-wide and valid", () => {
  const p = initiativePlan();
  delete p.sections.functional[0].initiativeId;
  assert.deepEqual(validatePlan(p).errors, []);
  assert.equal(planItems(p).get("FR-1").initiativeId, null);
});

test("ownership is legal on exactly six sections", () => {
  assert.deepEqual([...OWNED_SECTIONS].sort(), ["deliverables", "functional", "milestones", "nonFunctional", "risks", "useCases"]);
});

test("ownership on an open question or a gap is an unknown field, not a silent no-op", () => {
  // The trap: deliverables and openQuestions shared one schema definition, so widening it
  // would have made ownership legal on questions. Both halves must refuse it.
  const p = initiativePlan();
  p.sections.openQuestions = [{ id: "Q-1", text: "Who owns support?", initiativeId: "I-1" }];
  assert.ok(validatePlan(p).errors.some((e) => /Q-1: unknown field "initiativeId"/.test(e)));

  const q = initiativePlan();
  q.sections.gaps = [{ id: "G-1", text: "No deletion story", need: "required", initiativeId: "I-1" }];
  assert.ok(validatePlan(q).errors.some((e) => /G-1: unknown field "initiativeId"/.test(e)));
});

test("an unknown field on an initiative is reported rather than normalised away", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].metric = ["typo — singular"];
  assert.ok(validatePlan(p).errors.some((e) => /I-1: unknown field "metric"/.test(e)));
});

test("initiative list fields must hold only strings", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].metrics = ["fine", 7];
  assert.ok(validatePlan(p).errors.some((e) => /I-1: `metrics` must contain only strings/.test(e)));
  p.sections.initiatives[0].metrics = "not an array";
  assert.ok(validatePlan(p).errors.some((e) => /I-1: `metrics` must be an array of strings/.test(e)));
});

// ── Rendering ───────────────────────────────────────────────────────────────────

test("an initiative-free plan renders byte-for-byte as it did before initiatives existed", () => {
  // THE POINT OF THE FIXTURE: rendering twice and comparing the two results proves only that
  // the function is pure — it would pass just as happily if every legacy plan's Markdown
  // changed shape. legacy-plan.md was captured from the renderer BEFORE this ticket touched
  // it, so this asserts against the old bytes and not against the new code's opinion of them.
  const plan = JSON.parse(readFileSync(join(FIXTURES, "legacy-plan.json"), "utf8"));
  const expected = readFileSync(join(FIXTURES, "legacy-plan.md"), "utf8");
  assert.equal(renderPlanMd(plan, "Fixture Project"), expected);
});

test("rendering is deterministic in initiative mode too", () => {
  // Catches Map-iteration order or object-key order leaking into the new path, which the
  // fixture above cannot see.
  const p = initiativePlan();
  assert.equal(renderPlanMd(p, "P"), renderPlanMd(p, "P"));
  assert.equal(renderPlanMd(structuredClone(p), "P"), renderPlanMd(p, "P"));
});

test("initiative mode renders project-wide items apart from each initiative's own", () => {
  const md = renderPlanMd(initiativePlan(), "P");
  assert.match(md, /## Project-wide plan items/);
  assert.match(md, /_Owned by no single initiative/);
  assert.match(md, /### `I-1` Customer onboarding/);
  assert.match(md, /### `I-2` Billing migration/);
  assert.match(md, /\*\*Depends on:\*\* `I-1`/);
  // NFR-1 is project-wide; FR-1 belongs to I-1 and FR-2 to I-2.
  const i1 = md.slice(md.indexOf("### `I-1`"), md.indexOf("### `I-2`"));
  assert.ok(i1.includes("FR-1"), "I-1 renders its own requirement");
  assert.ok(!i1.includes("FR-2"), "I-1 must not render another initiative's requirement");
  assert.ok(!i1.includes("NFR-1"), "a project-wide item is not repeated under every initiative");
  assert.ok(md.indexOf("NFR-1") < md.indexOf("### `I-1`"), "project-wide items render before the initiatives");
});

test("an initiative with no owned items says so rather than rendering an empty section", () => {
  const p = initiativePlan();
  p.sections.functional = p.sections.functional.filter((f) => f.initiativeId !== "I-2");
  assert.match(renderPlanMd(p, "P"), /_No plan items owned yet._/);
});

// ── Malformed initiatives must be REPORTED, never quietly dropped ───────────────
//
// mutatePlan (plan-io.mjs) validates the NORMALISED plan, so anything normalisation filters
// out is gone before validatePlan can object — and would then be erased from disk by the next
// unrelated write. For initiatives the filter therefore keeps every object entry and lets the
// validator refuse the write instead.

test("an initiative with no id survives normalisation and is reported as an error", () => {
  const p = initiativePlan();
  p.sections.initiatives.push({ name: "Nameless", outcome: "something" });
  assert.equal(normalisePlan(p).sections.initiatives.length, 3, "the malformed entry must not be filtered away");
  const errs = validatePlan(p).errors;
  assert.ok(errs.some((e) => /Initiatives: item missing id/.test(e)), errs.join("\n"));
});

test("a plan write is refused rather than silently erasing an id-less initiative", () => {
  // The end-to-end shape of the defect: read → normalise → write would have dropped the entry
  // and reported success. An error here is what makes the write fail instead.
  const onDisk = initiativePlan();
  onDisk.sections.initiatives.push({ name: "Half-typed", outcome: "" });
  const next = normalisePlan(onDisk); // exactly what mutatePlan validates
  assert.ok(validatePlan(next).errors.length > 0, "the normalised plan must still fail validation");
  assert.ok(next.sections.initiatives.some((i) => i.name === "Half-typed"), "the entry is still there to be saved once fixed");
});

test("a non-object in the initiatives array is still filtered, and does not shift the raw pairing", () => {
  const p = initiativePlan();
  p.sections.initiatives.splice(1, 0, "not an initiative");
  const n = normalisePlan(p);
  assert.equal(n.sections.initiatives.length, 2);
  // I-2's checks must still read I-2's raw entry, not I-1's, after the string is dropped.
  p.sections.initiatives[2].metrics = [42];
  assert.ok(validatePlan(p).errors.some((e) => /I-2: `metrics` must contain only strings/.test(e)));
});

test("an unknown nested scope field is rejected, matching the schema", () => {
  // normaliseInitiative rebuilds `scope` from scratch, so a nested typo is gone by the time the
  // normalised entry exists — only a raw-key check can see it. The schema says
  // additionalProperties:false here; core validation must not be the looser of the two.
  const p = initiativePlan();
  p.sections.initiatives[0].scope = { in: ["Registration"], inn: ["typo"] };
  assert.ok(validatePlan(p).errors.some((e) => /I-1: unknown field "scope.inn" \(allowed: in, out\)/.test(e)));
});

test("a scope that is not an object is rejected", () => {
  const p = initiativePlan();
  p.sections.initiatives[0].scope = ["in", "out"];
  assert.ok(validatePlan(p).errors.some((e) => /I-1: `scope` must be an object/.test(e)));
});

test("an id-less initiative never reaches the id map or the rendered Markdown", () => {
  const p = initiativePlan();
  p.sections.initiatives.push({ name: "Nameless", outcome: "x" });
  assert.ok(!planItems(p).has(undefined), "an id-less entry must not be keyed as `undefined`");
  const md = renderPlanMd(p, "P");
  assert.ok(!md.includes("undefined"), "an id-less entry must not render as `### `undefined``");
  assert.ok(!md.includes("Nameless"));
});

// ── Initiative progress (T-023) ─────────────────────────────────────────────────

/** initiativePlan() plus milestones, and tickets in every relevant state. */
function progressPlan() {
  const p = initiativePlan();
  p.sections.deliverables.push({ id: "D-2", initiativeId: "I-2", text: "Ledger reconciliation" });
  p.sections.useCases = [{ id: "UC-1", initiativeId: "I-1", actor: "customer", text: "activates an account" }];
  p.sections.milestones = [{ id: "M-1", initiativeId: "I-1", text: "Onboarding demo" }];
  return p;
}

test("initiativeMap and initiativeForItem report ownership", () => {
  const p = progressPlan();
  assert.deepEqual([...initiativeMap(p).keys()], ["I-1", "I-2"]);
  assert.equal(initiativeForItem(p, "FR-1"), "I-1");
  assert.equal(initiativeForItem(p, "NFR-1"), null, "a project-wide item is owned by nobody");
  assert.equal(initiativeForItem(p, "FR-404"), null, "an unknown item is owned by nobody too");
});

test("progress counts live and archived tickets, and only a landed one moves the percentage", () => {
  const p = progressPlan();
  // I-1 owns D-1, UC-1, FR-1 (scored) and M-1 (reported, never scored).
  const live = [{ id: "T-1", status: "in-progress", traces_to: ["UC-1"] }];
  const archived = [{ id: "T-2", status: "done", traces_to: ["D-1"] }];
  const [i1] = initiativeProgress(p, live, archived);
  assert.equal(i1.id, "I-1");
  assert.equal(i1.total, 3, "milestones are reported but not scored");
  assert.equal(i1.covered, 2);
  assert.equal(i1.done, 1);
  assert.deepEqual(i1.uncovered, ["FR-1"], "no ticket at all");
  assert.deepEqual(i1.incomplete, ["UC-1"], "has a ticket that has not landed");
  assert.deepEqual(i1.milestones, ["M-1"]);
  assert.equal(i1.percent, 33, "done / total — filing a ticket must not move the number");
});

test("a project-wide item is excluded from every initiative and reported once", () => {
  const p = progressPlan();
  const archived = [{ id: "T-1", status: "done", traces_to: ["NFR-1"] }];
  for (const row of initiativeProgress(p, [], archived)) {
    assert.ok(!row.uncovered.includes("NFR-1"));
    assert.ok(!row.incomplete.includes("NFR-1"));
  }
  // I-1 owns 3 scored items, I-2 owns 2 (D-2, FR-2); NFR-1 belongs to neither.
  assert.deepEqual(initiativeProgress(p, [], archived).map((r) => r.total), [3, 2]);
  const global = projectWideProgress(p, [], archived);
  assert.deepEqual(global, { id: null, name: "Project-wide", total: 1, covered: 1, done: 1, uncovered: [], incomplete: [], milestones: [], percent: 100 });
});

test("progress is derived from planCoverage, so the two never disagree", () => {
  const p = progressPlan();
  const archived = [{ id: "T-1", status: "done", traces_to: ["D-1", "FR-2"] }];
  const rows = planCoverage(p, [], archived);
  const byInitiative = initiativeProgress(p, [], archived);
  for (const row of byInitiative) {
    const fromCoverage = rows.filter((r) => r.initiativeId === row.id && r.section !== "milestones");
    assert.equal(row.total, fromCoverage.length);
    assert.equal(row.done, fromCoverage.filter((r) => r.done).length);
  }
});

test("an initiative owning nothing reports 0 rather than dividing by zero", () => {
  const p = initiativePlan();
  p.sections.functional = p.sections.functional.filter((f) => f.initiativeId !== "I-2");
  const i2 = initiativeProgress(p).find((r) => r.id === "I-2");
  assert.equal(i2.total, 0);
  assert.equal(i2.percent, 0);
  assert.ok(Number.isFinite(i2.percent));
});

test("a plan with no initiatives returns no progress rows at all", () => {
  assert.deepEqual(initiativeProgress(emptyPlan()), []);
  assert.deepEqual(initiativeProgress(fullPlan(), [], []), []);
  // Existing coverage callers are untouched: fullPlan has no initiatives, so every item is
  // project-wide and planCoverage still reports exactly what it always did.
  assert.equal(planCoverage(fullPlan()).length, 5);
});

test("progress never counts an initiative id as a plan item", () => {
  const p = progressPlan();
  for (const row of initiativeProgress(p)) {
    assert.ok(!row.uncovered.some((id) => id.startsWith("I-")));
  }
});
