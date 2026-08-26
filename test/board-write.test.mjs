/**
 * Tests for scripts/board-io.mjs + scripts/board-write.mjs — the guarded board writer (T-010).
 *
 * The first test here is the important one. It reproduces the ORIGINAL failure with the
 * read-modify-write pattern the orchestrator used to prompt agents into, and asserts that
 * it loses a ticket. If that test ever stops failing-by-design, the rest of this file is
 * measuring nothing: a concurrency test that passes against the broken implementation is
 * not evidence that the fix works.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boardVersion, mutateBoard, BoardConflictError, withBoardLock } from "../scripts/board-io.mjs";

const execFileP = promisify(execFile);
const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER = join(KIT, "scripts", "board-write.mjs");

/** A minimal valid board: one epic, N tickets. */
function seedBoard(n = 1) {
  const dir = mkdtempSync(join(tmpdir(), "board-write-"));
  const boardDir = join(dir, "board");
  mkdirSync(boardDir, { recursive: true });
  const data = {
    epics: [{ id: "e1", name: "Test epic" }],
    tickets: Array.from({ length: n }, (_, i) => ({
      id: `T-${String(i + 1).padStart(3, "0")}`,
      epicId: "e1",
      name: `Ticket ${i + 1}`,
      area: "infra",
      priority: "P2",
      swag: "S",
      status: "todo",
      depends_on: [],
    })),
  };
  const dataPath = join(boardDir, "data.json");
  const archivePath = join(boardDir, "archive.json");
  writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n");
  writeFileSync(archivePath, JSON.stringify({ epics: [], tickets: [] }, null, 2) + "\n");
  return { dir, boardDir, dataPath, archivePath };
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Run the writer CLI. Never throws on a non-zero exit — the exit code is the assertion. */
async function ticket(args, dataPath) {
  try {
    const { stdout } = await execFileP(process.execPath, [WRITER, ...args, "--board", dataPath, "--json"]);
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    let out = null;
    try { out = JSON.parse(e.stdout); } catch { /* non-JSON failure */ }
    return { code: e.code ?? 1, out, stderr: String(e.stderr ?? "") };
  }
}

// ── The failure this ticket exists to prevent ─────────────────────────────────

test("BASELINE: naive read-modify-write silently loses a concurrent write", () => {
  const { dataPath } = seedBoard(1);

  // Exactly what the orchestrator used to instruct an agent to do, twice, interleaved:
  // read the whole file, change one thing in memory, write the whole file back.
  const writerA = read(dataPath);          // A reads
  const writerB = read(dataPath);          // B reads the SAME state

  writerA.tickets.push({ id: "T-A", epicId: "e1", name: "A", area: "infra", priority: "P2", swag: "S", status: "todo", depends_on: [] });
  writeFileSync(dataPath, JSON.stringify(writerA, null, 2) + "\n");   // A writes

  writerB.tickets.push({ id: "T-B", epicId: "e1", name: "B", area: "infra", priority: "P2", swag: "S", status: "todo", depends_on: [] });
  writeFileSync(dataPath, JSON.stringify(writerB, null, 2) + "\n");   // B writes from its stale copy

  const final = read(dataPath);
  const ids = final.tickets.map((t) => t.id);
  assert.ok(ids.includes("T-B"), "B's write survived");
  assert.equal(ids.includes("T-A"), false,
    "THE BUG: A's ticket is gone, no error was raised, and the file is valid JSON. " +
    "If this assertion ever fails, the baseline no longer reproduces the race and the " +
    "guarded-path tests below prove nothing.");
});

test("guarded path: the same interleaving keeps both writes", () => {
  const { dataPath, archivePath } = seedBoard(1);
  const mkTicket = (id) => ({ id, epicId: "e1", name: id, area: "infra", priority: "P2", swag: "S", status: "todo", depends_on: [] });

  // Both writers express the change DECLARATIVELY and are applied to disk state, not to a
  // board either of them read earlier — so there is no stale copy to overwrite from.
  for (const id of ["T-A", "T-B"]) {
    mutateBoard({
      dataPath, archivePath,
      mutate: ({ data }) => { data.tickets.push(mkTicket(id)); return { data }; },
    });
  }

  const ids = read(dataPath).tickets.map((t) => t.id);
  assert.ok(ids.includes("T-A") && ids.includes("T-B"), `both survived, got ${ids.join(",")}`);
});

test("concurrent processes each filing a blocker: every one survives", async () => {
  const { dataPath } = seedBoard(1);
  const N = 8;

  // Real OS processes, started together — the interleaving is genuine, not simulated.
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      ticket(["block", "T-001",
        "--blocker-id", `B-${i}`,
        "--name", `blocker ${i}`,
        "--desc", `filed by writer ${i}`], dataPath)),
  );

  for (const [i, r] of runs.entries()) {
    assert.equal(r.code, 0, `writer ${i} failed: ${r.stderr ?? JSON.stringify(r.out)}`);
  }

  const ids = read(dataPath).tickets.map((t) => t.id);
  for (let i = 0; i < N; i++) {
    assert.ok(ids.includes(`B-${i}`), `B-${i} was lost — ${ids.length} tickets on the board: ${ids.join(",")}`);
  }
  assert.equal(ids.length, N + 1, "one seed ticket plus one blocker per writer, nothing dropped or duplicated");
});

