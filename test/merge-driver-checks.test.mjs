/**
 * The board merge driver (merge data.json by ticket id) and the process-ratio /
 * evidence-budget checks. Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeValue, mergeDriverStatus } from "../scripts/board-merge-driver.mjs";
import {
  categorize, evidenceViolations, processRatioSettings, evidenceBudgetSettings, parseNumstatLog,
  summarizeProcessRatio, processChecksConfigIssues,
} from "../scripts/process-checks.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(KIT, "bin", "cli.mjs");

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const tryGit = (cwd, ...args) => spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
const maestro = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
const json = (v) => JSON.stringify(v, null, 2) + "\n";
const t = (id, extra = {}) => ({ id, name: id, status: "todo", ...extra });

// ── merge driver ────────────────────────────────────────────────────────────

test("merge driver: tickets merge by id; disjoint field changes on one ticket merge", () => {
  const base = { epics: [], tickets: [t("T-1"), t("T-2")] };
  const ours = { epics: [], tickets: [t("T-1", { status: "done" }), t("T-2"), t("T-3")] };
  const theirs = { epics: [], tickets: [t("T-1", { name: "Renamed" }), t("T-2"), t("T-4")] };
  assert.deepEqual(mergeValue(base, ours, theirs), {
    epics: [], tickets: [t("T-1", { status: "done", name: "Renamed" }), t("T-2"), t("T-3"), t("T-4")],
  });
  // Deleted on one side, untouched on the other: stays deleted.
  assert.deepEqual(mergeValue(base, { epics: [], tickets: [t("T-2")] }, base).tickets, [t("T-2")]);
  assert.throws(() => mergeValue(base, { ...base, tickets: [t("T-1", { status: "done" }), t("T-2")] }, { ...base, tickets: [t("T-1", { status: "blocked" }), t("T-2")] }), /tickets\[T-1\]\.status/);
});

/** A repo with maestro/ holding a vendored copy of this kit's scripts and a board. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-driver-")));
  mkdirSync(join(root, "maestro", "board"), { recursive: true });
  for (const d of ["scripts", "bin", "render"]) cpSync(join(KIT, d), join(root, "maestro", d), { recursive: true });
  writeFileSync(join(root, "maestro", "config.json"), "{}\n");
  writeFileSync(join(root, "maestro", "board", "data.json"), json({ epics: [], tickets: [t("T-1"), t("T-2")] }));
  writeFileSync(join(root, "maestro", "board", "archive.json"), json({ epics: [], tickets: [] }));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

test("merge driver: install registers it; two branches adding tickets merge without conflict", () => {
  const root = repo();
  const kitCli = join(root, "maestro", "bin", "cli.mjs");
  const run = (...a) => spawnSync(process.execPath, [kitCli, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(run("merge-driver", "status").status, 1, "not registered yet");
  const r = run("merge-driver", "install");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = mergeDriverStatus({ cwd: root, kitRoot: join(root, "maestro") });
  assert.equal(s.configured, true);
  assert.equal(s.command, "node maestro/scripts/board-merge-driver.mjs %O %A %B");
  assert.match(readFileSync(join(root, ".gitattributes"), "utf8"), /^maestro\/board\/data\.json merge=maestro-board$/m);
  assert.equal(run("merge-driver", "install").status, 0, "idempotent");
  assert.equal(readFileSync(join(root, ".gitattributes"), "utf8").match(/data\.json merge/g).length, 1);
  git(root, "add", "-A"); git(root, "commit", "-qm", "driver");

  const board = join(root, "maestro", "board", "data.json");
  git(root, "checkout", "-qb", "a");
  writeFileSync(board, json({ epics: [], tickets: [t("T-1", { status: "done" }), t("T-2"), t("T-3")] }));
  git(root, "commit", "-qam", "a");
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-qb", "b");
  writeFileSync(board, json({ epics: [], tickets: [t("T-1"), t("T-2", { status: "blocked" }), t("T-4")] }));
  git(root, "commit", "-qam", "b");
  git(root, "merge", "-q", "--no-edit", "a");
  assert.deepEqual(JSON.parse(readFileSync(board, "utf8")).tickets.map((x) => [x.id, x.status]),
    [["T-1", "done"], ["T-2", "blocked"], ["T-4", "todo"], ["T-3", "todo"]]);

  // A real conflict falls back to markers and fails the merge.
  git(root, "checkout", "-qb", "c", "main");
  writeFileSync(board, json({ epics: [], tickets: [t("T-1", { status: "review" }), t("T-2")] }));
  git(root, "commit", "-qam", "c");
  const m = tryGit(root, "merge", "--no-edit", "a");
  assert.notEqual(m.status, 0);
  assert.match(readFileSync(board, "utf8"), /^<<<<<<< /m);
  git(root, "merge", "--abort");

  assert.equal(run("merge-driver", "uninstall").status, 0);
  assert.equal(mergeDriverStatus({ cwd: root, kitRoot: join(root, "maestro") }).configured, false);
  assert.doesNotMatch(readFileSync(join(root, ".gitattributes"), "utf8"), /maestro-board/);
});

// ── process ratio / evidence budget ─────────────────────────────────────────

test("process-ratio: categories, generated files and the two targets", () => {
  const s = processRatioSettings({ checks: { processRatio: { generated: ["vendor/gen/**"] } } }, { boardRel: "maestro/board" });
  assert.equal(categorize("maestro/board/reports/T-1.md", s), "evidence");
  assert.equal(categorize("maestro/board/data.json", s), "board");
  assert.equal(categorize("package-lock.json", s), "generated");
  assert.equal(categorize("vendor/gen/x.js", s), "generated");
  assert.equal(categorize("README.md", s), "docs");
  assert.equal(categorize("src/a.test.mjs", s), "tests");
  assert.equal(categorize("src/a.mjs", s), "code");
  const log = ["@@abc code", "90\t1\tsrc/a.mjs", "@@def board", "10\t0\tmaestro/board/data.json", "@@ghi lock", "500\t0\tpackage-lock.json"].join("\n");
  const sum = summarizeProcessRatio(parseNumstatLog(log, s), s);
  assert.equal(sum.total, 100);
  assert.equal(sum.processPct, 10);
  assert.equal(sum.commits, 2, "a generated-only commit is not counted");
  assert.equal(sum.noCodePct, 50);
  assert.equal(sum.missed, true);
  assert.deepEqual(processChecksConfigIssues({ checks: { processRatio: { lineTargetPct: "x", process: ["nope"] } } }).length, 2);
});

test("check CLI: process-ratio --check and evidence-budget on a real branch", () => {
  const root = repo();
  mkdirSync(join(root, "maestro", "board", "reports"), { recursive: true });
  writeFileSync(join(root, "src.mjs"), "x\n".repeat(50));
  git(root, "add", "-A"); git(root, "commit", "-qm", "code");
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "maestro", "board", "reports", "T-1.md"), "ok\n".repeat(10));
  writeFileSync(join(root, "maestro", "board", "reports", "raw.json"), "{}\n");
  writeFileSync(join(root, "maestro", "board", "reports", "big.md"), "x\n".repeat(250));
  git(root, "add", "-A"); git(root, "commit", "-qm", "reports");

  let r = maestro(root, "check", "evidence-budget", "--base", "main", "--json");
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "FAIL");
  assert.equal(out.problems.length, 2, out.problems.join("\n")); // raw.json, big.md
  r = spawnSync(process.execPath, [CLI, "check", "evidence-budget", "--base", "main"], { cwd: root, encoding: "utf8", env: { ...process.env, EVIDENCE_BUDGET_WAIVER: "owner ok 2026-10-27" } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WAIVED \(owner ok/);

  // Configured limits apply.
  writeFileSync(join(root, "maestro", "config.json"), json({ checks: { evidenceBudget: { maxFileLines: 300, maxTotalLines: 1000, allowedSuffixes: [".md", ".json"] } } }));
  r = maestro(root, "check", "evidence-budget", "--base", "main");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PASS/);

  r = maestro(root, "check", "process-ratio", "--ref", "HEAD", "--days", "3650", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).added.evidence, 261);
  writeFileSync(join(root, "maestro", "config.json"), json({ checks: { processRatio: { lineTargetPct: 0 } } }));
  assert.equal(maestro(root, "check", "process-ratio", "--ref", "HEAD", "--days", "3650", "--check").status, 1);
  writeFileSync(join(root, "maestro", "config.json"), json({ checks: { processRatio: { lineTargetPct: 100, commitTargetPct: 100 } } }));
  assert.equal(maestro(root, "check", "process-ratio", "--ref", "HEAD", "--days", "3650", "--check").status, 0);
});

test("evidence-budget: deletions pass; settings follow the board location", () => {
  const s = evidenceBudgetSettings({}, { boardRel: "board" });
  assert.equal(s.reportsDir, "board/reports/");
  assert.deepEqual(evidenceViolations([["D", "board/reports/x.log", 0]], s).problems, []);
});
