/**
 * Integration tests for the board's creation ops: add, add-epic, import, next-id, retrace, drop.
 *
 * WHY THIS EXISTS: before these ops there was no supported way to CREATE a ticket, so the
 * planner reached for an editor — the exact read-modify-write that board-io.mjs exists to make
 * unrepresentable, and that already cost this repo a filed ticket. The guarantee these tests
 * pin is narrow and load-bearing: **creation never overwrites**. An import is add-only, an id
 * collision is a loud error, and the one removal it can do (`--replace-sample`) can only touch
 * items a starter explicitly marked as placeholder.
 *
 * They also pin the two traps that are silent when they regress:
 *   - dropping a ticket marks it a SATISFIED dependency, so it unblocks its dependents;
 *   - tracing a ticket at an `OUT-` id is a contradiction, not an override.
 *
 * Run: npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TICKET = join(KIT, "scripts", "board-write.mjs");
const PLAN = join(KIT, "scripts", "plan-write.mjs");
const STARTER = join(KIT, "starters", "orchestrated-project", "board", "data.json");

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function project({ starter = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "maestro-create-"));
  tmps.push(root);
  const boardDir = join(root, "board");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ project: { name: "demo" } }));
  writeFileSync(join(boardDir, "data.json"),
    starter ? readFileSync(STARTER, "utf8") : JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(boardDir, "archive.json"), JSON.stringify({ epics: [], tickets: [] }));

  const data = join(boardDir, "data.json");
  const run = (cli, args, opts = {}) =>
    execFileSync(process.execPath, [cli, ...args, "--board", data, "--agents", join(KIT, "agents")],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...opts });
  const ticket = (args, opts) => run(TICKET, args, opts);
  const ticketJson = (args) => JSON.parse(ticket([...args, "--json"]));
  const plan = (args) => execFileSync(process.execPath, [PLAN, ...args, "--board", data],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const board = () => JSON.parse(readFileSync(data, "utf8"));
  const archive = () => JSON.parse(readFileSync(join(boardDir, "archive.json"), "utf8"));

  /** @returns {{status:number, stderr:string}} */
  const fails = (args) => {
    try {
      ticket(args, { stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (e) {
      return { status: e.status, stderr: String(e.stderr) };
    }
  };

  return { root, boardDir, data, ticket, ticketJson, plan, board, archive, fails };
}

function seedGatingPlan(p) {
  p.plan(["set-goal", "--text", "Ship the thing."]);
  p.plan(["scope", "--in", "the app", "--out", "mobile apps"]);
  p.plan(["add", "functional", "--text", "Users can log in", "--verify", "npm test"]);
  p.plan(["add", "deliverables", "--text", "Web app"]);
}

// ── next-id ─────────────────────────────────────────────────────────────────────

test("next-id allocates a contiguous block, past live AND archived ids", () => {
  const p = project({ starter: false });
  writeFileSync(p.data, JSON.stringify({ epics: [], tickets: [{ id: "T-004", name: "x", status: "todo" }] }));
  writeFileSync(join(p.boardDir, "archive.json"),
    JSON.stringify({ epics: [], tickets: [{ id: "T-009", name: "y", status: "done" }] }));
  // Past the ARCHIVE too: an id reused from there collides with a landed ticket the validator
  // still tracks, and dependency resolution silently points at the wrong work.
  assert.deepEqual(p.ticketJson(["next-id", "--count", "3"]).ids, ["T-010", "T-011", "T-012"]);
  assert.deepEqual(p.ticketJson(["next-id", "--epics", "--count", "2"]).ids, ["e1", "e2"]);
});

// ── add / add-epic ──────────────────────────────────────────────────────────────

test("add files a ticket with an allocated id and sane defaults", () => {
  const p = project({ starter: false });
  const r = p.ticketJson(["add", "--name", "Health check", "--desc", "AC: 200 on /healthz."]);
  assert.equal(r.id, "T-001");
  const t = p.board().tickets.find((x) => x.id === "T-001");
  assert.equal(t.status, "todo");
  assert.equal(t.priority, "P2");
  assert.deepEqual(t.depends_on, []);
});

test("add refuses a ticket with no description", () => {
  // No description means no acceptance criteria, and the release gate treats that as an
  // automatic no-go — so the ticket could never land. Fail now, not three stages later.
  const p = project({ starter: false });
  const r = p.fails(["add", "--name", "Nameless work"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--desc/);
});

test("add validates enum flags by the flag the caller typed", () => {
  const p = project({ starter: false });
  const r = p.fails(["add", "--name", "x", "--desc", "y", "--priority", "P9"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--priority must be one of/);
});

test("add refuses an id already used, live or archived", () => {
  const p = project({ starter: true });
  const live = p.fails(["add", "--id", "T-001", "--name", "x", "--desc", "y"]);
  assert.equal(live.status, 1);
  assert.match(live.stderr, /already in use/);
});

test("add-epic allocates an epic id", () => {
  const p = project({ starter: true });
  assert.equal(p.ticketJson(["add-epic", "--name", "Second epic"]).id, "e2");
});

// ── import ──────────────────────────────────────────────────────────────────────

const DOC = {
  epics: [{ id: "e2", name: "Delivery", desc: "…", traces_to: ["D-1"] }],
  tickets: [
    { id: "T-002", epicId: "e2", name: "One", desc: "AC: …", area: "backend", status: "todo", depends_on: [], agent_plan: ["backend"], model: "sonnet", traces_to: ["FR-1"] },
    { id: "T-003", epicId: "e2", name: "Two", desc: "AC: …", area: "backend", status: "todo", depends_on: ["T-002"], agent_plan: ["backend"], model: "sonnet", traces_to: ["FR-1"] },
  ],
};

function writeDoc(p, doc = DOC) {
  const f = join(p.root, "import.json");
  writeFileSync(f, JSON.stringify(doc));
  return f;
}

test("import adds epics and tickets in one write", () => {
  const p = project({ starter: false });
  seedGatingPlan(p);
  const r = p.ticketJson(["import", writeDoc(p)]);
  assert.deepEqual(r.tickets, ["T-002", "T-003"]);
  assert.deepEqual(p.board().tickets.map((t) => t.id), ["T-002", "T-003"]);
});

test("import is ADD-ONLY — an existing id is an error, never an overwrite", () => {
  // This is the whole safety argument for letting one op take a whole document: it cannot
  // modify or delete existing work, so the read-modify-write damage stays unrepresentable.
  const p = project({ starter: false });
  seedGatingPlan(p);
  const doc = writeDoc(p);
  p.ticket(["import", doc]);
  const before = readFileSync(p.data, "utf8");

  const r = p.fails(["import", doc]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.equal(readFileSync(p.data, "utf8"), before, "a refused import must change nothing");
});

test("import refuses an id already in the archive", () => {
  const p = project({ starter: false });
  seedGatingPlan(p);
  writeFileSync(join(p.boardDir, "archive.json"),
    JSON.stringify({ epics: [], tickets: [{ id: "T-002", name: "landed", status: "done" }] }));
  const r = p.fails(["import", writeDoc(p)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /archive/);
});

test("--replace-sample removes starter placeholders and only those", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  // A real ticket alongside the sample: it must survive.
  p.ticket(["add", "--id", "T-050", "--name", "Real work", "--desc", "AC: …", "--traces-to", "FR-1"]);

  const r = p.ticketJson(["import", writeDoc(p), "--replace-sample"]);
  assert.deepEqual(r.dropped.sort(), ["T-001", "e1"]);
  const ids = p.board().tickets.map((t) => t.id);
  assert.ok(ids.includes("T-050"), "real work must never be dropped by --replace-sample");
  assert.ok(!ids.includes("T-001"));
  assert.deepEqual(p.board().epics.map((e) => e.id), ["e2"]);
});

test("import is all-or-nothing when the result would be invalid", () => {
  const p = project({ starter: false });
  const before = readFileSync(p.data, "utf8");
  const r = p.fails(["import", writeDoc(p, {
    epics: [],
    tickets: [{ id: "T-002", name: "dangling", desc: "x", status: "todo", depends_on: ["T-999"] }],
  })]);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(p.data, "utf8"), before, "a board that would be invalid must not be partially written");
});

test("import --dry-run previews without writing", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  const before = readFileSync(p.data, "utf8");
  const r = p.ticketJson(["import", writeDoc(p), "--replace-sample", "--dry-run"]);
  assert.equal(r.dryRun, true);
  assert.equal(readFileSync(p.data, "utf8"), before);
});

// ── retrace ─────────────────────────────────────────────────────────────────────

test("retrace records a trace and reports whether the ticket will now run", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  const r = p.ticketJson(["retrace", "T-001", "--traces-to", "FR-1"]);
  assert.equal(r.blocked, false);
  assert.equal(r.scope, "in-scope");
  assert.deepEqual(p.board().tickets[0].traces_to, ["FR-1"]);
});

test("retrace refuses an OUT- id outright — that is a contradiction, not an override", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  const r = p.fails(["retrace", "T-001", "--traces-to", "OUT-1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /out of scope/i);
  // Not forceable either — --scope-exception is the honest way to say "a human wants this".
  assert.equal(p.fails(["retrace", "T-001", "--traces-to", "OUT-1", "--force"]).status, 1);
});

test("retrace refuses an unknown plan id, but --force records it", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  assert.equal(p.fails(["retrace", "T-001", "--traces-to", "FR-99"]).status, 1);
  const forced = p.ticketJson(["retrace", "T-001", "--traces-to", "FR-99", "--force"]);
  assert.equal(forced.blocked, true, "forcing records the trace but must not clear the gate");
});

test("a scope exception clears the gate; an empty one is refused", () => {
  const p = project({ starter: true });
  seedGatingPlan(p);
  const r = p.ticketJson(["retrace", "T-001", "--scope-exception", "owner approved a spike"]);
  assert.equal(r.blocked, false);
  assert.equal(r.scope, "exception");
  // An empty reason would switch the gate off with nothing on record about why.
  assert.equal(p.fails(["retrace", "T-001", "--scope-exception", ""]).status, 1);
});

test("retrace works on a board with no plan at all", () => {
  const p = project({ starter: true });
  const r = p.ticketJson(["retrace", "T-001", "--traces-to", "FR-1"]);
  assert.equal(r.scope, "no-plan");
  assert.equal(r.blocked, false);
});

// ── drop ────────────────────────────────────────────────────────────────────────

test("drop archives a ticket with its reason, under an archive-only status", () => {
  const p = project({ starter: true });
  const r = p.ticketJson(["drop", "T-001", "--reason", "superseded by the new plan"]);
  assert.equal(r.status, "wont-do");
  assert.equal(p.board().tickets.length, 0);
  const landed = p.archive().tickets[0];
  assert.equal(landed.status, "wont-do");
  assert.equal(landed.evidence, "superseded by the new plan");
});

test("drop refuses `done` — abandoned work is never recorded as finished", () => {
  const p = project({ starter: true });
  const r = p.fails(["drop", "T-001", "--reason", "x", "--status", "done"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /archive/);
});

test("drop refuses a ticket others depend on, because archiving marks it satisfied", () => {
  // The trap: eligibility treats EVERY archived id as a satisfied dependency, whatever status
  // it carries. Dropping T-001 as wont-do would make T-002 eligible even though its
  // prerequisite was explicitly declined.
  const p = project({ starter: false });
  writeFileSync(p.data, JSON.stringify({
    epics: [],
    tickets: [
      { id: "T-001", name: "a", desc: "x", status: "todo", depends_on: [] },
      { id: "T-002", name: "b", desc: "x", status: "todo", depends_on: ["T-001"] },
    ],
  }));
  const r = p.fails(["drop", "T-001", "--reason", "declined"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T-002/);
  assert.equal(p.board().tickets.length, 2);

  const forced = p.ticketJson(["drop", "T-001", "--reason", "declined", "--force"]);
  assert.deepEqual(forced.dependents, ["T-002"]);
});

test("drop requires a reason", () => {
  const p = project({ starter: true });
  assert.equal(p.fails(["drop", "T-001"]).status, 1);
});

// ── Concurrency contract, shared with the rest of the module ────────────────────

test("a stale --expect-version on a creating op is a retryable exit 2", () => {
  const p = project({ starter: false });
  const stale = p.ticketJson(["version"]).version;
  p.ticket(["add", "--name", "first", "--desc", "AC: …"]);
  const r = p.fails(["add", "--name", "second", "--desc", "AC: …", "--expect-version", stale]);
  assert.equal(r.status, 2, "a moved board must be exit 2 (retryable), never a lost update");
  assert.equal(p.board().tickets.length, 1);
});
