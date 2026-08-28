/**
 * The cockpit's half of the initiative layer (T-027), pinned against a REAL server.
 *
 * WHY A SEPARATE SERVER: these tests write plans, and cockpit-server.test.mjs runs against the
 * repo's own board dir. Pointing this one at a throwaway project via MAESTRO_BOARD_DIR is what
 * makes "the save was refused and nothing was written" an assertion rather than a hazard.
 *
 * The load-bearing claim here is that the cockpit is NOT the looser of the two writers. The
 * plan CLI refuses an ownership change that would strand a board reference; if the UI could
 * make the same change, the guard would be decorative — anyone hitting it would simply open
 * the other door. Both now call crossInitiativeConflicts in scripts/board-core.mjs.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(KIT, "cockpit", "server", "index.mjs");
const PORT = 4707; // distinct from the default and from cockpit-server.test.mjs
const ORIGIN = `http://127.0.0.1:${PORT}`;

const SKIP = existsSync(join(KIT, "cockpit", "node_modules"))
  ? false
  : "cockpit deps not installed — run `npm run cockpit:install` to exercise these";
if (SKIP) console.error(`\n⚠ cockpit-plan-initiatives tests SKIPPED: ${SKIP}\n`);

let proc;
let boardDir;
const plan = () => JSON.parse(readFileSync(join(boardDir, "plan.json"), "utf8"));

/** I-1/I-2, FR-1 (I-1), FR-2 (I-2), project-wide NFR-1; e1+T-001 sit in I-1 tracing FR-1. */
function seed(root) {
  boardDir = join(root, "board");
  mkdirSync(boardDir, { recursive: true });
  const w = (f, o) => writeFileSync(join(boardDir, f), JSON.stringify(o, null, 2));
  w("plan.json", {
    planVersion: 1,
    sections: {
      goal: { text: "Ship it.", metrics: [] },
      scope: { in: [], out: [] },
      initiatives: [
        { id: "I-1", name: "Onboarding", outcome: "Customers activate", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
        { id: "I-2", name: "Billing", outcome: "Invoices reconcile", scope: { in: [], out: [] }, metrics: [], depends_on: [] },
      ],
      deliverables: [], useCases: [],
      functional: [
        { id: "FR-1", initiativeId: "I-1", text: "Verify email", verify: "npm test" },
        { id: "FR-2", initiativeId: "I-2", text: "Reconcile", verify: "npm test" },
      ],
      nonFunctional: [{ id: "NFR-1", text: "No PII in logs", budget: "zero" }],
      milestones: [], risks: [], gaps: [], openQuestions: [],
    },
  });
  w("data.json", {
    epics: [{ id: "e1", initiativeId: "I-1", name: "Registration", traces_to: ["FR-1"] }],
    tickets: [{ id: "T-001", epicId: "e1", name: "Verify", area: "backend", priority: "P2", swag: "S", status: "todo", agent_plan: ["backend"], model: "sonnet", depends_on: [], traces_to: ["FR-1"] }],
  });
  w("archive.json", { epics: [], tickets: [] });
}

before(async () => {
  if (SKIP) return;
  const root = mkdtempSync(join(tmpdir(), "cockpit-init-"));
  seed(root);
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), MAESTRO_BOARD_DIR: boardDir },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${ORIGIN}/api/board/version`); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error("cockpit server did not start");
});

after(() => {
  if (SKIP) return;
  proc?.kill();
  if (boardDir) rmSync(dirname(boardDir), { recursive: true, force: true });
});

const getPlan = async () => (await fetch(`${ORIGIN}/api/plan`)).json();
async function putSection(key, value, version) {
  const r = await fetch(`${ORIGIN}/api/plan/section/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, version }),
  });
  return { status: r.status, body: await r.json() };
}

test("GET /api/plan reports per-initiative progress and item ownership", { skip: SKIP }, async () => {
  const p = await getPlan();
  assert.equal(p.sections.find((s) => s.key === "initiatives").kind, "initiatives",
    "the section registry drives the UI — the tab needs the kind to render the right editor");
  assert.deepEqual(p.initiatives.map((i) => i.id), ["I-1", "I-2"]);
  assert.equal(p.projectWide.total, 1, "NFR-1 is counted once, outside every initiative");
  assert.equal(p.coverage.find((c) => c.id === "FR-1").initiativeId, "I-1");
  assert.equal(p.coverage.find((c) => c.id === "NFR-1").initiativeId, null);
});

test("the server assigns initiative ids inside the lock, never the tab", { skip: SKIP }, async () => {
  const before = await getPlan();
  const rows = [...before.plan.sections.initiatives, { id: "", name: "Reporting", outcome: "Owners see delivery", scope: { in: [], out: [] }, metrics: [], depends_on: [] }];
  const r = await putSection("initiatives", rows, before.version);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const added = r.body.plan.sections.initiatives.at(-1);
  assert.equal(added.id, "I-3", "max-plus-one from the plan on disk");
  // Clean up so later tests see the seeded shape.
  await putSection("initiatives", before.plan.sections.initiatives, r.body.version);
});

test("an initiative with no name is dropped rather than written blank", { skip: SKIP }, async () => {
  const before = await getPlan();
  const r = await putSection("initiatives", [...before.plan.sections.initiatives, { id: "", name: "  ", outcome: "x", scope: { in: [], out: [] }, metrics: [], depends_on: [] }], before.version);
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.sections.initiatives.length, 2);
});

