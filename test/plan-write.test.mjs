/**
 * Integration tests for `maestro plan` and the scope gate's effect on the board.
 *
 * WHY THIS EXISTS: two things here fail silently if they regress.
 *
 *   1. Plan writes share the BOARD lock and re-render plan.md in the same critical section. A
 *      plan write that skipped either would let a concurrent writer's requirement disappear, or
 *      leave plan.md promising content plan.json doesn't hold — and a stale mirror is read as
 *      real by anyone who opens the file.
 *   2. The scope gate WARNS in the validator and BLOCKS at pick time. Collapse that distinction
 *      either way and something breaks: warn-everywhere means nothing is enforced, block-
 *      everywhere means you cannot jot a ticket before the plan covers it.
 *
 * Run: npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eligibleTickets, scopeBlockedTickets, validateBoard } from "../scripts/board-core.mjs";
import { readPlan } from "../scripts/plan-io.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_CLI = join(KIT, "scripts", "plan-write.mjs");

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

/** A throwaway project with a board dir and a config, and a `plan(...)` runner. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "maestro-plan-"));
  tmps.push(root);
  const boardDir = join(root, "board");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ project: { name: "demo" } }));
  writeFileSync(join(boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }));

  const plan = (args, opts = {}) =>
    execFileSync(process.execPath, [PLAN_CLI, ...args, "--board", join(boardDir, "data.json")], {
      encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...opts,
    });
  const planJson = (args) => JSON.parse(plan([...args, "--json"]));
  const read = () => readPlan(join(boardDir, "plan.json"));
  return { root, boardDir, plan, planJson, read };
}

/** Give a project a plan that actually gates. */
function seedGatingPlan(p) {
  p.plan(["set-goal", "--text", "Ship the thing.", "--metric", "10 users"]);
  p.plan(["scope", "--in", "the web app", "--out", "mobile apps"]);
  p.plan(["add", "functional", "--text", "Users can log in", "--verify", "npm test"]);
  p.plan(["add", "deliverables", "--text", "Web app"]);
}

// ── The writer ──────────────────────────────────────────────────────────────────

test("init creates plan.json and its mirror, and reports 0%", () => {
  const p = project();
  const out = p.plan(["init"]);
  assert.match(out, /0% complete/);
  assert.ok(existsSync(join(p.boardDir, "plan.json")));
  assert.ok(existsSync(join(p.boardDir, "plan.md")));
});

test("every write re-renders plan.md from plan.json", () => {
  const p = project();
  p.plan(["init"]);
  p.plan(["add", "functional", "--text", "Users can export CSV", "--verify", "npm test"]);
  const md = readFileSync(join(p.boardDir, "plan.md"), "utf8");
  // The mirror can never describe a plan that isn't on disk — they're written under one lock.
  assert.match(md, /Users can export CSV/);
  assert.match(md, /`FR-1`/);
  assert.equal(p.read().sections.functional[0].text, "Users can export CSV");
});

test("ids are assigned by the writer, in order, per section", () => {
  const p = project();
  const a = p.planJson(["add", "functional", "--text", "one", "--verify", "npm test"]);
  const b = p.planJson(["add", "functional", "--text", "two", "--verify", "npm test"]);
  const c = p.planJson(["add", "nonFunctional", "--text", "fast", "--budget", "p95 < 300ms"]);
  assert.equal(a.id, "FR-1");
  assert.equal(b.id, "FR-2");
  assert.equal(c.id, "NFR-1");
});

test("a stale --expect-version is a retryable exit 2, not a silent overwrite", () => {
  const p = project();
  p.plan(["init"]);
  const stale = p.planJson(["version"]).version;
  p.plan(["add", "functional", "--text", "moved on", "--verify", "npm test"]);

  let code = 0;
  try {
    p.plan(["add", "functional", "--text", "clobber", "--verify", "x", "--expect-version", stale], { stdio: "pipe" });
  } catch (e) { code = e.status; }
  assert.equal(code, 2, "a moved plan must be exit 2 (retryable), never a lost update");
  assert.equal(p.read().sections.functional.length, 1, "the stale write must not have landed");
});

