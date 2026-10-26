/**
 * Machine-local shared ticket status (config.localStatus). Run: node --test test/
 *
 * Each test builds a throwaway git repository with a board under maestro/ and two linked
 * worktrees, the way a delivery machine runs lanes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readBoard, setTicketStatus, editTicket, archiveTicket, unarchiveTicket, claimTicket, createTicket,
  readTicket, overlayLocalStatus, readLocalStatus, localStatusLog, syncLocalStatus,
  exportLocalStatus, importLocalStatus, getBoardVersion, listTicketEligibility, BoardConflictError,
} from "../scripts/board-api.mjs";
import { boardVersion } from "../scripts/board-io.mjs";
import {
  overlayBoard, splitBoard, localStatusSettings, readStore, commitStore, DEFAULT_STATUS_FIELDS,
} from "../scripts/local-status.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(KIT, "bin", "cli.mjs");
const BOARD_API = join(KIT, "scripts", "board-api.mjs");

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const maestro = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

function ticket(id, extra = {}) {
  return {
    id, epicId: "e1", name: `Ticket ${id}`, desc: `Acceptance for ${id}.`, area: "backend",
    priority: "P2", swag: "S", status: "todo", depends_on: [], agent_plan: ["pe", "backend", "qa"],
    touches: [`src/${id}.mjs`], gates: { merge: false, "needs-owner-input": false }, ...extra,
  };
}

/** A repo with maestro/board, committed, plus worktrees wt1 and wt2 on their own branches. */
function fixture({ localStatus = true, tickets } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-local-status-")));
  const main = join(root, "main");
  mkdirSync(join(main, "maestro", "board"), { recursive: true });
  const config = JSON.parse(readFileSync(join(KIT, "starters", "orchestrated-project", "config.json"), "utf8"));
  if (localStatus) config.localStatus = { enabled: true };
  writeFileSync(join(main, "maestro", "config.json"), JSON.stringify(config, null, 2) + "\n");
  const data = {
    epics: [{ id: "e1", name: "Foundation" }],
    tickets: tickets ?? [ticket("T-001"), ticket("T-002"), ticket("T-003"), ticket("T-004", { depends_on: ["T-001"] })],
  };
  writeFileSync(join(main, "maestro", "board", "data.json"), JSON.stringify(data, null, 2) + "\n");
  writeFileSync(join(main, "maestro", "board", "archive.json"), JSON.stringify({ epics: [], tickets: [] }, null, 2) + "\n");
  git(root, "init", "-q", "-b", "main", main);
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "board");
  const wt1 = join(root, "wt1"), wt2 = join(root, "wt2");
  git(main, "worktree", "add", "-q", "-b", "lane-1", wt1);
  git(main, "worktree", "add", "-q", "-b", "lane-2", wt2);
  const board = (dir) => join(dir, "maestro", "board", "data.json");
  return { root, main, wt1, wt2, board };
}

const fileText = (path) => readFileSync(path, "utf8");
const findTicket = (snapshot, id) => snapshot.data.tickets.find((t) => t.id === id);

test("default off: status is written to data.json exactly as before, no store is created", () => {
  const fx = fixture({ localStatus: false });
  const boardPath = fx.board(fx.wt1);
  assert.equal(localStatusSettings({ dataPath: boardPath }), null);
  const before = readBoard({ boardPath });
  assert.equal(before.version, boardVersion(boardPath), "version stays the plain file hash");
  assert.equal(before.localStatus, undefined);
  const out = setTicketStatus({ boardPath, id: "T-001", status: "in-progress", expectVersion: before.version });
  assert.equal(out.changed, true);
  assert.equal(out.localStatus, undefined);
  assert.equal(JSON.parse(fileText(boardPath)).tickets[0].status, "in-progress", "file carries the status");
  assert.equal(out.version, boardVersion(boardPath));
  assert.equal(git(fx.main, "for-each-ref", "refs/maestro/"), "", "no shared store ref");
  assert.match(git(fx.wt1, "status", "--porcelain"), /data\.json/, "the change is a git change, as before");
  // The other worktree has its own committed copy and does not see it.
  assert.equal(findTicket(readBoard({ boardPath: fx.board(fx.wt2) }), "T-001").status, "todo");
  archiveTicket({ boardPath, id: "T-002", evidence: "abc123" });
  assert.equal(JSON.parse(fileText(join(fx.wt1, "maestro", "board", "archive.json"))).tickets[0].id, "T-002");
  const sync = maestro(fx.wt1, "status", "sync", "--board", boardPath, "--json");
  assert.equal(sync.status, 1);
  assert.match(JSON.parse(sync.stdout).error, /not enabled/);
});

