/**
 * Tests for `maestro run` (scripts/run-ticket.mjs) — the triggered dev -> PR -> reviewer
 * pipeline for a cross-review-enabled ticket.
 *
 * These only exercise --dry-run and error paths: --dry-run resolves roles and exits before
 * touching the board, invoking any agent CLI, or calling gh, so it's the only mode safe to
 * run unattended in CI (no real API cost, no real git/gh state).
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TICKET = join(KIT, "scripts", "run-ticket.mjs");

function project({ tickets, config }) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-run-test-"));
  mkdirSync(join(dir, "board"), { recursive: true });
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, "board", "data.json"), JSON.stringify({
    epics: [{ id: "e1", name: "Epic" }],
    tickets,
  }, null, 2));
  return dir;
}

function ticket(overrides = {}) {
  return {
    id: "T-1", epicId: "e1", name: "ticket", desc: "d", area: "backend",
    status: "todo", priority: "P2", agent_plan: ["backend", "qa", "merge"], model: "sonnet",
    testCmd: "node --version",
    ...overrides,
  };
}

// run-ticket.mjs resolves the git repo before anything else (worktree/branch info is part of
// what --dry-run reports), so every call needs a real repo. Default to this kit's own clone
// rather than relying on the test runner's incidental cwd.
function run(dir, args, { repo = KIT, env } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [
        RUN_TICKET, ...args,
        "--board", join(dir, "board", "data.json"),
        "--config", join(dir, "config.json"),
        "--repo", repo,
      ], { encoding: "utf8", env: env ? { ...process.env, ...env } : process.env }),
    };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** A real (throwaway) git repo with an `origin` remote and a pushed default branch — enough
 *  for run-ticket.mjs's `git fetch origin` / `origin/HEAD` resolution and worktree creation. */
function makeGitRepo() {
  const bare = mkdtempSync(join(tmpdir(), "maestro-run-origin-"));
  // -b main, explicitly: without it, the bare repo's HEAD symref follows the machine's
  // init.defaultBranch (main here, but master on a stock git — e.g. CI runners), so
  // `git remote set-head origin -a` in run-ticket.mjs can fail to resolve origin/HEAD even
  // though "main" is the only branch ever pushed.
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = mkdtempSync(join(tmpdir(), "maestro-run-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test"]);
  writeFileSync(join(work, "README.md"), "hi\n");
  execFileSync("git", ["-C", work, "add", "."]);
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", work, "push", "-q", "-u", "origin", "main"]);
  return { work, bare };
}

/** A PATH-prependable dir with no-op `claude`/`codex` shims and a `gh` shim that reports auth
 *  ok and no PRs — enough to drive run-ticket.mjs up to (but not through) a real agent/PR, so
 *  the worktree/branch machinery can be checked without spending real API cost or needing a
 *  real GitHub remote. */
function makeStubBin() {
  const bin = mkdtempSync(join(tmpdir(), "maestro-run-bin-"));
  const shim = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  const agent = `
if [ "$1" = "--version" ]; then exit 0; fi
printf 'agent change\n' >> agent-change.txt
git add agent-change.txt
git commit -q -m "agent change"
exit 0
`.trim();
  shim("claude", agent);
  shim("codex", agent);
  shim("gh", `
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
exit 0
`.trim());
  return bin;
}