test("a placeholder is refused, so it can't count as a filled section", () => {
  const p = project();
  let code = 0;
  try { p.plan(["add", "functional", "--text", "TBD"], { stdio: "pipe" }); } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.equal(p.read().sections.functional.length, 0);
});

test("gap-add is idempotent, so re-running a report doesn't stack duplicates", () => {
  const p = project();
  const a = p.planJson(["gap-add", "--need", "required", "--from", "atomic-report", "--text", "No rollback story"]);
  const b = p.planJson(["gap-add", "--need", "required", "--from", "atomic-report", "--text", "no rollback STORY"]);
  assert.equal(a.id, "G-1");
  assert.equal(b.id, "G-1");
  assert.equal(b.duplicate, true);
  assert.equal(p.read().sections.gaps.length, 1);
});

test("a required gap moves the percentage, and triaging it gives the points back", () => {
  const p = project();
  seedGatingPlan(p);
  const before = p.planJson(["status"]).percent;
  const raised = p.planJson(["gap-add", "--need", "required", "--from", "scale", "--text", "No stated uptime target"]);
  assert.ok(p.planJson(["status"]).percent < before);
  p.plan(["add", "nonFunctional", "--text", "Uptime", "--budget", "99.9% monthly", "--verify", "status page"]);
  const after = p.planJson(["gap-set", raised.id, "--status", "accepted", "--resolved-as", "NFR-1"]);
  assert.ok(after.percent >= before);
});

test("removing a plan item traced to by a ticket is refused without --force", () => {
  const p = project();
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [], tickets: [{ id: "T-1", name: "x", status: "todo", traces_to: ["FR-1"] }],
  }));

  let code = 0, msg = "";
  try { p.plan(["remove", "FR-1"], { stdio: "pipe" }); } catch (e) { code = e.status; msg = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(msg, /T-1/, "must name the tickets it would orphan");
  assert.equal(p.read().sections.functional.length, 1);

  const forced = p.planJson(["remove", "FR-1", "--force"]);
  assert.deepEqual(forced.orphans, ["T-1"]);
  assert.equal(p.read().sections.functional.length, 0);
});

test("questions reports the next unanswered section, in registry order", () => {
  const p = project();
  const first = p.planJson(["questions"]);
  assert.equal(first.next, "goal");
  p.plan(["set-goal", "--text", "Ship the thing.", "--metric", "10 users"]);
  assert.equal(p.planJson(["questions"]).next, "scope");
});

test("coverage names the plan items no ticket is working", () => {
  const p = project();
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [], tickets: [{ id: "T-1", name: "x", status: "todo", traces_to: ["FR-1"] }],
  }));
  const cov = p.planJson(["coverage"]);
  assert.deepEqual(cov.uncovered, ["D-1"]);
});

// ── The gate: warn on save, block on run ────────────────────────────────────────

test("the validator WARNS on an out-of-scope ticket but keeps the board valid", () => {
  const p = project();
  seedGatingPlan(p);
  const plan = p.read();
  const board = {
    epics: [],
    tickets: [
      { id: "T-1", name: "traced", status: "todo", depends_on: [], traces_to: ["FR-1"] },
      { id: "T-2", name: "untraced", status: "todo", depends_on: [] },
      { id: "T-3", name: "out", status: "todo", depends_on: [], traces_to: ["OUT-1"] },
    ],
  };
  const r = validateBoard(board, { plan });
  // You must be able to jot a ticket before the plan covers it — this is never a hard error.
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  assert.deepEqual(r.scopeBlocked.sort(), ["T-2", "T-3"]);
  assert.ok(r.warnings.some((w) => /T-2/.test(w)));
});