// ── Compare-and-swap, for writers that never took the lock ────────────────────

test("a stale --expect-version is refused with exit 2 and the board is untouched", async () => {
  const { dataPath } = seedBoard(1);
  const stale = boardVersion(dataPath);

  const first = await ticket(["set-status", "T-001", "in-progress"], dataPath);
  assert.equal(first.code, 0);

  const before = readFileSync(dataPath, "utf8");
  const conflict = await ticket(["set-status", "T-001", "review", "--expect-version", stale], dataPath);

  assert.equal(conflict.code, 2, "conflict must be exit 2 — retryable, distinct from a usage error");
  assert.match(conflict.out.error, /changed on disk/i);
  assert.equal(readFileSync(dataPath, "utf8"), before, "a refused write must not modify the file");
});

test("a current --expect-version is accepted", async () => {
  const { dataPath } = seedBoard(1);
  const v = boardVersion(dataPath);
  const r = await ticket(["set-status", "T-001", "review", "--expect-version", v], dataPath);
  assert.equal(r.code, 0);
  assert.equal(read(dataPath).tickets[0].status, "review");
});

test("set-routing updates and clears ticket role overrides atomically", async () => {
  const { dataPath } = seedBoard(1);
  const set = await ticket(["set-routing", "T-001",
    "--dev-runtime", "claude", "--dev-model", "claude-sonnet-4-5",
    "--reviewer-runtime", "codex", "--reviewer-model", "gpt-5.4"], dataPath);
  assert.equal(set.code, 0);
  const routed = read(dataPath).tickets[0];
  assert.equal(routed.dev_runtime, "claude");
  assert.equal(routed.dev_model, "claude-sonnet-4-5");
  assert.equal(routed.reviewer_runtime, "codex");
  assert.equal(routed.reviewer_model, "gpt-5.4");

  const clear = await ticket(["set-routing", "T-001", "--clear"], dataPath);
  assert.equal(clear.code, 0);
  const updated = read(dataPath).tickets[0];
  for (const field of ["dev_runtime", "dev_model", "reviewer_runtime", "reviewer_model"]) {
    assert.equal(Object.hasOwn(updated, field), false);
  }
});

test("set-testcmd sets and clears a ticket's test command", async () => {
  const { dataPath } = seedBoard(1);
  const set = await ticket(["set-testcmd", "T-001", "--cmd", "npm test"], dataPath);
  assert.equal(set.code, 0);
  assert.equal(read(dataPath).tickets[0].testCmd, "npm test");

  const clear = await ticket(["set-testcmd", "T-001", "--clear"], dataPath);
  assert.equal(clear.code, 0);
  assert.equal(Object.hasOwn(read(dataPath).tickets[0], "testCmd"), false);
});

test("set-testcmd without --cmd or --clear is a usage error", async () => {
  const { dataPath } = seedBoard(1);
  const r = await ticket(["set-testcmd", "T-001"], dataPath);
  assert.equal(r.code, 1);
  assert.match(r.out?.error ?? r.stderr ?? "", /needs --cmd|--clear/);
});

test("mutateBoard throws BoardConflictError, not a generic Error", () => {
  const { dataPath, archivePath } = seedBoard(1);
  assert.throws(
    () => mutateBoard({
      dataPath, archivePath, expectVersion: "sha256:definitely-not-current",
      mutate: ({ data }) => ({ data }),
    }),
    (e) => e instanceof BoardConflictError && e.code === "EBOARDCONFLICT",
  );
});