test("--dry-run resolves dev/reviewer roles from config.crossReview defaults", () => {
  const dir = project({
    tickets: [ticket()],
    config: { crossReview: { dev: { runtime: "claude", model: "sonnet" }, reviewer: { runtime: "codex", model: "opus" } } },
  });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, true);
    assert.match(out, /dev\s+claude\/sonnet/);
    assert.match(out, /reviewer\s+codex\/opus/);
    assert.match(out, /nothing was executed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket's own dev_runtime/reviewer_runtime overrides the config default", () => {
  const dir = project({
    tickets: [ticket({ dev_runtime: "codex", dev_model: "haiku", reviewer_runtime: "claude", reviewer_model: "opus" })],
    config: { crossReview: { dev: { runtime: "claude", model: "sonnet" }, reviewer: { runtime: "codex", model: "opus" } } },
  });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, true);
    assert.match(out, /dev\s+codex\/haiku/);
    assert.match(out, /reviewer\s+claude\/opus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a literal Codex model id is preserved in the resolved plan", () => {
  const dir = project({
    tickets: [ticket({ dev_runtime: "codex", dev_model: "gpt-5.4", reviewer_runtime: "claude", reviewer_model: "sonnet" })],
  });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, true);
    assert.match(out, /dev\s+codex\/gpt-5\.4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ticket ids cannot escape the dedicated worktree parent", () => {
  const dir = project({
    tickets: [ticket({ id: "../escape", dev_runtime: "claude", reviewer_runtime: "codex" })],
  });
  try {
    const { ok, out } = run(dir, ["../escape", "--dry-run"]);
    assert.equal(ok, true);
    assert.match(out, /branch\s+feat\/escape-ticket/);
    assert.match(out, /\.maestro-wt\/escape/);
    assert.doesNotMatch(out, /\.maestro-wt\/\.\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cross-review ticket without a verification command is refused", () => {
  const dir = project({
    tickets: [ticket({ testCmd: undefined, dev_runtime: "claude", reviewer_runtime: "codex" })],
  });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /has no test command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--auto-merge changes the printed merge behavior", () => {
  const dir = project({
    tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex" })],
  });
  try {
    const { out } = run(dir, ["T-1", "--dry-run", "--auto-merge"]);
    assert.match(out, /merge\s+automatic after approval \+ checks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket with no cross-review role and no config default is refused", () => {
  const dir = project({ tickets: [ticket()] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /has no cross-review role set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid dev_runtime is refused before anything runs", () => {
  const dir = project({ tickets: [ticket({ dev_runtime: "gpt5", reviewer_runtime: "claude" })] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /dev_runtime "gpt5" has no installed adapter \(supported: claude, codex\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown ticket id is a clear error", () => {
  const dir = project({ tickets: [ticket()] });
  try {
    const { ok, out } = run(dir, ["T-999", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /T-999 is not a live ticket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help prints usage and does not require a board", () => {
  const out = execFileSync(process.execPath, [RUN_TICKET, "--help"], { encoding: "utf8" });
  assert.match(out, /maestro run <ticket-id>/);
});

test("--repo pointing outside any git repository is a clear error", () => {
  const dir = project({ tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex" })] });
  const notGit = mkdtempSync(join(tmpdir(), "maestro-run-not-git-"));
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"], { repo: notGit });
    assert.equal(ok, false);
    assert.match(out, /is not inside a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notGit, { recursive: true, force: true });
  }
});

test("a ticket that isn't todo is refused as ineligible", () => {
  const dir = project({ tickets: [ticket({ status: "blocked", dev_runtime: "claude", reviewer_runtime: "codex" })] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /not eligible to run right now/);
    assert.match(out, /status is "blocked", not "todo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a human-gated ticket is refused as ineligible", () => {
  const dir = project({ tickets: [ticket({ human_gate: "owner sign-off", dev_runtime: "claude", reviewer_runtime: "codex" })] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /human-gated \("owner sign-off"\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket with an unmet dependency is refused as ineligible", () => {
  const dir = project({
    tickets: [
      ticket({ id: "T-1", dev_runtime: "claude", reviewer_runtime: "codex", depends_on: ["T-2"] }),
      ticket({ id: "T-2", status: "todo" }),
    ],
  });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run"]);
    assert.equal(ok, false);
    assert.match(out, /depends on T-2, not done yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--resume on a plain todo ticket (nothing to resume) is refused", () => {
  const dir = project({ tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex" })] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run", "--resume"]);
    assert.equal(ok, false);
    assert.match(out, /--resume needs T-1 to be "in-progress" or "review"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already in-progress ticket passes eligibility with --resume", () => {
  const dir = project({ tickets: [ticket({ status: "in-progress", dev_runtime: "claude", reviewer_runtime: "codex" })] });
  try {
    const { ok, out } = run(dir, ["T-1", "--dry-run", "--resume"]);
    assert.equal(ok, true);
    assert.match(out, /nothing was executed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the dev stage isolates work in its own worktree, on a deterministic branch, before touching the repo", () => {
  const { work: repo, bare } = makeGitRepo();
  const bin = makeStubBin();
  const dir = project({ tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex" })] });
  const worktreeDir = join(repo, "..", ".maestro-wt", "T-1");
  try {
    // No --dry-run: this drives the real dev stage against stub claude/codex/gh binaries, up
    // to (and stopping at) "no PR found" — the point at which a real gh would have one.
    const { ok, out } = run(dir, ["T-1"], {
      repo,
      env: { PATH: `${bin}:${process.env.PATH}`, MAESTRO_REVIEWER_GH_TOKEN: "test-reviewer-token" },
    });
    assert.equal(ok, false);
    assert.match(out, /no PR was found for branch "feat\/T-1-ticket"/);

    // The isolation property under test: the worktree exists, on the right branch, and the
    // primary checkout's own branch was never touched.
    assert.equal(existsSync(worktreeDir), true);
    const wtBranch = execFileSync("git", ["-C", worktreeDir, "branch", "--show-current"], { encoding: "utf8" }).trim();
    assert.equal(wtBranch, "feat/T-1-ticket");
    const repoBranch = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim();
    assert.equal(repoBranch, "main");

    const board = JSON.parse(readFileSync(join(dir, "board", "data.json"), "utf8"));
    assert.equal(board.tickets.find((t) => t.id === "T-1").status, "in-progress");
  } finally {
    try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktreeDir], { stdio: "ignore" }); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
