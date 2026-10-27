/**
 * Board writes: `--touches` parsing, opt-in ticket readiness (gates + inputs, creation
 * checklist) and `edit-many`. Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTicket, editTicket, editTickets, readBoard, setTicketStatus } from "../scripts/board-api.mjs";
import { gatesAndInputsIssues, ticketCreationIssues, touchesIssues, ticketReadinessSettings, validateBoard } from "../scripts/board-core.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = join(KIT, "scripts", "board-write.mjs");

const GATES = { merge: true, "dev-deploy": false, "paid-run": false, "needs-owner-input": false };
const AC = [{ id: "AC-1", text: "It works.", phase: "pre-merge" }];

function ticket(id, extra = {}) {
  return { id, epicId: "e1", name: `Ticket ${id}`, desc: "Do it.", area: "backend", priority: "P2", swag: "S", status: "todo", depends_on: [], agent_plan: ["backend", "qa"], ...extra };
}

/** A board under <root>/maestro/board with an optional config. */
function board({ readiness = false, tickets = [ticket("T-001")] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-readiness-")));
  const dir = join(root, "maestro", "board");
  mkdirSync(dir, { recursive: true });
  const config = { project: { name: "t", areas: ["backend"] }, ...(readiness ? { ticketReadiness: { enabled: true } } : {}) };
  writeFileSync(join(root, "maestro", "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, "data.json"), JSON.stringify({ epics: [{ id: "e1", name: "E" }], tickets }, null, 2));
  writeFileSync(join(dir, "archive.json"), JSON.stringify({ epics: [], tickets: [] }, null, 2));
  return { root, dataPath: join(dir, "data.json"), boardPath: join(dir, "data.json") };
}
const cli = (b, ...args) => spawnSync(process.execPath, [WRITE, ...args, "--board", b.dataPath, "--json"], { cwd: b.root, encoding: "utf8" });
const live = (b, id) => JSON.parse(readFileSync(b.dataPath, "utf8")).tickets.find((t) => t.id === id);

// ── --touches ───────────────────────────────────────────────────────────────

test("touches: add accepts a JSON array and a comma list", () => {
  const b = board();
  let r = cli(b, "add", "--id", "T-010", "--name", "A", "--desc", "d", "--touches", '["src/a/**","src/b.mjs"]');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(live(b, "T-010").touches, ["src/a/**", "src/b.mjs"]);
  r = cli(b, "add", "--id", "T-011", "--name", "B", "--desc", "d", "--touches", "src/c/**, src/d.mjs");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(live(b, "T-011").touches, ["src/c/**", "src/d.mjs"]);
});

test("touches: edit takes --touches in either form; malformed values are refused clearly", () => {
  const b = board();
  let r = cli(b, "edit", "T-001", "--touches", '["src/x/**"]');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(live(b, "T-001").touches, ["src/x/**"]);
  r = cli(b, "edit", "T-001", "--touches", "a/**,b/**");
  assert.deepEqual(live(b, "T-001").touches, ["a/**", "b/**"]);

  for (const bad of ['["a","b"', '["a", 3]', "[]", '"a"']) {
    r = cli(b, "add", "--id", "T-020", "--name", "X", "--desc", "d", "--touches", bad);
    assert.notEqual(r.status, 0, `accepted ${bad}`);
    assert.match(r.stdout + r.stderr, /--touches/);
  }
  assert.equal(live(b, "T-020"), undefined);
});

test("touches: the API refuses a string or quoted fragments", () => {
  const b = board();
  assert.throws(() => createTicket({ boardPath: b.boardPath, id: "T-030", name: "X", desc: "d", touches: '["a","b"]' }), /touches must be a list/);
  assert.throws(() => editTicket({ boardPath: b.boardPath, id: "T-001", changes: { touches: ['["a"', '"b"]'] } }), /malformed entries/);
  assert.deepEqual(touchesIssues(["src/[ab]/**"]), [], "a bracket glob is fine");
  // The validator only warns, so boards written before this check still load.
  const v = validateBoard({ epics: [{ id: "e1", name: "E" }], tickets: [ticket("T-1", { touches: "a,b" })] });
  assert.equal(v.errors.length, 0);
  assert.ok(v.warnings.some((w) => /touches must be a list/.test(w)));
});

// ── ticket readiness (opt-in) ───────────────────────────────────────────────

test("readiness: off by default — tickets without gates/inputs validate and save as before", () => {
  const b = board();
  assert.equal(ticketReadinessSettings({}), null);
  const r = readBoard({ boardPath: b.boardPath });
  assert.deepEqual(r.errors, []);
  createTicket({ boardPath: b.boardPath, id: "T-002", name: "No gates", desc: "d" });
  assert.ok(live(b, "T-002"));
});

test("readiness: gatesAndInputsIssues and ticketCreationIssues report every gap", () => {
  assert.ok(gatesAndInputsIssues({}).length >= 2);
  assert.deepEqual(gatesAndInputsIssues({ gates: GATES, inputs: [] }), []);
  const ownerMissing = { gates: GATES, inputs: [{ id: "key", name: "API key", from: "owner", location: "vault", status: "missing" }] };
  assert.match(gatesAndInputsIssues(ownerMissing).join(), /needs-owner-input must be true/);
  assert.match(gatesAndInputsIssues({ gates: { ...GATES, bogus: true }, inputs: [] }).join(), /not a known gate/);
  const full = ticketCreationIssues({ gates: GATES, inputs: [] });
  assert.equal(full.length, 3, full.join("\n")); // touches, acceptanceCriteria, testCmd
  assert.deepEqual(ticketCreationIssues({ gates: GATES, inputs: [] }, { creationChecklist: false }), []);
});

test("readiness: validator requires gates/inputs and refuses todo while owner input is missing", () => {
  const config = { ticketReadiness: { enabled: true } };
  const data = { epics: [{ id: "e1", name: "E" }], tickets: [ticket("T-1")] };
  assert.ok(validateBoard(data, { config }).errors.some((e) => /T-1: gates is required/.test(e)));
  const waiting = ticket("T-2", { gates: { ...GATES, "needs-owner-input": true }, inputs: [{ id: "decision", name: "Pick a vendor", from: "owner", location: "T-2 desc", status: "missing" }] });
  const v = validateBoard({ ...data, tickets: [waiting] }, { config });
  assert.ok(v.errors.some((e) => /not startable — owner input missing \(decision\)/.test(e)), v.errors.join("\n"));
  assert.deepEqual(validateBoard({ ...data, tickets: [{ ...waiting, status: "backlog" }] }, { config }).errors, []);
  assert.ok(validateBoard(data, { config: { ticketReadiness: { enabled: true, colour: 1 } } }).errors.some((e) => /ticketReadiness.colour/.test(e)));
});

test("readiness: add refuses an incomplete ticket with the whole checklist, accepts a complete one", () => {
  const b = board({ readiness: true, tickets: [ticket("T-001", { gates: GATES, inputs: [] })] });
  let r = cli(b, "add", "--id", "T-002", "--name", "A", "--desc", "d");
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  for (const field of ["gates", "inputs", "touches", "acceptanceCriteria", "testCmd"]) assert.match(out, new RegExp(field));
  r = cli(b, "add", "--id", "T-002", "--name", "A", "--desc", "d", "--gates", JSON.stringify(GATES), "--inputs", "[]",
    "--touches", "src/a/**", "--acceptance-criteria", JSON.stringify(AC), "--test-cmd", "npm test");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(live(b, "T-002").gates, GATES);
});

test("readiness: moving a ticket waiting on the owner to in-progress is refused", () => {
  const waiting = ticket("T-001", { status: "backlog", gates: { ...GATES, "needs-owner-input": true }, inputs: [{ id: "d", name: "Decision", from: "owner", location: "desc", status: "missing" }] });
  const b = board({ readiness: true, tickets: [waiting] });
  assert.throws(() => setTicketStatus({ boardPath: b.boardPath, id: "T-001", status: "in-progress" }), /not startable/);
});

test("readiness: block files a blocker that waits on an owner decision; import applies the checklist", () => {
  const b = board({ readiness: true, tickets: [ticket("T-001", { gates: GATES, inputs: [] })] });
  let r = cli(b, "block", "T-001", "--name", "Need a decision", "--desc", "Which vendor?");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const blocker = JSON.parse(readFileSync(b.dataPath, "utf8")).tickets.find((t) => t.id !== "T-001");
  assert.equal(blocker.gates["needs-owner-input"], true);
  assert.equal(blocker.inputs[0].from, "owner");

  const file = join(b.root, "import.json");
  writeFileSync(file, JSON.stringify({ tickets: [ticket("T-050")] }));
  r = cli(b, "import", file);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /creation checklist/);
});

// ── edit-many ───────────────────────────────────────────────────────────────

test("edit-many: a board-wide new rule is applied in one validated write", () => {
  // Readiness switched on for a board whose tickets predate it: single edits cannot help,
  // because the board stays invalid until every ticket has gates and inputs.
  const b = board({ readiness: true, tickets: [ticket("T-001"), ticket("T-002")] });
  assert.throws(() => editTicket({ boardPath: b.boardPath, id: "T-001", changes: { gates: GATES, inputs: [] } }), /T-002: gates is required/);
  const file = join(b.root, "edits.json");
  writeFileSync(file, JSON.stringify({ "T-001": { gates: GATES, inputs: [] }, "T-002": { gates: GATES, inputs: [], touches: ["src/**"] } }));
  const r = cli(b, "edit-many", "--changes-file", file);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).ids, ["T-001", "T-002"]);
  assert.deepEqual(live(b, "T-002").touches, ["src/**"]);
});

test("edit-many: all or nothing — one bad edit writes nothing", () => {
  const b = board();
  const before = readFileSync(b.dataPath, "utf8");
  assert.throws(() => editTickets({ boardPath: b.boardPath, edits: { "T-001": { name: "Renamed" }, "T-404": { name: "x" } } }), /T-404/);
  assert.equal(readFileSync(b.dataPath, "utf8"), before);
  assert.throws(() => editTickets({ boardPath: b.boardPath, edits: {} }), /non-empty/);
});

test("validate: with no path, finds maestro/board/data.json from the repo root", () => {
  const b = board();
  const cli = join(KIT, "bin", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "validate", "--config", join(b.root, "maestro", "config.json")], { cwd: b.root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "maestro-noboard-")));
  const none = spawnSync(process.execPath, [cli, "validate"], { cwd: empty, encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No board found/);
});
