/**
 * The scope gate, as the orchestrate Workflow actually enforces it.
 *
 * WHY THIS EXISTS: the gate has two enforcement paths. The `/orchestrator` skill path gets it
 * from eligibleTickets(…, {plan}) in scripts/board-core.mjs — covered by test/plan-write.test.mjs.
 * The HARNESS path is this generated Workflow script, which can import nothing (no filesystem
 * access) and therefore restates the rule locally. Restated logic drifts silently, and the
 * failure mode is the worst kind: a gate that looks enforced everywhere and is actually
 * advisory in half the runs. These tests pin the harness copy against the same six verdict
 * states scripts/plan-core.mjs defines.
 *
 * Same technique as test/orchestrator-lease.test.mjs: render a real project and extract the
 * pure functions from the GENERATED artifact, so what's tested is what ships.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = join(KIT, "render", "sync.mjs");

const tmp = mkdtempSync(join(tmpdir(), "orch-scope-"));
const proj = join(tmp, "proj");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "config.json"), JSON.stringify({
  project: { name: "fixture", areas: ["backend"] },
  roster: ["orchestrator", "principal-engineer", "backend-developer", "qa", "principal-delivery"],
  targets: { workflow: true },
}));
writeFileSync(join(proj, "context.md"), "ctx\n");
const r = spawnSync(process.execPath, [SYNC, "--project", proj, "--kit", KIT], { encoding: "utf8" });
if (r.status !== 0) throw new Error(`sync failed:\n${r.stdout}${r.stderr}`);
const artifact = readFileSync(join(proj, ".claude", "workflows", "orchestrate.js"), "utf8");
rmSync(tmp, { recursive: true, force: true });

function extract(name) {
  const m = artifact.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `function ${name} must exist in the generated workflow`);
  return new Function(`return ${m[0]}`)();
}
const scopeOf = extract("scopeOf");

// pickNextTicket/scopeBlocked call the other helpers, so they're instantiated together in one
// scope rather than extracted individually.
const selection = new Function(`
  ${artifact.match(/^function resolveDeps\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function depsMet\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function ticketIsHumanGated\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function scopeOf\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function readyTickets\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function scopeBlocked\([\s\S]*?^\}/m)[0]}
  ${artifact.match(/^function pickNextTicket\([\s\S]*?^\}/m)[0]}
  return { pickNextTicket, scopeBlocked, readyTickets };
`)();

const GATING = { gating: true, inScopeIds: ["D-1", "UC-1", "FR-1", "NFR-1"], outIds: ["OUT-1"] };

/** @param {object[]} tickets @param {object|null} plan */
const boardOf = (tickets, plan = GATING) => ({ epics: [], tickets, archiveTickets: [], plan });
const todo = (id, extra = {}) => ({ id, name: id, status: "todo", priority: "P1", depends_on: [], ...extra });

// ── The six verdict states ──────────────────────────────────────────────────────

test("the harness recognises the same six scope states as plan-core", () => {
  const b = boardOf([]);
  const cases = [
    [{ traces_to: ["FR-1"] }, "in-scope", false],
    [{ traces_to: ["D-1", "UC-1"] }, "in-scope", false],
    [{}, "untraced", true],
    [{ traces_to: [] }, "untraced", true],
    [{ traces_to: ["FR-99"] }, "unknown", true],
    [{ traces_to: ["OUT-1"] }, "out", true],
    [{ traces_to: ["FR-1", "OUT-1"] }, "out", true],
    [{ scope_exception: "owner approved a spike" }, "exception", false],
  ];
  for (const [ticket, state, blocks] of cases) {
    const v = scopeOf(ticket, b);
    assert.equal(v.state, state, `${JSON.stringify(ticket)} -> ${v.state}`);
    assert.equal(v.blocks, blocks, `${JSON.stringify(ticket)} blocks=${v.blocks}`);
  }
});