test("eligibility BLOCKS out-of-scope tickets only when handed a plan", () => {
  const p = project();
  seedGatingPlan(p);
  const plan = p.read();
  const board = {
    epics: [],
    tickets: [
      { id: "T-1", name: "traced", status: "todo", depends_on: [], traces_to: ["FR-1"] },
      { id: "T-2", name: "untraced", status: "todo", depends_on: [] },
      { id: "T-3", name: "excepted", status: "todo", depends_on: [], scope_exception: "owner approved" },
    ],
  };
  // No plan passed: every existing caller behaves exactly as it did before the gate existed.
  assert.deepEqual(eligibleTickets(board, []).map((t) => t.id), ["T-1", "T-2", "T-3"]);
  // Plan passed: the untraced one is refused, the excepted one still runs.
  assert.deepEqual(eligibleTickets(board, [], { plan }).map((t) => t.id), ["T-1", "T-3"]);
  assert.deepEqual(scopeBlockedTickets(board, [], plan).map((r) => r.ticket.id), ["T-2"]);
});

test("a board with no plan beside it is never gated", () => {
  const p = project();  // no plan written at all
  const plan = p.read();
  const board = { epics: [], tickets: [{ id: "T-1", name: "x", status: "todo", depends_on: [] }] };
  const r = validateBoard(board, { plan });
  assert.equal(r.scopeBlocked.length, 0);
  assert.deepEqual(eligibleTickets(board, [], { plan }).map((t) => t.id), ["T-1"]);
});

test("a malformed traces_to or an empty scope_exception is a hard error", () => {
  // Both are ticket-shape defects independent of any plan — an empty exception string would
  // silently switch the gate off for that ticket.
  const r = validateBoard({
    epics: [],
    tickets: [
      { id: "T-1", name: "x", status: "todo", traces_to: "FR-1" },
      { id: "T-2", name: "y", status: "todo", scope_exception: "   " },
    ],
  }, {});
  assert.ok(r.errors.some((e) => /T-1.*traces_to/.test(e)), r.errors.join("; "));
  assert.ok(r.errors.some((e) => /T-2.*scope_exception/.test(e)), r.errors.join("; "));
});

// ── Enforceable invariants ──────────────────────────────────────────────────────
// The distinction the whole field exists for: `verify` describes how a human would check a
// rule; `enforce` is a command that runs. A rule stated in prose is one an agent can talk
// itself past — "always include the clinic id" is a wish. The same rule as a non-zero exit is
// a fact about the repository, and it holds for human commits too.

test("plan check runs every enforce command and fails on any non-zero exit", () => {
  const p = project();
  p.plan(["add", "functional", "--text", "A holds", "--verify", "by hand", "--enforce", "true"]);
  p.plan(["add", "nonFunctional", "--text", "B holds", "--budget", "always", "--enforce", "false"]);

  let code = 0, out = "";
  try { out = p.plan(["check"], { stdio: "pipe" }); } catch (e) { code = e.status; out = String(e.stdout); }
  assert.equal(code, 1, "a violated invariant must fail the command, not warn");
  assert.match(out, /FR-1/);
  assert.match(out, /NFR-1/);
});

test("plan check passes when every invariant holds", () => {
  const p = project();
  p.plan(["add", "functional", "--text", "A holds", "--enforce", "true"]);
  const out = p.plan(["check"]);
  assert.match(out, /all 1 plan invariant\(s\) hold/);
});

test("--traces narrows to one ticket's plan items — how the release gate uses it", () => {
  const p = project();
  p.plan(["add", "functional", "--text", "A holds", "--enforce", "true"]);
  p.plan(["add", "functional", "--text", "B is broken", "--enforce", "false"]);

  // The ticket traces only to FR-1, so only FR-1's invariant is its problem.
  const scoped = p.planJson(["check", "--traces", "FR-1"]);
  assert.equal(scoped.ok, true);
  assert.equal(scoped.ran, 1);

  let code = 0;
  try { p.plan(["check", "--traces", "FR-2"], { stdio: "pipe" }); } catch (e) { code = e.status; }
  assert.equal(code, 1);
});

test("a plan with no enforce commands is not a failure — it's just unenforced", () => {
  const p = project();
  p.plan(["add", "functional", "--text", "Checked by judgment only", "--verify", "code review"]);
  const out = p.plan(["check"]);
  assert.match(out, /No plan item declares an `enforce` command/);
});

