/**
 * NFR-1: an initiative-free project behaves exactly as it did before the initiative layer.
 *
 * WHY THIS EXISTS AND WHY IT IS SHAPED THIS WAY. Every ticket in e5 claimed backward
 * compatibility, and every one of them "verified" it by running its own new tests. That proves
 * the new code agrees with itself. It does not prove a project that never asked for
 * initiatives sees the same numbers it saw before — which is the actual promise, and the one
 * a user would notice being broken: a completeness percentage that moved, a ticket that used
 * to be eligible and now isn't, a lane plan that changed shape.
 *
 * So the expected values in test/fixtures/legacy-project.pre-e5.json were produced by running
 * the fixture through scripts/plan-core.mjs, board-core.mjs and lane-core.mjs AS THEY WERE AT
 * v0.2.6 (commit 2ad84f7, the last release before e5). They are not what today's code happens
 * to output. Regenerating them from current code would turn this file into a tautology, which
 * is the failure mode it exists to avoid — see the note at the bottom.
 *
 * The fixture deliberately exercises every surface the promise covers: a gating plan with all
 * sections, gaps in three states, tickets in every scope state (in-scope, untraced, dangling
 * trace, OUT-, exception), a dependency into the archive, an area model floor, and `touches`
 * both disjoint and overlapping so lane assignment has real work to do.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planCompleteness, planCoverage, scopeVerdict, planIsGating, renderPlanMd, normalisePlan,
} from "../scripts/plan-core.mjs";
import { validateBoard, eligibleTickets, initiativeModeActive } from "../scripts/board-core.mjs";
import { assignLanes, startableNow, parallelismLostToVagueness } from "../scripts/lane-core.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = JSON.parse(readFileSync(join(FIXTURES, "legacy-project.json"), "utf8"));
const pre = JSON.parse(readFileSync(join(FIXTURES, "legacy-project.pre-e5.json"), "utf8"));
const { plan, board, archive, config } = fx;

test("the fixture really is initiative-free, or it proves nothing", () => {
  assert.equal(plan.sections.initiatives, undefined, "no initiatives key at all — a plan written before the layer existed");
  assert.equal(initiativeModeActive(plan), false);
  assert.ok(!board.epics.some((e) => e.initiativeId), "no epic carries an initiativeId");
  assert.equal(planIsGating(plan), pre.gating, "and the scope gate is on, so the verdicts below mean something");
});

test("the completeness percentage is unchanged", () => {
  const now = planCompleteness(plan);
  assert.equal(now.percent, pre.completeness.percent);
  assert.equal(now.earned, pre.completeness.earned);
  // The denominator is the one initiatives could most easily have moved: a section with any
  // weight would have enlarged it for every project that never opted in.
  assert.equal(now.possible, pre.completeness.possible);
  assert.deepEqual(now.missing, pre.completeness.missing);

  // The ONE permitted difference in this whole file, stated rather than asserted away: the
  // sections array gains a descriptive `initiatives` row. It is weight 0 and counts:false, so
  // it moves no number — and it has to be there, because it is how a project that has never
  // used initiatives discovers the layer exists (the Plan tab renders this list).
  const added = now.sections.filter((s) => !pre.completeness.sections.some((o) => o.key === s.key));
  assert.deepEqual(added.map((s) => s.key), ["initiatives"]);
  assert.deepEqual(added[0], { key: "initiatives", label: "Initiatives", weight: 0, filled: false, counts: false, count: 0, detail: "" });
  assert.deepEqual(
    now.sections.filter((s) => s.key !== "initiatives"),
    pre.completeness.sections,
    "every other per-section row the Plan tab renders is untouched",
  );
  assert.deepEqual(
    now.sections.filter((s) => s.counts),
    pre.completeness.sections.filter((s) => s.counts),
    "and the scoring rows — the ones that produce the percentage — are identical",
  );
});

test("coverage reports the same rows for the same tickets", () => {
  assert.deepEqual(
    planCoverage(plan, board.tickets, archive.tickets).map(({ initiativeId, ...rest }) => rest),
    pre.coverage,
    "the only permitted difference is the additive initiativeId field",
  );
  // …and that field is null everywhere, i.e. every item is project-wide.
  assert.ok(planCoverage(plan, board.tickets, archive.tickets).every((r) => r.initiativeId === null));
});

test("every scope verdict is unchanged, state and reason", () => {
  const now = board.tickets.map((t) => ({ id: t.id, ...scopeVerdict(t, plan) }));
  assert.deepEqual(now, pre.verdicts);
  // Named explicitly so a regression says WHICH state broke rather than dumping a diff.
  const byId = new Map(now.map((v) => [v.id, v.state]));
  assert.equal(byId.get("T-001"), "in-scope");
  assert.equal(byId.get("T-003"), "untraced");
  assert.equal(byId.get("T-004"), "unknown");
  assert.equal(byId.get("T-005"), "out");
  assert.equal(byId.get("T-006"), "exception");
});

test("the validator produces the same errors, warnings and counts", () => {
  const v = validateBoard(board, { archived: archive.tickets, archivedEpics: archive.epics, config, plan });
  assert.deepEqual(v.errors, pre.validate.errors);
  // Warnings matter as much as errors here: they are what a user reads after `npm run
  // validate`, and a new one appearing on an untouched board is exactly the churn NFR-1 forbids.
  assert.deepEqual(v.warnings, pre.validate.warnings);
  assert.equal(v.eligibleCount, pre.validate.eligibleCount);
  assert.deepEqual(v.scopeBlocked, pre.validate.scopeBlocked);
});

test("the same tickets are eligible, with and without the plan", () => {
  assert.deepEqual(eligibleTickets(board, archive.tickets, { plan }).map((t) => t.id), pre.eligible);
  // Without a plan the gate is off entirely — pinned because ownership must not sneak in
  // through a path that never asked for it.
  assert.deepEqual(
    eligibleTickets(board, archive.tickets).map((t) => t.id),
    board.tickets.filter((t) => t.status === "todo").map((t) => t.id),
  );
});

test("lane assignment is byte-for-byte identical", () => {
  const ready = eligibleTickets(board, archive.tickets, { plan });
  assert.deepEqual(assignLanes(ready, config), pre.lanes);
  assert.deepEqual(startableNow(ready, config), pre.startable);
  assert.equal(parallelismLostToVagueness(ready, config).length, pre.vagueness);
});

test("plan.md renders the same bytes", () => {
  assert.equal(renderPlanMd(plan, "Compat Fixture"), pre.planMd);
});

test("normalisation adds initiatives in memory and changes nothing else", () => {
  const n = normalisePlan(plan);
  assert.deepEqual(n.sections.initiatives, [], "the only in-memory addition");
  assert.equal(n.planVersion, 1, "and the file is not migrated to a new generation");
  for (const key of ["goal", "scope", "deliverables", "useCases", "functional", "nonFunctional", "milestones", "risks", "gaps", "openQuestions"]) {
    assert.deepEqual(n.sections[key], plan.sections[key] ?? n.sections[key], `${key} survived normalisation unchanged`);
  }
});

test("the expected values were NOT generated by the code under test", () => {
  // A guard against the one edit that would quietly void this whole file: regenerating the
  // fixture from current output whenever it fails. The provenance note is the only thing
  // standing between "compatibility proven" and "today's code agrees with itself".
  const raw = readFileSync(join(FIXTURES, "legacy-project.pre-e5.json"), "utf8");
  assert.ok(raw.includes("2ad84f7"), "the fixture must record the commit its values came from");
  assert.ok(raw.includes("DO NOT REGENERATE"), "and must say plainly that it is not to be refreshed from current code");
});