test("the gate fails OPEN — no plan, and a plan the tooling couldn't read, both run", () => {
  // Refusing every ticket because a command errored is a far worse failure mode than running
  // one the plan hasn't caught up with, so readBoard reports gating=false on failure.
  // Built explicitly rather than through boardOf's default parameter, which would quietly
  // substitute a gating plan for the `undefined` case and make this test pass for the wrong
  // reason.
  const boards = [
    { epics: [], tickets: [], archiveTickets: [], plan: null },
    { epics: [], tickets: [], archiveTickets: [] },                  // key absent entirely
    { epics: [], tickets: [], archiveTickets: [], plan: { gating: false, inScopeIds: [], outIds: [] } },
  ];
  for (const b of boards) {
    const v = scopeOf({ id: "T-1" }, b);
    assert.equal(v.blocks, false);
    assert.equal(v.state, "no-plan");
  }
});

test("an empty scope_exception does not clear the gate", () => {
  assert.equal(scopeOf({ traces_to: [], scope_exception: "   " }, boardOf([])).blocks, true);
});

// ── Selection ───────────────────────────────────────────────────────────────────

test("pickNextTicket never returns an out-of-scope ticket", () => {
  const b = boardOf([
    todo("T-001", { priority: "P0" }),                         // untraced, and the highest priority
    todo("T-002", { priority: "P0", traces_to: ["OUT-1"] }),   // explicitly excluded
    todo("T-003", { priority: "P2", traces_to: ["FR-1"] }),    // the only one in scope
  ]);
  // P0 ordering must not override the gate — that would make priority a way around the plan.
  assert.equal(selection.pickNextTicket(b).id, "T-003");
  assert.deepEqual(selection.scopeBlocked(b).map((t) => t.id), ["T-001", "T-002"]);
});

test("scope filtering composes with dependencies and human gates", () => {
  const b = boardOf([
    todo("T-001", { traces_to: ["FR-1"], depends_on: ["T-009"] }),      // dep not done
    todo("T-002", { traces_to: ["FR-1"], human_gate: "owner sign-off" }),
    todo("T-003", { traces_to: ["FR-1"] }),
  ]);
  assert.equal(selection.pickNextTicket(b).id, "T-003");
  // Neither is scope-blocked — they're held for other reasons, and conflating the two would
  // send a human to /plan-update over a dependency problem.
  assert.deepEqual(selection.scopeBlocked(b).map((t) => t.id), []);
});

test("idle and scope-blocked stay distinguishable", () => {
  // "Nothing to do" and "things to do, none of them in the plan" call for opposite responses.
  const empty = boardOf([todo("T-001", { status: "done", traces_to: ["FR-1"] })]);
  assert.equal(selection.pickNextTicket(empty), null);
  assert.deepEqual(selection.scopeBlocked(empty), [], "a board with no ready work is idle, not scope-blocked");

  const blocked = boardOf([todo("T-001")]);
  assert.equal(selection.pickNextTicket(blocked), null);
  assert.deepEqual(selection.scopeBlocked(blocked).map((t) => t.id), ["T-001"]);
});

test("with no plan, selection behaves exactly as it did before the gate existed", () => {
  const b = boardOf([todo("T-001"), todo("T-002")], null);
  assert.equal(selection.pickNextTicket(b).id, "T-001");
  assert.deepEqual(selection.scopeBlocked(b), []);
});

// ── The wiring that feeds it ────────────────────────────────────────────────────

test("the generated workflow reads the boundary from `maestro plan gate`, not from the model", () => {
  // The whole point of shelling out: "what counts as in scope" is decided once, in
  // scripts/plan-core.mjs. An agent re-deriving it from plan.json per run is how two callers
  // end up disagreeing about whether a ticket may run.
  assert.match(artifact, /PLAN_CMD:\s+"node .*plan-write\.mjs"/, "sync must inject a real PLAN_CMD");
  assert.match(artifact, /\$\{PLAN_CMD\} gate --board \$\{BOARD\} --json/);
  assert.match(artifact, /do NOT read\s*\n?\s*plan\.json yourself/);
  assert.match(artifact, /gating:false,inScopeIds:\[\],outIds:\[\]/, "a tooling failure must leave the gate off, not block everything");
});

test("naming a ticket explicitly does not bypass the gate", () => {
  // Otherwise the gate is advisory for anyone who knows a ticket id — which is everyone
  // reading the board.
  const doStart = artifact.match(/^async function doStart\(id\)[\s\S]*?^\}/m);
  assert.ok(doStart, "doStart must exist");
  assert.match(doStart[0], /scopeOf\(ticket, board\)/);
  assert.match(doStart[0], /--scope-exception/, 'the refusal must tell the caller how to override it');
});