test("enforce commands run at the repo root, not the board directory", () => {
  // A plan invariant is a project-level claim ("no plaintext write reaches the DB"), so it has
  // to run where a developer would run it by hand. Running it in board/ would make every
  // path-based check silently pass.
  const p = project();
  writeFileSync(join(p.root, "marker.txt"), "at the repo root\n");
  p.plan(["add", "functional", "--text", "marker exists", "--enforce", "test -f marker.txt"]);
  const out = p.plan(["check"]);
  assert.match(out, /all 1 plan invariant\(s\) hold/);
});

test("status calls out requirements that are measurable but unenforced", () => {
  const p = project();
  p.plan(["add", "nonFunctional", "--text", "Fast", "--budget", "p95 < 300ms"]);
  const detail = p.planJson(["status"]).sections.find((s) => s.key === "nonFunctional").detail;
  assert.match(detail, /judgment/, "an NFR with a budget but no enforce should say so");
});

// ── `maestro lanes` keeps scope-blocked distinct from idle ──────────────────────
// The distinction this pins: a board with nothing left to do and a board whose every ready
// ticket is out of the plan's scope look identical unless the report says so — and only one of
// them is fixed by /plan-update. Every other surface (the orchestrator, the validator, the
// portfolio survey) keeps them apart; this one shipped in 0.2.0 conflating them.

const LANES_CLI = join(KIT, "scripts", "lane-plan.mjs");

/** Run `maestro lanes` against a project fixture. */
function lanes(p, args) {
  return execFileSync(process.execPath, [LANES_CLI, ...args, "--board", join(p.boardDir, "data.json")], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
  });
}

test("lanes names the scope-blocked tickets instead of reporting an empty board", () => {
  const p = project();
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [],
    tickets: [{ id: "T-1", name: "untraced work", status: "todo", depends_on: [] }],
  }));

  const out = lanes(p, ["plan"]);
  assert.match(out, /outside the project plan's scope/);
  assert.match(out, /T-1/);
  assert.match(out, /plan-update/, "must point at the fix, not just state the problem");
  assert.doesNotMatch(out, /Nothing is eligible to run/, "that message is for a genuinely empty board");

  const next = JSON.parse(lanes(p, ["next", "--json"]));
  assert.deepEqual(next.scopeBlocked, ["T-1"]);
  assert.deepEqual(next.start, []);
});

test("a genuinely empty board still reads as idle, not as a scope problem", () => {
  const p = project();
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [], tickets: [{ id: "T-1", name: "done", status: "done", depends_on: [], traces_to: ["FR-1"] }],
  }));
  const out = lanes(p, ["plan"]);
  assert.match(out, /Nothing is eligible to run/);
  assert.doesNotMatch(out, /outside the project plan's scope/);
});

test("a scheduled board still reports what the plan is holding back", () => {
  const p = project();
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [],
    tickets: [
      { id: "T-1", name: "in scope", status: "todo", depends_on: [], area: "backend", traces_to: ["FR-1"] },
      { id: "T-2", name: "untraced", status: "todo", depends_on: [], area: "frontend" },
    ],
  }));
  const out = lanes(p, ["plan"]);
  assert.match(out, /Starting now: T-1/);
  assert.match(out, /never scheduled: T-2/);
});

// ── Initiatives through the plan CLI (T-025) ────────────────────────────────────
//
// Two things here are load-bearing beyond "the flags work". First, the REVERSE PREFLIGHT: a
// plan write can invalidate the board, because plan.json and data.json are separate files
// behind separate locks with no cross-file transaction. Second, `initiative-remove` has no
// --force, unlike every other removal in this CLI — a dangling trace is a state the
// orchestrator simply refuses, while a dangling initiative is one nothing can mean.

