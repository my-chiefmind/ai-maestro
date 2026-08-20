/**
 * The lane scheduler: what may run in parallel, and what must not.
 *
 * WHY THIS EXISTS: this module trades wall-clock against merge conflicts, and the two errors
 * are not symmetric. Saying "these are related" when they aren't costs some time. Saying "these
 * are independent" when they aren't costs a conflicted merge and, in the worst case, work
 * destroyed by a resolution nobody reviewed. So every test below that looks paranoid is
 * deliberate: the scheduler must resolve toward SEQUENTIAL whenever it cannot prove otherwise,
 * and these pin that it does.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globMatches, globsIntersect, globSetsIntersect, touchesSerialFile, touchesOf,
  conflictReason, canRunInParallel, assignLanes, startableNow, parallelismLostToVagueness,
  laneCount, serialFiles, MAX_LANES, DEFAULT_LANES,
} from "../scripts/lane-core.mjs";

const T = (id, extra = {}) => ({ id, name: id, status: "todo", depends_on: [], ...extra });
const cfg = (n) => ({ orchestration: { maxWorktrees: n } });

// ── Pool sizing ─────────────────────────────────────────────────────────────────

test("the pool is capped no matter what a project asks for", () => {
  // Past a handful of lanes a human can't hold the state, and the merge order stops being
  // reviewable — so this is a ceiling, not a suggestion.
  assert.equal(laneCount(null), DEFAULT_LANES);
  assert.equal(laneCount(cfg(1)), 1);
  assert.equal(laneCount(cfg(5)), 5);
  assert.equal(laneCount(cfg(50)), MAX_LANES);
  assert.equal(laneCount(cfg(0)), 1);
  assert.equal(laneCount(cfg("many")), DEFAULT_LANES);
});

test("a project can add serial-only patterns but never remove the defaults", () => {
  const s = serialFiles({ orchestration: { serialFiles: ["infra/terraform/**"] } });
  assert.ok(s.includes("infra/terraform/**"));
  assert.ok(s.some((g) => g.includes("migrations")), "migrations must stay serial");
  assert.ok(s.some((g) => g.includes("package-lock.json")));
});

// ── Globs ───────────────────────────────────────────────────────────────────────

test("glob matching handles the forms a `touches` declaration actually uses", () => {
  assert.equal(globMatches("src/api/users.ts", "src/api/**"), true);
  assert.equal(globMatches("src/web/users.ts", "src/api/**"), false);
  assert.equal(globMatches("src/api/users.ts", "src/api/*.ts"), true);
  assert.equal(globMatches("src/api/v1/users.ts", "src/api/*.ts"), false);
  assert.equal(globMatches("db/migrations/001.sql", "**/migrations/**"), true);
});

test("sibling directories are provably disjoint; a parent and its child are not", () => {
  assert.equal(globsIntersect("src/api/**", "src/web/**"), false);
  assert.equal(globsIntersect("a/**", "b/**"), false);
  assert.equal(globsIntersect("src/**", "src/api/**"), true, "a parent contains its child");
  assert.equal(globsIntersect("src/api/**", "src/api/users.ts"), true);
  assert.equal(globsIntersect("src/api/**", "src/api/**"), true);
});

test("a wildcard-leading glob is compared by the segments it insists on", () => {
  // The failure this pins: `**/migrations/**` has no literal prefix, so a prefix-only rule
  // read it as "matches everything" and made every ticket serial — the pool became pointless.
  assert.equal(globsIntersect("src/api/**", "**/migrations/**"), false);
  assert.equal(globsIntersect("db/migrations/**", "**/migrations/**"), true);
  assert.equal(globsIntersect("**", "src/api/**"), true, "a glob constraining nothing overlaps everything");
});

test("globSetsIntersect is true if ANY pair overlaps", () => {
  assert.equal(globSetsIntersect(["src/api/**", "docs/**"], ["web/**", "docs/guide.md"]), true);
  assert.equal(globSetsIntersect(["src/api/**"], ["web/**"]), false);
});

// ── Serial-only files ───────────────────────────────────────────────────────────

test("a ticket is serial when its declaration says so, not when it conceivably could be", () => {
  assert.equal(touchesSerialFile(T("a", { touches: ["db/migrations/**"] }), null), true);
  assert.equal(touchesSerialFile(T("a", { touches: ["package-lock.json"] }), null), true);
  assert.equal(touchesSerialFile(T("a", { touches: ["prisma/schema.prisma"] }), null), true);
  // `src/**` could technically reach src/migrations/, but treating it that way makes every
  // ticket serial. Declaring your scope is what buys parallelism; this is that bargain.
  assert.equal(touchesSerialFile(T("a", { touches: ["src/**"] }), null), false);
  assert.equal(touchesSerialFile(T("a", { touches: ["src/api/**"] }), null), false);
  assert.equal(touchesSerialFile(T("a"), null), false, "declaring nothing is not declaring a migration");
});

test("touchesOf ignores junk rather than trusting it", () => {
  assert.deepEqual(touchesOf({ touches: ["  src/api/**  ", "", 42, null] }), ["src/api/**"]);
  assert.deepEqual(touchesOf({ touches: "src/**" }), []);
  assert.deepEqual(touchesOf({}), []);
});

// ── Conflict domains ────────────────────────────────────────────────────────────

test("a dependency puts two tickets in one lane, in either direction", () => {
  // A dependent builds ON the other's code, so it belongs in the same tree, after it — this is
  // a code relationship, not merely an ordering one.
  assert.ok(conflictReason(T("a", { depends_on: ["b"], area: "x" }), T("b", { area: "y" })));
  assert.ok(conflictReason(T("b", { area: "y" }), T("a", { depends_on: ["b"], area: "x" })));
});

test("declaring disjoint scopes is the ONLY way past the epic and area heuristics", () => {
  const sameEpic = [T("a", { epicId: "e1", area: "backend" }), T("b", { epicId: "e1", area: "backend" })];
  assert.ok(conflictReason(...sameEpic), "same epic, nothing declared → sequential");

  const declared = [
    T("a", { epicId: "e1", area: "backend", touches: ["src/api/**"] }),
    T("b", { epicId: "e1", area: "backend", touches: ["src/jobs/**"] }),
  ];
  assert.equal(conflictReason(...declared), null, "declared and disjoint → parallel, same epic or not");

  const overlapping = [
    T("a", { epicId: "e1", touches: ["src/**"] }),
    T("b", { epicId: "e2", touches: ["src/api/**"] }),
  ];
  assert.ok(conflictReason(...overlapping), "declared but overlapping → sequential, different epics or not");
});

test("one side declaring is not enough — both must, or the heuristics apply", () => {
  const a = T("a", { epicId: "e1", area: "backend", touches: ["src/api/**"] });
  const b = T("b", { epicId: "e1", area: "backend" });
  assert.ok(conflictReason(a, b), "a half-declared pair proves nothing");
});

test("a missing area is treated as unknown, never as independent", () => {
  // The dangerous default: two tickets with no area, no epic and no touches share nothing that
  // proves independence, so they must not run in parallel.
  assert.ok(conflictReason(T("a"), T("b")));
  assert.ok(conflictReason(T("a", { area: "backend" }), T("b")));
  assert.equal(canRunInParallel(T("a", { area: "backend" }), T("b", { area: "frontend" })), true);
});

test("a serial-only ticket conflicts with everything, including across areas", () => {
  const mig = T("a", { area: "infra", touches: ["db/migrations/**"] });
  const web = T("b", { area: "frontend", touches: ["web/**"] });
  assert.ok(conflictReason(mig, web));
  assert.ok(conflictReason(web, mig), "and in either argument order");
});

// ── Assignment ──────────────────────────────────────────────────────────────────

test("dependency chains collapse into one lane, in order", () => {
  const ready = [
    T("T-1", { area: "backend", touches: ["src/api/**"] }),
    T("T-2", { area: "backend", touches: ["src/api/**"], depends_on: ["T-1"] }),
    T("T-3", { area: "frontend", touches: ["web/**"] }),
  ];
  const { lanes } = assignLanes(ready, cfg(3));
  const chain = lanes.find((l) => l.tickets.some((t) => t.id === "T-1"));
  assert.deepEqual(chain.tickets.map((t) => t.id), ["T-1", "T-2"]);
  assert.equal(lanes.length, 2);
});

test("a full pool queues rather than opening a fourth lane", () => {
  // This is the property that keeps merges tractable: live branches = lanes, never tickets.
  const ready = ["a", "b", "c", "d", "e"].map((x, i) =>
    T(`T-${i}`, { area: x, touches: [`${x}/**`] }));
  const { lanes, capped } = assignLanes(ready, cfg(2));
  assert.equal(lanes.length, 2);
  assert.equal(capped, true);
  assert.equal(lanes.reduce((n, l) => n + l.tickets.length, 0), 5, "nothing is dropped, only queued");
});

test("a serial ticket gets an exclusive lane and waits for the pool to drain", () => {
  const ready = [
    T("T-1", { area: "backend", touches: ["src/api/**"] }),
    T("T-2", { area: "infra", touches: ["db/migrations/**"] }),
  ];
  const { lanes } = assignLanes(ready, cfg(3));
  const mig = lanes.find((l) => l.exclusive);
  assert.ok(mig, "a serial ticket must get its own exclusive lane");
  assert.deepEqual(mig.tickets.map((t) => t.id), ["T-2"]);

  const now = startableNow(ready, cfg(3));
  assert.deepEqual(now.start.map((t) => t.id), ["T-1"]);
  assert.deepEqual(now.waiting.map((t) => t.id), ["T-2"], "the migration waits, it never runs alongside");
  assert.equal(now.exclusive, null);
});

test("once the pool is empty the exclusive ticket runs, alone", () => {
  const ready = [T("T-2", { area: "infra", touches: ["db/migrations/**"] })];
  const now = startableNow(ready, cfg(3));
  assert.deepEqual(now.start.map((t) => t.id), ["T-2"]);
  assert.equal(now.exclusive.id, "T-2");
});

test("startableNow returns at most one ticket per lane", () => {
  const ready = [
    T("T-1", { area: "backend", touches: ["src/api/**"] }),
    T("T-2", { area: "backend", touches: ["src/api/**"] }),  // same scope → same lane, queued
    T("T-3", { area: "frontend", touches: ["web/**"] }),
  ];
  const now = startableNow(ready, cfg(3));
  assert.deepEqual(now.start.map((t) => t.id), ["T-1", "T-3"]);
});

test("the schedule is deterministic — same board in, same schedule out", () => {
  // The CLI shows a preview the orchestrator then acts on; if those two could differ, the
  // preview would be worse than useless.
  const ready = [
    T("T-1", { area: "backend", epicId: "e1" }),
    T("T-2", { area: "frontend", epicId: "e2" }),
    T("T-3", { area: "docs", epicId: "e3" }),
  ];
  const a = JSON.stringify(assignLanes(ready, cfg(3)));
  const b = JSON.stringify(assignLanes(ready, cfg(3)));
  assert.equal(a, b);
});

test("one lane configured means strictly sequential, the pre-lane behaviour", () => {
  const ready = [
    T("T-1", { area: "backend", touches: ["src/api/**"] }),
    T("T-2", { area: "frontend", touches: ["web/**"] }),
  ];
  const now = startableNow(ready, cfg(1));
  assert.equal(now.start.length, 1);
  assert.equal(now.start[0].id, "T-1");
});

test("an empty board schedules nothing without throwing", () => {
  assert.deepEqual(assignLanes([], cfg(3)).lanes, []);
  assert.deepEqual(startableNow([], cfg(3)).start, []);
});

// ── The actionable report ───────────────────────────────────────────────────────

test("parallelism lost to vagueness names the pairs a `touches` would free", () => {
  const ready = [
    T("T-1", { area: "backend", epicId: "e1" }),
    T("T-2", { area: "backend", epicId: "e1" }),
    T("T-3", { area: "backend", epicId: "e1", touches: ["src/api/**"] }),
    T("T-4", { area: "infra", touches: ["db/migrations/**"] }),
  ];
  const lost = parallelismLostToVagueness(ready, cfg(3));
  const pairs = lost.map((p) => `${p.a}+${p.b}`);
  assert.ok(pairs.includes("T-1+T-2"), "an undeclared same-epic pair is the actionable case");
  // A real conflict is NOT "lost to vagueness" — declaring more wouldn't help.
  assert.ok(!pairs.some((p) => p.includes("T-4")), "a serial-file conflict is not fixable by declaring");
});