test("overlay: a status write leaves data.json byte-identical and every reader sees it", () => {
  const fx = fixture();
  const boardPath = fx.board(fx.wt1);
  const original = fileText(boardPath);
  const out = setTicketStatus({ boardPath, id: "T-001", status: "in-progress", coordination: { currentAgent: "backend" } });
  assert.equal(out.changed, true);
  assert.equal(out.localStatus.changes[0].id, "T-001");
  assert.equal(fileText(boardPath), original, "data.json untouched");
  assert.equal(git(fx.wt1, "status", "--porcelain"), "", "nothing to commit");

  const snap = readBoard({ boardPath });
  assert.equal(findTicket(snap, "T-001").status, "in-progress");
  assert.equal(findTicket(snap, "T-001").currentAgent, "backend");
  assert.deepEqual(findTicket(snap, "T-001").touches, ["src/T-001.mjs"], "definitions still come from the file");
  assert.equal(findTicket(snap, "T-002").status, "todo", "tickets without local status read from the file");
  assert.notEqual(snap.version, boardVersion(boardPath), "version includes the store generation");

  const one = readTicket({ boardPath, id: "T-001" });
  assert.equal(one.ticket.status, "in-progress");
  assert.equal(one.location, "board");
  assert.equal(one.source, "local-status");
  assert.equal(readTicket({ boardPath, id: "T-002" }).source, "files");

  // CLI readers: ticket read, status show, validate, eligibility.
  const read = JSON.parse(maestro(fx.wt1, "ticket", "read", "--board", boardPath, "--json").stdout);
  assert.equal(read.data.tickets[0].status, "in-progress");
  const show = JSON.parse(maestro(fx.wt1, "status", "show", "T-001", "--board", boardPath, "--json").stdout);
  assert.equal(show.ticket.status, "in-progress");
  const validate = maestro(fx.wt1, "validate", boardPath);
  assert.equal(validate.status, 0, validate.stdout);
  const eligible = listTicketEligibility({ boardPath }).verdicts.find((v) => v.ticketId === "T-001");
  assert.equal(eligible.eligible, false, "eligibility judges the overlaid status");

  // Definition edits still go to git; the file keeps its own status.
  editTicket({ boardPath, id: "T-001", changes: { name: "Renamed" } });
  const file = JSON.parse(fileText(boardPath)).tickets[0];
  assert.equal(file.name, "Renamed");
  assert.equal(file.status, "todo");
  assert.equal(readTicket({ boardPath, id: "T-001" }).ticket.status, "in-progress");
});

test("overlay: archive and unarchive move only in the store; overlayLocalStatus applies to committed definitions", () => {
  const fx = fixture();
  const boardPath = fx.board(fx.wt1);
  const original = fileText(boardPath);
  setTicketStatus({ boardPath, id: "T-001", status: "review" });
  archiveTicket({ boardPath, id: "T-001", evidence: "PR #12 merged", doneAt: "2026-10-26" });
  assert.equal(fileText(boardPath), original);
  const snap = readBoard({ boardPath });
  assert.equal(findTicket(snap, "T-001"), undefined, "left the active board");
  const archived = snap.archive.tickets.find((t) => t.id === "T-001");
  assert.equal(archived.status, "done");
  assert.equal(archived.evidence, "PR #12 merged");
  assert.equal(archived.done_at, "2026-10-26");
  assert.deepEqual(snap.archive.epics.map((e) => e.id), ["e1"], "epic copied alongside, like a file archive");
  assert.equal(listTicketEligibility({ boardPath }).verdicts.find((v) => v.ticketId === "T-004").eligible, true,
    "a dependency archived in the store satisfies its dependents");

  const committed = JSON.parse(git(fx.main, "show", "HEAD:maestro/board/data.json"));
  const view = overlayLocalStatus({ boardPath: fx.board(fx.main), data: committed, archive: { epics: [], tickets: [] } });
  assert.equal(view.archive.tickets[0].status, "done");
  assert.equal(view.archive.tickets[0].gates.merge, false, "gates are definitions and come from the given contents");

  unarchiveTicket({ boardPath, id: "T-001", status: "review" });
  const back = readTicket({ boardPath, id: "T-001" });
  assert.equal(back.location, "board");
  assert.equal(back.ticket.status, "review");
  assert.equal(back.ticket.evidence, undefined);
  assert.equal(fileText(boardPath), original);
});