/** Seed a plan with I-1/I-2, FR-1 (I-1), FR-2 (I-2), and a project-wide NFR-1. */
function seedInitiatives(p) {
  p.plan(["init"]);
  p.plan(["set-goal", "--text", "Ship the thing.", "--metric", "10 users"]);
  p.plan(["initiative-add", "--name", "Onboarding", "--outcome", "Customers activate", "--metric", "80% self-serve", "--in", "Registration", "--out", "Billing"]);
  p.plan(["initiative-add", "--name", "Billing", "--outcome", "Invoices reconcile"]);
  p.plan(["add", "functional", "--initiative", "I-1", "--text", "Verify email", "--verify", "npm test"]);
  p.plan(["add", "functional", "--initiative", "I-2", "--text", "Reconcile ledger", "--verify", "npm test"]);
  p.plan(["add", "nonFunctional", "--text", "No PII in logs", "--budget", "zero"]);
}

/** Put an epic + ticket on the board, both in I-1 and tracing FR-1. */
function seedBoardUnder(p, epic = { id: "e1", initiativeId: "I-1", traces_to: ["FR-1"] }) {
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({
    epics: [{ name: "Registration", ...epic }],
    tickets: [{ id: "T-001", epicId: epic.id, name: "Verify email", area: "backend", priority: "P2", swag: "S", status: "todo", agent_plan: ["backend"], model: "sonnet", depends_on: [], traces_to: ["FR-1"] }],
  }, null, 2));
}

test("initiative-add allocates max-plus-one and stores every repeatable flag", () => {
  const p = project();
  seedInitiatives(p);
  const [i1, i2] = p.read().sections.initiatives;
  assert.equal(i1.id, "I-1");
  assert.equal(i2.id, "I-2");
  assert.deepEqual(i1.metrics, ["80% self-serve"]);
  assert.deepEqual(i1.scope, { in: ["Registration"], out: ["Billing"] });
  assert.deepEqual(i1.depends_on, []);
});

test("an initiative needs an outcome, not just a name", () => {
  const p = project();
  p.plan(["init"]);
  assert.throws(() => p.plan(["initiative-add", "--name", "Nameless"]), /--outcome is required/);
  assert.throws(() => p.plan(["initiative-add", "--outcome", "x"]), /--name is required/);
  assert.equal(p.read().sections.initiatives.length, 0);
});

test("initiative-edit replaces list flags rather than appending", () => {
  const p = project();
  seedInitiatives(p);
  p.plan(["initiative-edit", "I-1", "--metric", "a", "--metric", "b"]);
  assert.deepEqual(p.read().sections.initiatives[0].metrics, ["a", "b"]);
  p.plan(["initiative-edit", "I-1", "--metric", "c"]);
  assert.deepEqual(p.read().sections.initiatives[0].metrics, ["c"], "replace — an appending flag could never remove one");
});

test("a dependency must exist, may not be the initiative itself, and leaves no stale lock", () => {
  const p = project();
  seedInitiatives(p);
  assert.throws(() => p.plan(["initiative-edit", "I-2", "--depends-on", "I-2"]), /cannot depend on itself/);
  assert.throws(() => p.plan(["initiative-edit", "I-2", "--depends-on", "I-9"]), /is not an initiative in this plan/);
  // These checks run INSIDE the board lock. Rejecting with process.exit would skip the finally
  // that releases it and strand every later writer for the full lock timeout.
  assert.ok(!existsSync(join(p.boardDir, ".board.lock")), "the lock was released on rejection");
  p.plan(["initiative-edit", "I-2", "--depends-on", "I-1"]);
  assert.deepEqual(p.read().sections.initiatives[1].depends_on, ["I-1"]);
});

test("plan items can be assigned, moved and cleared", () => {
  const p = project();
  seedInitiatives(p);
  assert.equal(p.read().sections.functional[0].initiativeId, "I-1");
  p.plan(["edit", "FR-1", "--initiative", "I-2"]);
  assert.equal(p.read().sections.functional[0].initiativeId, "I-2");
  p.plan(["edit", "FR-1", "--clear-initiative"]);
  assert.equal(p.read().sections.functional[0].initiativeId, undefined, "cleared means project-wide");
  assert.throws(() => p.plan(["edit", "FR-1", "--initiative", "I-2", "--clear-initiative"]), /contradict each other/);
  assert.throws(() => p.plan(["edit", "FR-1", "--initiative", "I-9"]), /does not define initiative I-9/);
});