// ── Integrity: an invalid result is never written ─────────────────────────────

test("a mutation that would invalidate the board is refused, and nothing is written", async () => {
  const { dataPath } = seedBoard(1);
  const before = readFileSync(dataPath, "utf8");

  // Duplicate id — a hard validator error.
  const r = await ticket(["block", "T-001", "--blocker-id", "T-001", "--name", "dup", "--desc", "dup"], dataPath);

  assert.equal(r.code, 1, "an invalid request is exit 1 — retrying will not help");
  assert.equal(readFileSync(dataPath, "utf8"), before);
});

test("an unknown status is rejected before the board is opened for writing", async () => {
  const { dataPath } = seedBoard(1);
  const before = readFileSync(dataPath, "utf8");
  const r = await ticket(["set-status", "T-001", "done-ish"], dataPath);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /not a live status/);
  assert.equal(readFileSync(dataPath, "utf8"), before);
});

test("archive-only statuses cannot be set on a live ticket via set-status", async () => {
  const { dataPath } = seedBoard(1);
  const r = await ticket(["set-status", "T-001", "wont-do"], dataPath);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /archive/i, "the error should point at the archive op");
});

test("corrupt JSON is reported, never silently replaced with an empty board", () => {
  const { dataPath, archivePath } = seedBoard(3);
  writeFileSync(dataPath, "{ this is not json");
  assert.throws(
    () => mutateBoard({ dataPath, archivePath, mutate: ({ data }) => ({ data }) }),
    /Invalid JSON/,
  );
  assert.equal(readFileSync(dataPath, "utf8"), "{ this is not json", "the damaged file is left for a human");
});

// ── Atomicity ─────────────────────────────────────────────────────────────────