test("overlay/split are pure and round-trip", () => {
  const fields = DEFAULT_STATUS_FIELDS;
  const files = { data: { epics: [{ id: "e1" }], tickets: [ticket("T-1"), ticket("T-2")] }, archive: { epics: [], tickets: [] } };
  const store = { schemaVersion: 1, board: "b", tickets: {} };
  const before = overlayBoard(files.data, files.archive, store);
  const after = structuredClone(before);
  after.data.tickets[0].status = "review";
  after.data.tickets[1].name = "edited";
  const split = splitBoard({ files, before, after, store, fields });
  assert.equal(split.data.tickets[0].status, "todo", "status stays out of the file");
  assert.equal(split.data.tickets[1].name, "edited", "definitions go to the file");
  assert.deepEqual(Object.keys(split.store.tickets), ["T-1"]);
  assert.equal(split.storeChanged, true);
  const again = overlayBoard(split.data, split.archive, split.store);
  assert.deepEqual(again, after, "files + store reproduce the logical board");
  assert.deepEqual(files.data.tickets[0].status, "todo", "inputs untouched");
});

test("worktrees: a write in one worktree is visible in the other without any commit", () => {
  const fx = fixture();
  const head = git(fx.wt2, "rev-parse", "HEAD");
  setTicketStatus({ boardPath: fx.board(fx.wt1), id: "T-003", status: "blocked" });
  assert.equal(findTicket(readBoard({ boardPath: fx.board(fx.wt2) }), "T-003").status, "blocked");
  assert.equal(findTicket(readBoard({ boardPath: fx.board(fx.main) }), "T-003").status, "blocked", "the primary checkout too");
  setTicketStatus({ boardPath: fx.board(fx.wt2), id: "T-003", status: "todo" });
  assert.equal(readTicket({ boardPath: fx.board(fx.wt1), id: "T-003" }).ticket.status, "todo");
  // The CLI writer (`maestro ticket`) and the lane planner take the same path.
  const cli = maestro(fx.wt2, "ticket", "set-status", "T-002", "review", "--board", fx.board(fx.wt2), "--json");
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(readTicket({ boardPath: fx.board(fx.wt1), id: "T-002" }).ticket.status, "review");
  const lanes = maestro(fx.wt1, "lanes", "plan", "--board", fx.board(fx.wt1), "--json");
  assert.equal(lanes.status, 0, lanes.stderr);
  assert.ok(lanes.stdout.includes('"T-001"'), lanes.stdout);
  assert.ok(!lanes.stdout.includes('"T-002"'), "a ticket in review locally is not scheduled");
  for (const dir of [fx.main, fx.wt1, fx.wt2]) assert.equal(git(dir, "status", "--porcelain"), "", `${dir} is clean`);
  assert.equal(git(fx.wt2, "rev-parse", "HEAD"), head, "no commit was made");
  assert.equal(git(fx.main, "rev-list", "--count", "--branches"), "1", "branches hold only the original commit");
  const s1 = localStatusSettings({ dataPath: fx.board(fx.wt1) }), s2 = localStatusSettings({ dataPath: fx.board(fx.wt2) });
  assert.equal(s1.ref, s2.ref, "one store per board, shared by every worktree");
  assert.equal(s1.lockDir, s2.lockDir);
});

function writer(boardPath, id, status, rounds) {
  const code = `
    import { setTicketStatus } from ${JSON.stringify(BOARD_API)};
    const statuses = ["in-progress", "review", "blocked", "backlog"];
    for (let i = 0; i < ${rounds}; i++) {
      setTicketStatus({ boardPath: ${JSON.stringify(boardPath)}, id: ${JSON.stringify(id)}, status: statuses[i % statuses.length] });
    }
    setTicketStatus({ boardPath: ${JSON.stringify(boardPath)}, id: ${JSON.stringify(id)}, status: ${JSON.stringify(status)} });`;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (status) => resolveRun({ status, err }));
  });
}

