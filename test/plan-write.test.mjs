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