test("ownership is refused on sections that stay project-level", () => {
  const p = project();
  seedInitiatives(p);
  assert.throws(() => p.plan(["add", "openQuestions", "--text", "Who owns support?", "--initiative", "I-1"]),
    /does not apply to "openQuestions"/);
});

test("REVERSE PREFLIGHT: a plan write that would strand a board trace is refused", () => {
  const p = project();
  seedInitiatives(p);
  seedBoardUnder(p); // e1 + T-001 are in I-1 and trace FR-1, which I-1 owns
  const before = readFileSync(join(p.boardDir, "plan.json"), "utf8");

  let err;
  try { p.plan(["edit", "FR-1", "--initiative", "I-2"]); } catch (e) { err = e; }
  assert.ok(err, "moving FR-1 to I-2 strands both the epic and the ticket");
  const msg = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  // Every conflicting id, not just the first: one run has to tell the user the whole job.
  assert.match(msg, /2 board reference\(s\) would break/);
  assert.match(msg, /Epic e1 belongs to initiative I-1, but traces to FR-1 owned by I-2/);
  assert.match(msg, /T-001 belongs to initiative I-1 through epic e1, but traces to FR-1 owned by I-2/);
  assert.match(msg, /nothing has been written/);
  assert.equal(readFileSync(join(p.boardDir, "plan.json"), "utf8"), before, "the plan is byte-identical");
});

test("the preflight allows a move that leaves the board consistent", () => {
  const p = project();
  seedInitiatives(p);
  seedBoardUnder(p, { id: "e1", initiativeId: "I-2", traces_to: [] });
  // T-001 still traces FR-1 through an I-2 epic, so re-home FR-1 to match: now consistent.
  p.plan(["edit", "FR-1", "--initiative", "I-2"]);
  assert.equal(p.read().sections.functional[0].initiativeId, "I-2");
});

test("the preflight sees ARCHIVED epics too", () => {
  const p = project();
  seedInitiatives(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(p.boardDir, "archive.json"), JSON.stringify({
    epics: [{ id: "eA", initiativeId: "I-1", name: "Landed", traces_to: ["FR-1"] }], tickets: [],
  }));
  assert.throws(() => p.plan(["edit", "FR-1", "--initiative", "I-2"]), /archive: Epic eA belongs to initiative I-1/);
});

test("the preflight sees ARCHIVED TICKETS, even when the archived epic never traced the item", () => {
  // The subtle case: nothing LIVE references FR-1 at all, and the archived epic does not trace
  // it either — only the archived ticket underneath it does. Miss this and the plan write
  // succeeds while finished work is silently re-attributed: planCoverage reads archived traces,
  // and initiativeProgress groups those rows by the ITEM's owner, so I-2 would start reporting
  // delivery for work I-1 actually did. An archived ticket cannot be re-traced afterwards —
  // archived work is history and has no editing op — so this is the only place to catch it.
  const p = project();
  seedInitiatives(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(p.boardDir, "archive.json"), JSON.stringify({
    epics: [{ id: "eA", initiativeId: "I-1", name: "Landed registration" }], // no traces_to
    tickets: [{ id: "T-900", epicId: "eA", status: "done", traces_to: ["FR-1"] }],
  }));

  let err;
  try { p.plan(["edit", "FR-1", "--initiative", "I-2"]); } catch (e) { err = e; }
  assert.ok(err, "moving FR-1 strands the archived ticket that delivered it");
  const msg = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  assert.match(msg, /archive: T-900 belongs to initiative I-1 through epic eA, but traces to FR-1 owned by I-2/);
  assert.equal(p.read().sections.functional[0].initiativeId, "I-1", "nothing was written");
});

test("an archived ticket whose trace stays consistent does not block a plan move", () => {
  const p = project();
  seedInitiatives(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(p.boardDir, "archive.json"), JSON.stringify({
    epics: [{ id: "eA", initiativeId: "I-2", name: "Landed billing" }],
    tickets: [{ id: "T-900", epicId: "eA", status: "done", traces_to: ["FR-1"] }],
  }));
  // T-900 sits in I-2 and traces FR-1; moving FR-1 into I-2 makes history consistent, not less.
  p.plan(["edit", "FR-1", "--initiative", "I-2"]);
  assert.equal(p.read().sections.functional[0].initiativeId, "I-2");
});