test("concurrency: simultaneous writers from two worktrees never lose an update", async () => {
  const fx = fixture();
  const rounds = 6;
  const runs = await Promise.all([
    writer(fx.board(fx.wt1), "T-001", "review", rounds),
    writer(fx.board(fx.wt2), "T-002", "blocked", rounds),
    writer(fx.board(fx.wt1), "T-003", "in-progress", rounds),
    writer(fx.board(fx.wt2), "T-004", "backlog", rounds),
  ]);
  for (const run of runs) assert.equal(run.status, 0, run.err);
  const snap = readBoard({ boardPath: fx.board(fx.main) });
  assert.deepEqual(["T-001", "T-002", "T-003", "T-004"].map((id) => findTicket(snap, id).status),
    ["review", "blocked", "in-progress", "backlog"], "every writer's last write survived");
  const entries = localStatusLog({ boardPath: fx.board(fx.wt1), limit: 1000 }).entries;
  const writes = 4 * (rounds + 1);
  const changes = entries.flatMap((e) => e.changes);
  // A write that repeats the current status is a no-op; every real change is one log commit.
  assert.ok(entries.length >= 4 * rounds && entries.length <= writes, `log has ${entries.length} entries`);
  assert.equal(changes.length, entries.length);
  assert.deepEqual(new Set(entries.map((e) => e.branch)), new Set(["lane-1", "lane-2"]));
});

