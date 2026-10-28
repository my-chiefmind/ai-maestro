/**
 * `orchestration.maxWorktrees: "unlimited"` and the exclusive merge lock. Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assignLanes, laneCount, laneLabel, MAX_LANES } from "../scripts/lane-core.mjs";
import {
  acquireMergeLock, releaseMergeLock, inspectMergeLock, withMergeLock, swarmRuntimeStatus,
  updateSwarmConfig, validateSwarmConfig, mergeLockPath,
} from "../scripts/swarm-core.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = (script, cwd, ...args) => spawnSync(process.execPath, [join(KIT, "scripts", script), ...args], { cwd, encoding: "utf8" });

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-swarm-")));
  const r = spawnSync("git", ["init", "-q", root]);
  assert.equal(r.status, 0);
  return root;
}

const independent = (n) => Array.from({ length: n }, (_, i) => ({ id: `T-${i + 1}`, epicId: `e${i}`, area: `a${i}`, touches: [`src/m${i}/**`], status: "todo" }));

test("lanes: numeric pool sizes keep the 1–5 ceiling; \"unlimited\" opens a lane per independent ticket", () => {
  assert.equal(laneCount(null), 3);
  assert.equal(laneCount({ orchestration: { maxWorktrees: 9 } }), MAX_LANES);
  assert.equal(laneCount({ orchestration: { maxWorktrees: "unlimited" } }), Infinity);
  assert.equal(laneLabel(Infinity), "unlimited");
  assert.equal(laneLabel(4), 4);
  const capped = assignLanes(independent(8), { orchestration: { maxWorktrees: 5 } });
  assert.equal(capped.lanes.length, 5);
  const open = assignLanes(independent(8), { orchestration: { maxWorktrees: "unlimited" } });
  assert.equal(open.lanes.length, 8);
});

test("lanes: validator, swarm config and lane CLI accept \"unlimited\"", () => {
  assert.deepEqual(validateSwarmConfig({ orchestration: { maxWorktrees: "unlimited" } }), []);
  assert.match(validateSwarmConfig({ orchestration: { maxWorktrees: 0 } }).join(), /from 1 to 5, or "unlimited"/);
  assert.match(validateSwarmConfig({ orchestration: { maxWorktrees: "lots" } }).join(), /"unlimited"/);
  assert.equal(updateSwarmConfig({}, { enabled: true, maxWorktrees: "unlimited" }).orchestration.maxWorktrees, "unlimited");

  const root = repo();
  mkdirSync(join(root, "maestro", "board"), { recursive: true });
  writeFileSync(join(root, "maestro", "config.json"), JSON.stringify({ orchestration: { maxWorktrees: 2 } }));
  let r = node("swarm-config.mjs", root, "enable", "--worktrees", "unlimited");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(readFileSync(join(root, "maestro", "config.json"), "utf8")).orchestration.maxWorktrees, "unlimited");
  r = node("swarm-config.mjs", root, "status", "--json");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).maxWorktrees, "unlimited");

  writeFileSync(join(root, "maestro", "board", "data.json"), JSON.stringify({ epics: [], tickets: [] }));
  r = node("lane-plan.mjs", root, "plan", "--board", join(root, "maestro", "board", "data.json"), "--json");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).max, "unlimited");
  const v = node("validate-board.mjs", root, join(root, "maestro", "board", "data.json"));
  assert.equal(v.status, 0, v.stderr + v.stdout);
});

test("merge lock: one holder at a time, shared by worktrees, released only by its holder", () => {
  const root = repo();
  const path = mergeLockPath(root);
  assert.ok(path.endsWith("maestro-merge.lock"));
  const a = acquireMergeLock({ repoRoot: root, holder: { holder: "lane-1", ticket: "T-1", pid: process.pid } });
  assert.equal(a.acquired, true);
  // A linked worktree of the same checkout sees the same lock.
  for (const args of [["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], ["worktree", "add", "-q", join(root, "wt"), "-b", "wt"]]) {
    assert.equal(spawnSync("git", ["-C", root, ...args]).status, 0);
  }
  assert.equal(mergeLockPath(join(root, "wt")), path);
  const b = acquireMergeLock({ repoRoot: join(root, "wt"), holder: { holder: "lane-2" } });
  assert.equal(b.acquired, false);
  assert.match(b.reason, /held for T-1 by lane-1/);
  assert.equal(releaseMergeLock({ repoRoot: root, holder: "lane-2" }).released, false);
  assert.equal(inspectMergeLock(root).held, true);
  assert.equal(releaseMergeLock({ repoRoot: root, holder: "lane-1", token: a.holder.token }).released, true);
  assert.equal(releaseMergeLock({ repoRoot: root, holder: "lane-1" }).notHeld, true);
  assert.equal(acquireMergeLock({ repoRoot: root, holder: {} }).acquired, false, "a holder name is required");
});

test("merge lock: a dead holder's lock and an old pid-less lock are broken; a live one never", () => {
  const root = repo();
  // A pid that cannot be running.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(acquireMergeLock({ repoRoot: root, holder: { holder: "crashed", pid: Number(dead.stdout) } }).acquired, true);
  assert.equal(acquireMergeLock({ repoRoot: root, holder: { holder: "next" } }).acquired, true);
  // pid-less: stale only by age.
  const old = Date.now() - 2 * 60 * 60 * 1000;
  utimesSync(mergeLockPath(root), old / 1000, old / 1000);
  const after = acquireMergeLock({ repoRoot: root, holder: { holder: "third", pid: process.pid } });
  assert.equal(after.acquired, true);
  utimesSync(mergeLockPath(root), old / 1000, old / 1000);
  assert.equal(acquireMergeLock({ repoRoot: root, holder: { holder: "fourth" } }).acquired, false, "a live holder's lock is never stale");
});

test("merge lock: withMergeLock releases on throw; outside git there is no lock", () => {
  const root = repo();
  assert.throws(() => withMergeLock({ repoRoot: root, holder: { holder: "x" } }, () => { throw new Error("boom"); }), /boom/);
  assert.equal(inspectMergeLock(root).held, false);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "maestro-nogit-")));
  assert.equal(inspectMergeLock(plain).available, false);
  assert.equal(acquireMergeLock({ repoRoot: plain, holder: { holder: "x" } }).acquired, false);
});

test("swarm status: auto-merge is effective only when requested and the lock exists", () => {
  const root = repo();
  assert.equal(swarmRuntimeStatus({}, { repoRoot: root }).effectiveAutoMerge, false);
  const on = swarmRuntimeStatus({ orchestration: { swarm: { autoMerge: true } } }, { repoRoot: root });
  assert.equal(on.effectiveAutoMerge, true);
  assert.equal(on.mergeLock.kind, "file");
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "maestro-nogit-")));
  const off = swarmRuntimeStatus({ orchestration: { swarm: { autoMerge: true } } }, { repoRoot: plain });
  assert.equal(off.effectiveAutoMerge, false);
  assert.match(off.autoMergeBlocker, /fail-closed/);
});

test("swarm CLI: lock exits 3 while held; unlock needs the holder or --force", () => {
  const root = repo();
  writeFileSync(join(root, "config.json"), "{}");
  let r = node("swarm-config.mjs", root, "lock", "--holder", "a", "--ticket", "T-9", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).holder.ticket, "T-9");
  r = node("swarm-config.mjs", root, "lock", "--holder", "b");
  assert.equal(r.status, 3);
  r = node("swarm-config.mjs", root, "unlock", "--holder", "b");
  assert.equal(r.status, 3);
  r = node("swarm-config.mjs", root, "unlock", "--force");
  assert.equal(r.status, 0);
  assert.ok(!existsSync(mergeLockPath(root)));
});
