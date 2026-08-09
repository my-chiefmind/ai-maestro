/**
 * T-008 — writer-lease enforcement in the orchestrate workflow engine.
 *
 * Grounded in a real incident: on ticket tl-213 an orchestrator ran mutating gate commands
 * (ruff --fix, pytest) in a worktree whose lease a live backend-developer held; the
 * developer's concurrent `git reset --hard` made the orchestrator read an empty tree and
 * file a false "work destroyed" blocker on green work — which was uncommitted, so a reset
 * 60s earlier would have destroyed it for real.
 *
 * The enforcement lives in two pure functions inside workflows/orchestrator-core.js
 * (writerHandoffRejection, leaseConflict). The core is a Workflow script (top-level return,
 * runtime-provided globals), so it can't be imported — instead these tests render a real
 * project, extract the functions from the GENERATED artifact, and exercise them. That way
 * the tests pin what ships, not a parallel copy free to drift.
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

// One render for the whole file: the artifact under test is the generated workflow.
const tmp = mkdtempSync(join(tmpdir(), "orch-lease-"));
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

// Extract a top-level function from the generated script and instantiate it.
function extract(name) {
  const m = artifact.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `function ${name} must exist in the generated workflow`);
  return new Function(`return ${m[0]}`)();
}
const writerHandoffRejection = extract("writerHandoffRejection");
const leaseConflict = extract("leaseConflict");

// ── leaseConflict: the two-writer case (AC2/AC3) ─────────────────────────────────────────

test("a gate/reader is refused while a live writer holds the lease — the tl-213 case", () => {
  // The on-disk record says backend-developer holds the lease; the orchestrator's gate
  // (expectedHolder null — readers need the lease FREE) asks to run. It must be refused.
  const onDisk = { writerLease: { holder: "backend-developer", stageIndex: 1, acquiredTs: null, staleAfterStages: 1 } };
  const conflict = leaseConflict(onDisk, null);
  assert.ok(conflict, "a reader must not run in a worktree with a held lease");
  assert.match(conflict, /backend-developer/);
});

test("a second writer is refused while another writer holds the lease", () => {
  const onDisk = { writerLease: { holder: "backend-developer", stageIndex: 1, acquiredTs: null, staleAfterStages: 1 } };
  assert.ok(leaseConflict(onDisk, "frontend-developer"), "two writers in one worktree is exactly the incident");
});

test("a free lease, or the asker's own lease, is no conflict", () => {
  assert.equal(leaseConflict({ writerLease: { holder: null, stageIndex: 0, acquiredTs: null, staleAfterStages: 1 } }, null), null);
  assert.equal(leaseConflict({ writerLease: { holder: "backend-developer", stageIndex: 1, acquiredTs: null, staleAfterStages: 1 } }, "backend-developer"), null,
    "re-entering your own lease (crash resume) must not self-deadlock");
});

// ── writerHandoffRejection: uncommitted work is not a handoff (AC1) ──────────────────────

test("a done handoff with no commit SHA is rejected", () => {
  const rej = writerHandoffRejection(
    { status: "done", commit: null },
    { clean: true, newCommits: 0, commitExists: false },
  );
  assert.match(rej, /no commit SHA/);
});

test("a dirty worktree after handoff is rejected — the near-miss that motivated T-008", () => {
  // tl-213's work sat uncommitted (untracked files) when the concurrent reset hit.
  const rej = writerHandoffRejection(
    { status: "done", commit: "abc1234" },
    { clean: false, newCommits: 1, commitExists: true },
  );
  assert.match(rej, /uncommitted changes/);
});

test("a commit the branch does not contain, or zero new commits, is rejected", () => {
  assert.match(
    writerHandoffRejection({ status: "done", commit: "abc1234" }, { clean: true, newCommits: 1, commitExists: false }),
    /does not contain/);
  assert.match(
    writerHandoffRejection({ status: "done", commit: "abc1234" }, { clean: true, newCommits: 0, commitExists: true }),
    /no new commits/);
});

test("a clean, committed handoff passes; blocked/error handoffs take their own path", () => {
  assert.equal(
    writerHandoffRejection({ status: "done", commit: "abc1234" }, { clean: true, newCommits: 2, commitExists: true }),
    null);
  assert.equal(
    writerHandoffRejection({ status: "blocked", commit: null }, { clean: false, newCommits: 0, commitExists: false }),
    null, "a blocked handoff is not subject to the commit requirement");
});

// ── The engine actually wires the rules in (not just defines them) ───────────────────────

test("the generated engine enforces the rules, not just documents them", () => {
  // Writer stages get the commit-required schema; the audit runs after a writer's done.
  assert.match(artifact, /WRITER_HANDOFF_SCHEMA = \{/);
  assert.match(artifact, /required: \[\.\.\.HANDOFF_SCHEMA\.required, "commit"\]/);
  assert.match(artifact, /schema: writer \? WRITER_HANDOFF_SCHEMA : HANDOFF_SCHEMA/);
  assert.match(artifact, /verifyWriterState\(record, handoff\)/);

  // Every stage preflights the ON-DISK lease before touching the worktree.
  assert.match(artifact, /preflightLease\(record\.ticket/);
  assert.match(artifact, /"lease-conflict"/);

  // Readers are told read-only means read-only; blockers require git evidence first.
  assert.match(artifact, /never run a mutating command in this worktree/);
  assert.match(artifact, /VERIFY BEFORE FILING/);
});