test("concurrency: two worktrees claiming the same ticket — exactly one wins", async () => {
  const fx = fixture();
  const claim = (boardPath) => new Promise((resolveRun) => {
    const code = `import { claimTicket } from ${JSON.stringify(BOARD_API)};
      process.stdout.write(JSON.stringify(claimTicket({ boardPath: ${JSON.stringify(boardPath)}, id: "T-002" }).result.claimed));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (status) => resolveRun({ status, out, err }));
  });
  const results = await Promise.all([claim(fx.board(fx.wt1)), claim(fx.board(fx.wt2)), claim(fx.board(fx.wt1)), claim(fx.board(fx.wt2))]);
  for (const r of results) assert.equal(r.status, 0, r.err);
  assert.equal(results.filter((r) => r.out === "true").length, 1, JSON.stringify(results));
  assert.equal(readTicket({ boardPath: fx.board(fx.main), id: "T-002" }).ticket.status, "in-progress");
});

test("concurrency: the store's compare-and-swap refuses a stale writer", () => {
  const fx = fixture();
  const s = localStatusSettings({ dataPath: fx.board(fx.wt1) });
  const stale = readStore(s);
  setTicketStatus({ boardPath: fx.board(fx.wt2), id: "T-001", status: "review" });
  assert.throws(() => commitStore(s, stale.oid, stale.store, { op: "stale" }), BoardConflictError);
  assert.equal(readTicket({ boardPath: fx.board(fx.wt1), id: "T-001" }).ticket.status, "review");
  // expectVersion read before another worktree's status change is refused.
  const version = getBoardVersion({ boardPath: fx.board(fx.wt1) });
  setTicketStatus({ boardPath: fx.board(fx.wt2), id: "T-002", status: "blocked" });
  assert.throws(() => setTicketStatus({ boardPath: fx.board(fx.wt1), id: "T-003", status: "review", expectVersion: version }), BoardConflictError);
});

test("sync: writes the snapshot, archives done tickets, and is a no-op the second time", () => {
  const fx = fixture();
  const boardPath = fx.board(fx.wt1);
  const archivePath = join(fx.wt1, "maestro", "board", "archive.json");
  setTicketStatus({ boardPath: fx.board(fx.wt2), id: "T-001", status: "done" });
  setTicketStatus({ boardPath, id: "T-002", status: "review", coordination: { currentAgent: "qa" } });
  archiveTicket({ boardPath, id: "T-003", evidence: "PR #3", doneAt: "2026-10-25" });
  const logical = readBoard({ boardPath });

  const dry = syncLocalStatus({ boardPath, dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(git(fx.wt1, "status", "--porcelain"), "", "dry run writes nothing");

  const first = syncLocalStatus({ boardPath });
  assert.equal(first.changed, true);
  assert.deepEqual(first.archived, ["T-001"]);
  assert.ok(existsSync(first.backup), "a store backup is taken before writing");
  const data = JSON.parse(fileText(boardPath)), archive = JSON.parse(fileText(archivePath));
  assert.deepEqual(data.tickets.map((t) => [t.id, t.status]), [["T-002", "review"], ["T-004", "todo"]]);
  assert.equal(data.tickets[0].currentAgent, "qa");
  assert.deepEqual(archive.tickets.map((t) => [t.id, t.status]), [["T-003", "done"], ["T-001", "done"]]);
  assert.match(archive.tickets[1].evidence, /archived by maestro status sync/);
  assert.equal(maestro(fx.wt1, "validate", boardPath).status, 0);
  assert.deepEqual(readBoard({ boardPath }).data, data, "the logical board now equals the files");
  assert.deepEqual(readBoard({ boardPath }).archive.tickets.map((t) => t.id), logical.archive.tickets.map((t) => t.id).concat("T-001"));
  // T-001 is archived for the other worktrees too, before the sync commit reaches them.
  assert.equal(readTicket({ boardPath: fx.board(fx.wt2), id: "T-001" }).location, "archive");

  const textData = fileText(boardPath), textArchive = fileText(archivePath);
  const oid = readLocalStatus({ boardPath }).oid;
  const second = syncLocalStatus({ boardPath });
  assert.equal(second.changed, false);
  assert.deepEqual(second.files, []);
  assert.equal(fileText(boardPath), textData);
  assert.equal(fileText(archivePath), textArchive);
  assert.equal(readLocalStatus({ boardPath }).oid, oid, "no store commit either");
  const cli = JSON.parse(maestro(fx.wt1, "status", "sync", "--board", boardPath, "--json").stdout);
  assert.equal(cli.changed, false);

  // After the sync PR merges, other worktrees read the same board.
  git(fx.wt1, "commit", "-qam", "board: daily status sync");
  git(fx.main, "merge", "-q", "lane-1");
  assert.deepEqual(readBoard({ boardPath: fx.board(fx.main) }).data, data);
  assert.equal(syncLocalStatus({ boardPath: fx.board(fx.main) }).changed, false);
});

test("backup: export and import restore the store; the log records it", () => {
  const fx = fixture();
  const boardPath = fx.board(fx.wt1);
  setTicketStatus({ boardPath, id: "T-001", status: "review" });
  const out = join(fx.root, "status-backup.json");
  const exported = exportLocalStatus({ boardPath, out });
  assert.equal(exported.path, out);
  assert.equal(JSON.parse(fileText(out)).store.tickets["T-001"].fields.status, "review");
  const auto = exportLocalStatus({ boardPath });
  assert.ok(auto.path.includes(join(".git", "maestro", "status", "backups")), auto.path);

  setTicketStatus({ boardPath, id: "T-001", status: "blocked" });
  setTicketStatus({ boardPath, id: "T-002", status: "review" });
  const merged = importLocalStatus({ boardPath, file: out });
  assert.deepEqual(merged.tickets, ["T-001"]);
  assert.equal(readTicket({ boardPath, id: "T-001" }).ticket.status, "review");
  assert.equal(readTicket({ boardPath, id: "T-002" }).ticket.status, "review", "merge keeps other tickets");
  importLocalStatus({ boardPath, file: out, mode: "replace" });
  assert.equal(readTicket({ boardPath, id: "T-002" }).ticket.status, "todo", "replace installs the export exactly");
  assert.equal(importLocalStatus({ boardPath, file: out, mode: "replace" }).changed, false);

  const log = JSON.parse(maestro(fx.wt1, "status", "log", "--board", boardPath, "--json").stdout).entries;
  assert.equal(log[0].op, "status-import(replace)");
  assert.equal(log.at(-1).op, "set-ticket-status");
  assert.equal(log.at(-1).changes[0].to.status, "review");
  git(fx.main, "gc", "-q", "--prune=now");
  assert.equal(readTicket({ boardPath, id: "T-001" }).ticket.status, "review", "the store survives git gc");
  const where = JSON.parse(maestro(fx.wt2, "status", "where", "--board", fx.board(fx.wt2), "--json").stdout);
  assert.match(where.ref, /^refs\/maestro\/maestro\/status\/[0-9a-f]{16}$/);
});

test("new tickets are definitions: filed into data.json whole", () => {
  const fx = fixture();
  const boardPath = fx.board(fx.wt1);
  createTicket({ boardPath, name: "New", desc: "Acceptance.", epicId: "e1", area: "backend", agent_plan: ["pe", "backend", "qa"] });
  const file = JSON.parse(fileText(boardPath));
  assert.equal(file.tickets.at(-1).id, "T-005");
  assert.equal(file.tickets.at(-1).status, "todo");
  assert.equal(readLocalStatus({ boardPath }).tickets["T-005"], undefined);
});

test("config: localStatus is validated", () => {
  const fx = fixture();
  const configPath = join(fx.wt1, "maestro", "config.json");
  const config = JSON.parse(fileText(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, localStatus: { enabled: true, colour: "red" } }));
  assert.throws(() => readBoard({ boardPath: fx.board(fx.wt1) }), /unknown key/);
  writeFileSync(configPath, JSON.stringify({ ...config, localStatus: { enabled: true, fields: ["gates"] } }));
  const s = localStatusSettings({ dataPath: fx.board(fx.wt1) });
  assert.ok(s.fields.includes("gates") && s.fields.includes("status"));
  editTicket({ boardPath: fx.board(fx.wt1), id: "T-001", changes: {} });
  writeFileSync(configPath, JSON.stringify({ ...config, localStatus: { enabled: false } }));
  assert.equal(localStatusSettings({ dataPath: fx.board(fx.wt1) }), null);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "maestro-no-git-")));
  cpSync(join(fx.wt1, "maestro"), join(outside, "maestro"), { recursive: true });
  writeFileSync(join(outside, "maestro", "config.json"), JSON.stringify({ ...config, localStatus: { enabled: true } }));
  assert.throws(() => readBoard({ boardPath: join(outside, "maestro", "board", "data.json") }), /not inside a git repository/);
});

// Force a real write from another worktree immediately after the snapshot's store blob
// is read. This deterministically exercises the gap before version/source calculation.
for (const reader of ["board", "ticket", "eligibility"]) {
  test(`snapshot: ${reader} retains the overlaid generation during a concurrent write`, () => {
    const fx = fixture();
    const boardPath = fx.board(fx.wt1);
    setTicketStatus({ boardPath, id: "T-002", status: "in-progress" });
    const before = readBoard({ boardPath });
    const originalSpawn = childProcess.spawnSync;
    let wrote = false;
    let snapshot;
    childProcess.spawnSync = function (command, args, options) {
      const result = originalSpawn(command, args, options);
      if (!wrote && command === "git" && args.includes("cat-file") &&
          args.some((arg) => arg.endsWith(":record.json"))) {
        wrote = true;
        const write = originalSpawn(process.execPath, ["--input-type=module", "-e",
          `import { setTicketStatus } from ${JSON.stringify(BOARD_API)};
           setTicketStatus({ boardPath: ${JSON.stringify(fx.board(fx.wt2))},
             id: "T-001", status: "in-progress" });`,
        ], { encoding: "utf8" });
        assert.equal(write.status, 0, write.stderr);
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      snapshot = reader === "board" ? readBoard({ boardPath })
        : reader === "ticket" ? readTicket({ boardPath, id: "T-001" })
        : listTicketEligibility({ boardPath });
    } finally {
      childProcess.spawnSync = originalSpawn;
      syncBuiltinESMExports();
    }
    assert.equal(wrote, true, "another worktree wrote during the read");
    assert.equal(snapshot.version, before.version, "version belongs to the returned snapshot");
    assert.equal(snapshot.archiveVersion, before.archiveVersion);
    if (reader === "board") assert.equal(findTicket(snapshot, "T-001").status, "todo");
    if (reader === "ticket") {
      assert.equal(snapshot.ticket.status, "todo");
      assert.equal(snapshot.source, "files", "source belongs to the same store generation");
    }
    if (reader === "eligibility") {
      assert.equal(snapshot.verdicts.find((v) => v.ticketId === "T-001").eligible, true);
    }
    assert.equal(readTicket({ boardPath, id: "T-001" }).ticket.status, "in-progress");
    assert.notEqual(snapshot.version, getBoardVersion({ boardPath }));
    assert.throws(() => setTicketStatus({ boardPath, id: "T-001", status: "blocked",
      expectVersion: snapshot.version }), BoardConflictError, "a stale snapshot cannot overwrite the new status");
    const claim = claimTicket({ boardPath, id: "T-003", expectVersion: snapshot.version,
      expectArchiveVersion: snapshot.archiveVersion,
      expectPlanVersion: boardVersion(join(dirname(boardPath), "plan.json")) });
    assert.equal(claim.result.claimed, false, "a stale eligibility snapshot cannot claim work");
    assert.ok(claim.result.conflicts.length);
  });
}