test("initiative-remove refuses while anything still references it, and offers no --force", () => {
  const p = project();
  seedInitiatives(p);
  seedBoardUnder(p);
  p.plan(["initiative-edit", "I-2", "--depends-on", "I-1"]);

  let err;
  try { p.plan(["initiative-remove", "I-1"]); } catch (e) { err = e; }
  const msg = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  assert.match(msg, /plan item FR-1/);
  assert.match(msg, /initiative I-2 depends_on it/);
  assert.match(msg, /epic e1/);
  assert.match(msg, /There is no --force/);
  // --force must not be a hidden escape hatch either.
  assert.throws(() => p.plan(["initiative-remove", "I-1", "--force"]), /still referenced by/);
  assert.equal(p.read().sections.initiatives.length, 2);
});

test("initiative-remove succeeds once nothing references it", () => {
  const p = project();
  seedInitiatives(p);
  p.plan(["edit", "FR-2", "--clear-initiative"]);
  p.plan(["initiative-remove", "I-2"]);
  assert.deepEqual(p.read().sections.initiatives.map((i) => i.id), ["I-1"]);
});

test("initiative ops honour --dry-run, --json and --expect-version", () => {
  const p = project();
  seedInitiatives(p);
  const before = readFileSync(join(p.boardDir, "plan.json"), "utf8");

  p.plan(["initiative-add", "--name", "Ghost", "--outcome", "never written", "--dry-run"]);
  assert.equal(readFileSync(join(p.boardDir, "plan.json"), "utf8"), before, "dry-run writes nothing");

  const r = p.planJson(["initiative-edit", "I-1", "--name", "Renamed"]);
  assert.equal(r.ok, true);
  assert.equal(r.id, "I-1");

  let err;
  try { p.plan(["initiative-edit", "I-1", "--name", "Stale", "--expect-version", "sha256:deadbeef"]); } catch (e) { err = e; }
  assert.equal(err.status, 2, "contended, so the caller re-reads and retries");
});

test("plan.md regenerates in the same write and shows the initiative structure", () => {
  const p = project();
  seedInitiatives(p);
  const md = readFileSync(join(p.boardDir, "plan.md"), "utf8");
  assert.match(md, /## Project-wide plan items/);
  assert.match(md, /### `I-1` Onboarding/);
  assert.match(md, /### `I-2` Billing/);
  assert.ok(md.indexOf("NFR-1") < md.indexOf("### `I-1`"), "project-wide items render before the initiatives");
});

test("coverage and status report per-initiative delivery", () => {
  const p = project();
  seedInitiatives(p);
  writeFileSync(join(p.boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(p.boardDir, "archive.json"), JSON.stringify({
    epics: [], tickets: [{ id: "T-900", status: "done", traces_to: ["FR-1"] }],
  }));
  const cov = p.planJson(["coverage"]);
  const i1 = cov.initiatives.find((i) => i.id === "I-1");
  assert.equal(i1.percent, 100, "FR-1 is I-1's only scored item and a landed ticket delivered it");
  assert.equal(cov.initiatives.find((i) => i.id === "I-2").percent, 0);
  assert.equal(cov.projectWide.total, 1, "NFR-1 is counted once, outside every initiative");

  const human = p.plan(["coverage"]);
  assert.match(human, /I-1 Onboarding — 100% delivered/);
  assert.match(human, /Project-wide — 0% delivered/);
  assert.match(p.plan(["status"]), /Initiatives — delivery is derived from the board/);
});

test("a plan with no initiatives reports exactly as it did before", () => {
  const p = project();
  p.plan(["init"]);
  seedGatingPlan(p);
  const cov = p.planJson(["coverage"]);
  assert.deepEqual(cov.initiatives, []);
  assert.equal(cov.projectWide, null);
  assert.ok(!p.plan(["status"]).includes("Initiatives —"), "no empty initiative block on a legacy plan");
});