test("writes leave no temp files behind, and the lock is always released", async () => {
  const { boardDir, dataPath } = seedBoard(1);
  await ticket(["set-status", "T-001", "review"], dataPath);
  const leftovers = readdirSync(boardDir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(",")}`);
  assert.equal(existsSync(join(boardDir, ".board.lock")), false, "lock file must not survive the write");
});

test("the lock is released even when the mutation throws", () => {
  const { boardDir, dataPath, archivePath } = seedBoard(1);
  assert.throws(() => mutateBoard({
    dataPath, archivePath,
    mutate: () => { throw new Error("boom"); },
  }), /boom/);
  assert.equal(existsSync(join(boardDir, ".board.lock")), false,
    "a thrown mutation must not wedge the board behind a stuck lock");
});

test("a stale lock is stolen rather than blocking the board forever", () => {
  const { boardDir, dataPath, archivePath } = seedBoard(1);
  const lockPath = join(boardDir, ".board.lock");
  writeFileSync(lockPath,
    JSON.stringify({ pid: 999999, at: new Date(Date.now() - 120_000).toISOString(), op: "crashed" }));
  // Staleness is judged by the file's mtime, not the timestamp recorded inside it — a
  // holder that lies (or never got as far as writing one) must not extend its own lease.
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);

  let stolen = null;
  withBoardLock(boardDir, () => {}, { staleMs: 30_000, onStaleSteal: (h) => { stolen = h; } });
  assert.equal(stolen?.op, "crashed", "the stale holder should be reported, not silently discarded");

  const r = mutateBoard({ dataPath, archivePath, mutate: ({ data }) => { data.tickets[0].status = "review"; return { data }; } });
  assert.ok(r.changed);
});

test("an unparseable lock file is honoured while fresh, then stolen once stale", () => {
  const { boardDir } = seedBoard(1);
  const lockPath = join(boardDir, ".board.lock");

  // A lock whose contents we cannot read is still a lock. Treating "unparseable" as
  // "abandoned" is what let two writers into the critical section: `wx` creates the file
  // empty, so a live lock is briefly unreadable by definition.
  writeFileSync(lockPath, "not json at all");
  assert.throws(
    () => withBoardLock(boardDir, () => {}, { timeoutMs: 300 }),
    (e) => e.code === "EBOARDLOCK",
    "a fresh lock must be waited on, whatever is inside it",
  );

  // Backdate it past the stale window — now it is abandoned and may be taken.
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);
  withBoardLock(boardDir, () => {}, { timeoutMs: 300 });
  assert.equal(existsSync(lockPath), false);
});

// ── Version token ─────────────────────────────────────────────────────────────

test("the version changes on write and is stable when the content is", async () => {
  const { dataPath } = seedBoard(2);
  const v1 = boardVersion(dataPath);
  assert.equal(boardVersion(dataPath), v1, "same bytes, same version");

  await ticket(["set-status", "T-001", "review"], dataPath);
  assert.notEqual(boardVersion(dataPath), v1, "a write must move the version");
});

test("the version distinguishes same-size boards — a swapped ticket is not invisible", () => {
  const { dataPath } = seedBoard(1);
  const a = read(dataPath);
  a.tickets[0].id = "T-AAA";
  writeFileSync(dataPath, JSON.stringify(a, null, 2) + "\n");
  const vA = boardVersion(dataPath);

  a.tickets[0].id = "T-BBB";                       // same byte length, different content
  writeFileSync(dataPath, JSON.stringify(a, null, 2) + "\n");
  assert.notEqual(boardVersion(dataPath), vA,
    "mtime+size would call these identical; a lost update looks exactly like this");
});

// ── Ops ───────────────────────────────────────────────────────────────────────

test("archive moves the ticket to archive.json with evidence, and carries its epic", async () => {
  const { dataPath, archivePath } = seedBoard(2);
  const r = await ticket(["archive", "T-001", "--evidence", "merged abc123", "--done-at", "2026-08-09"], dataPath);
  assert.equal(r.code, 0, r.stderr);

  const data = read(dataPath);
  const arch = read(archivePath);
  assert.equal(data.tickets.find((t) => t.id === "T-001"), undefined, "left the active board");

  const landed = arch.tickets.find((t) => t.id === "T-001");
  assert.equal(landed.status, "done");
  assert.equal(landed.evidence, "merged abc123");
  assert.equal(landed.done_at, "2026-08-09");
  assert.ok(arch.epics.some((e) => e.id === "e1"), "the archived ticket's epic must still resolve");
});

test("archive refuses --evidence-less landings and double-archiving", async () => {
  const { dataPath } = seedBoard(1);
  const noEvidence = await ticket(["archive", "T-001"], dataPath);
  assert.equal(noEvidence.code, 1);
  assert.match(noEvidence.out.error, /evidence/i);

  assert.equal((await ticket(["archive", "T-001", "--evidence", "x"], dataPath)).code, 0);
  const twice = await ticket(["archive", "T-001", "--evidence", "x"], dataPath);
  assert.equal(twice.code, 1, "the ticket is no longer on the active board");
});

test("block sets the ticket blocked and files the blocker in one write", async () => {
  const { dataPath } = seedBoard(1);
  const r = await ticket(["block", "T-001", "--blocker-id", "B-1", "--name", "BLOCKER: x", "--desc", "why"], dataPath);
  assert.equal(r.code, 0, r.stderr);

  const data = read(dataPath);
  assert.equal(data.tickets.find((t) => t.id === "T-001").status, "blocked");
  const b = data.tickets.find((t) => t.id === "B-1");
  assert.equal(b.status, "blocked");
  assert.equal(b.priority, "P0");
  assert.equal(b.epicId, "e1", "inherits the blocked ticket's epic when not given one");
});

test("set-status writes coordination fields in the same atomic write as the status", async () => {
  const { dataPath } = seedBoard(1);
  const r = await ticket(["set-status", "T-001", "in-progress",
    "--execution-mode", "multi-agent", "--agent-plan", "pe,qa,merge",
    "--current-agent", "pe", "--next-agent", "qa"], dataPath);
  assert.equal(r.code, 0, r.stderr);

  const t = read(dataPath).tickets[0];
  assert.equal(t.status, "in-progress");
  assert.equal(t.execution_mode, "multi-agent");
  assert.deepEqual(t.agent_plan, ["pe", "qa", "merge"]);
  assert.equal(t.currentAgent, "pe");
  assert.equal(t.nextAgent, "qa");
});

test("--dry-run reports the change and writes nothing", async () => {
  const { dataPath } = seedBoard(1);
  const before = readFileSync(dataPath, "utf8");
  const r = await ticket(["set-status", "T-001", "review", "--dry-run"], dataPath);
  assert.equal(r.code, 0);
  assert.equal(r.out.dryRun, true);
  assert.equal(readFileSync(dataPath, "utf8"), before);
});

test("an unknown ticket id is a usage error naming the board", async () => {
  const { dataPath } = seedBoard(1);
  const r = await ticket(["set-status", "T-999", "review"], dataPath);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /T-999/);
});