test("item ownership can be set and cleared through the section route", { skip: SKIP }, async () => {
  const before = await getPlan();
  const rows = before.plan.sections.nonFunctional.map((i) => ({ ...i, initiativeId: "I-2" }));
  const set = await putSection("nonFunctional", rows, before.version);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.plan.sections.nonFunctional[0].initiativeId, "I-2");
  assert.equal(set.body.projectWide.total, 0, "it is no longer project-wide");

  const cleared = await putSection("nonFunctional", before.plan.sections.nonFunctional, set.body.version);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.plan.sections.nonFunctional[0].initiativeId, undefined);
});

test("REVERSE PREFLIGHT: the cockpit is refused the same ownership move the CLI refuses", { skip: SKIP }, async () => {
  // Moving FR-1 to I-2 strands epic e1 and ticket T-001, both of which sit in I-1.
  const before = await getPlan();
  const onDisk = readFileSync(join(boardDir, "plan.json"), "utf8");
  const rows = before.plan.sections.functional.map((i) => (i.id === "FR-1" ? { ...i, initiativeId: "I-2" } : i));
  const r = await putSection("functional", rows, before.version);

  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /2 board reference\(s\) would break/);
  assert.match(r.body.error, /Epic e1 belongs to initiative I-1, but traces to FR-1 owned by I-2/);
  assert.match(r.body.error, /T-001 belongs to initiative I-1 through epic e1/);
  assert.equal(readFileSync(join(boardDir, "plan.json"), "utf8"), onDisk, "the plan on disk is byte-identical");
  // The 400 body carries no replacement plan, so the tab keeps the user's in-progress edits —
  // only a 409 conflict hands back `current` and asks for a reapply.
  assert.equal(r.body.current, undefined);
});

test("ownership on a project-level section is refused, not silently discarded", { skip: SKIP }, async () => {
  // A 200 that quietly drops the field tells the caller their edit landed when it did not, and
  // the CLI refuses the same request outright — accepting it here would make the two writers
  // disagree about what is legal.
  const before = await getPlan();
  const r = await putSection("openQuestions", [{ id: "", text: "Who owns support?", initiativeId: "I-1" }], before.version);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Initiative ownership does not apply to "openQuestions"/);
  assert.equal((await getPlan()).plan.sections.openQuestions.length, 0, "nothing was written");
});

test("an unknown initiative on an item is refused by validation", { skip: SKIP }, async () => {
  const before = await getPlan();
  const rows = before.plan.sections.functional.map((i) => (i.id === "FR-2" ? { ...i, initiativeId: "I-9" } : i));
  const r = await putSection("functional", rows, before.version);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /FR-2: initiativeId "I-9" is not an initiative in this plan/);
});

test("a stale version is a 409 that hands back the current plan to reapply against", { skip: SKIP }, async () => {
  const before = await getPlan();
  const r = await putSection("nonFunctional", before.plan.sections.nonFunctional, "sha256:deadbeef");
  assert.equal(r.status, 409);
  assert.ok(r.body.current?.plan, "a conflict returns the latest so the tab can reload");
});

test("removing the LAST initiative is refused while an epic still references it", { skip: SKIP }, async () => {
  // The bypass this closes: deleting the final initiative turns initiative mode OFF, so a
  // mode-gated preflight would wave through every epic still pointing at it — the one removal
  // the CLI refuses outright would become the one the cockpit performs silently.
  const before = await getPlan();
  const onDisk = readFileSync(join(boardDir, "plan.json"), "utf8");
  const detached = (await putSection("functional", before.plan.sections.functional.map(({ initiativeId, ...rest }) => rest), before.version));
  assert.equal(detached.status, 200, JSON.stringify(detached.body));

  // e1 still says initiativeId: I-1. Emptying the array must not be allowed to strand it.
  const r = await putSection("initiatives", [], detached.body.version);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Epic e1 names initiative I-1, which the plan does not define/);
  assert.match(r.body.error, /maestro ticket edit-epic e1 --clear-initiative/);
  assert.deepEqual(JSON.parse(readFileSync(join(boardDir, "plan.json"), "utf8")).sections.initiatives.map((/** @type {any} */ i) => i.id), ["I-1", "I-2"],
    "both initiatives survive the refused write");

  // Restore ownership for the tests that follow.
  await putSection("functional", JSON.parse(onDisk).sections.functional, (await getPlan()).version);
});

test("removing every initiative succeeds once the board no longer references them", { skip: SKIP }, async () => {
  const before = await getPlan();
  const v1 = (await putSection("functional", before.plan.sections.functional.map(({ initiativeId, ...rest }) => rest), before.version)).body.version;
  writeFileSync(join(boardDir, "data.json"), JSON.stringify({ epics: [], tickets: [] }, null, 2));
  const r = await putSection("initiatives", [], v1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.initiatives, []);
  assert.deepEqual(r.body.plan.sections.initiatives, []);
  const p = await getPlan();
  assert.deepEqual(p.initiatives, [], "an empty array is what the Plan tab reads to hide the ownership pickers");
  // The section itself is still offered, so a project with none can create its first.
  assert.ok(p.sections.some((/** @type {any} */ s2) => s2.key === "initiatives"),
    "the Initiatives section stays in the registry — hiding it entirely would leave a fresh project no way in");
});
