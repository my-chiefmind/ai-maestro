#!/usr/bin/env node
/**
 * run-ticket.mjs — `maestro run <ticket-id>`: a triggered, one-shot dev → PR → reviewer
 * pipeline for a cross-review-enabled ticket.
 *
 * "Cross-review-enabled" means the ticket carries dev_runtime/reviewer_runtime (directly, or
 * via config.json's crossReview defaults) — see board/board.schema.json and
 * docs/MODEL-ROUTING.md. A ticket with neither role set still runs the classic way, inside an
 * interactive `claude`/`codex` session working the board's agent_plan; this command is not
 * for that ticket.
 *
 * This is NOT a background daemon. One invocation runs ONE ticket through both stages and
 * exits — dev implements + opens a PR, then a reviewer (independently chosen vendor and/or
 * model) reviews it and takes one real `gh pr review` action. Safety properties this file is
 * responsible for, each tied to a real failure mode a plain "shell out and trust the output"
 * version would have:
 *
 *   - ISOLATION: the dev (and reviewer) stage never runs in your primary checkout. Each
 *     ticket gets its own `git worktree` (../.maestro-wt/<id>, the same convention the
 *     worktree-cleanup skill documents), so an unattended agent can never commit, or check out
 *     a different branch on top of, work you have sitting in your main working directory.
 *   - ELIGIBILITY: a fresh run refuses a ticket that isn't `todo`, is human-gated, has unmet
 *     dependencies, or is out of the plan's scope — the same gate the orchestrator itself
 *     applies (scripts/board-core.mjs's eligibleTickets) — and the first board write is
 *     version-guarded so two concurrent `maestro run` calls on the same ticket can't both win.
 *   - VERIFIED PR IDENTITY: the dev stage's PR is discovered by this script via
 *     `gh pr list --head <deterministic-branch>`, never parsed from the agent's own claimed
 *     text — a branch name derived from the ticket id, not chosen by the agent.
 *   - VERIFIED REVIEW: the reviewer's verdict is read back from GitHub's own review history
 *     (`gh pr view --json reviews`) after the stage runs, not trusted from the agent's
 *     self-report. A claimed "approve" GitHub didn't actually record (e.g. GitHub refuses to
 *     let an author approve their own PR) is a hard failure,
 *     not a silent success.
 *   - GATED MERGE: only this script's --auto-merge flag may run `gh pr merge`. It re-runs the
 *     configured tests, waits for reported PR checks, requests the merge, then confirms GitHub
 *     recorded a merge commit before archiving. The reviewer's prompt never permits merging.
 *   - RESUMABLE: because the PR is found by branch name rather than persisted separately,
 *     `--resume` on an already in-progress/review ticket picks up from the existing PR
 *     instead of re-running (and potentially duplicating) the dev stage.
 *
 * Headless dispatch needs the dev/reviewer CLI to run without a human answering permission
 * prompts, and this script does not guess a bypass flag for you — every environment's own
 * sandboxing/approval policy differs. Pass whatever yours requires via --claude-flag /
 * --codex-flag (repeatable, forwarded verbatim), e.g.:
 *   maestro run T-042 --claude-flag --permission-mode --claude-flag bypassPermissions
 *   maestro run T-042 --codex-flag --dangerously-bypass-approvals-and-sandbox
 * Only do this in an environment you trust to run unattended, network-capable agents that can
 * write code, push branches, and open/review pull requests.
 *
 * The reviewer uses MAESTRO_REVIEWER_GH_TOKEN. GitHub refuses to let one account approve its
 * own pull request, so the runner verifies that token resolves to a different account. Tokens
 * are intentionally environment-only so they do not leak through shell history/process args.
 *
 * Usage:
 *   maestro run <ticket-id> [--auto-merge] [--dry-run] [--resume]
 *     [--board <path>] [--archive <path>] [--config <path>] [--repo <dir>] [--timeout <seconds>]
 *     [--claude-flag <flag>]... [--codex-flag <flag>]...
 *
 * Exit codes: 0 = pipeline completed (whatever the reviewer's verdict), 1 = usage/setup
 * error or a stage failed outright. Either way the board is left in the last state a stage
 * actually reached — never silently advanced past a step that didn't finish.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { eligibleTickets } from "./board-core.mjs";
import { boardVersion } from "./board-io.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import { planIsGating, scopeVerdict } from "./plan-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");
const NODE = process.execPath;
const RUNTIME_ADAPTERS = new Set(["claude", "codex"]);

// Codex has no haiku/sonnet/opus model alias — Maestro's tiers map to its reasoning-effort
// config instead, and the model itself is left at whatever the caller's own Codex config
// already selects. See docs/MODEL-ROUTING.md. (Pass a literal Codex model via --codex-flag -m
// <model> if you want one selected explicitly.)
const CODEX_EFFORT = { haiku: "low", sonnet: "medium", opus: "high" };

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`
  maestro run <ticket-id>   run a cross-review-enabled ticket: dev → PR → reviewer

  Flags:
    --auto-merge            squash-merge the PR if the reviewer records an APPROVED review
                             and both local verification and reported PR checks pass; without
                             it, an approval is left for a human to merge
    --resume                pick up an already in-progress/review ticket from its existing PR
                             instead of starting the dev stage over
    --dry-run               resolve and print the plan (roles, models, branch); run nothing
    --board <path>          board/data.json (default: ./board/data.json)
    --archive <path>        archive.json (default: alongside --board)
    --config <path>         project config.json (default: alongside the board's project dir)
    --repo <dir>            git repo to work in (default: cwd) — worktrees are created as
                             siblings of it, at ../.maestro-wt/<ticket-id>
    --timeout <seconds>     per-stage timeout (default: 1800)
    --claude-flag <flag>    forwarded verbatim to \`claude\`, repeatable
    --codex-flag <flag>     forwarded verbatim to \`codex exec\`, repeatable
    MAESTRO_REVIEWER_GH_TOKEN must contain a token for the reviewer's distinct GitHub account

  Requires dev_runtime + reviewer_runtime, either on the ticket or via config.json's
  crossReview defaults, and the ticket to be eligible (todo, no human_gate, deps done, in the
  plan's scope if one is gating) unless --resume. Headless runs need YOUR OWN permission/
  sandbox bypass flags — see the file header for why this script does not choose one for you.
`);
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
  usage();
  process.exit(argv.length ? 0 : 1);
}

function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : def;
}
function flagAll(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      if (argv[i + 1] == null) die(`--${name} needs a value.`);
      out.push(argv[i + 1]);
    }
  }
  return out;
}
function has(name) {
  return argv.includes(`--${name}`);
}

const ticketId = argv[0];
if (!ticketId || ticketId.startsWith("--")) die("Usage: maestro run <ticket-id> [...] — run 'maestro run --help' for flags.");

function git(dir, args, opts = {}) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", ...opts });
}

/** The repo's actual toplevel — so a worktree path computed as its sibling is always right,
 *  even when --repo (or cwd) names a subdirectory. */
function gitToplevel(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) die(`${dir} is not inside a git repository — dev/reviewer stages need one for branches, worktrees, and PRs.`);
  return r.stdout.trim();
}

const repoDir = gitToplevel(resolve(flag("repo", process.cwd())));
const dataPath = resolve(flag("board", join(process.cwd(), "board", "data.json")));
const archivePath = resolve(flag("archive", join(dirname(dataPath), "archive.json")));
const configPath = resolve(flag("config", join(dirname(dirname(dataPath)), "config.json")));
const autoMerge = has("auto-merge");
const dryRun = has("dry-run");
const resume = has("resume");
const timeoutSeconds = Number(flag("timeout", "1800"));
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) die("--timeout must be a positive number of seconds.");
const timeoutMs = timeoutSeconds * 1000;
const reviewerGhToken = process.env.MAESTRO_REVIEWER_GH_TOKEN || null;

if (!existsSync(dataPath)) die(`Board file not found: ${dataPath}. Pass --board <path>.`);
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const archive = existsSync(archivePath) ? JSON.parse(readFileSync(archivePath, "utf8")) : { epics: [], tickets: [] };
const ticket = (data.tickets || []).find((t) => t.id === ticketId);
if (!ticket) die(`${ticketId} is not a live ticket on ${dataPath}.`);
const readVersion = boardVersion(dataPath);

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const crossReview = config?.crossReview ?? null;

const devRuntime = ticket.dev_runtime || crossReview?.dev?.runtime;
const devModel = ticket.dev_model || crossReview?.dev?.model || "sonnet";
const reviewerRuntime = ticket.reviewer_runtime || crossReview?.reviewer?.runtime;
const reviewerModel = ticket.reviewer_model || crossReview?.reviewer?.model || "sonnet";

if (!devRuntime || !reviewerRuntime) {
  die(`${ticketId} has no cross-review role set. 'maestro run' is only for cross-review-enabled ` +
    `tickets — set dev_runtime/reviewer_runtime on the ticket (the cockpit's Dev/Reviewer ` +
    `pickers) or add config.json's crossReview defaults. A ticket with neither still runs the ` +
    `classic way, inside an interactive claude/codex session working its agent_plan.`);
}
for (const [field, val] of [["dev_runtime", devRuntime], ["reviewer_runtime", reviewerRuntime]]) {
  if (!RUNTIME_ADAPTERS.has(val)) die(`${field} "${val}" has no installed adapter (supported: ${[...RUNTIME_ADAPTERS].join(", ")}).`);
  if (config?.targets?.[val] === false) die(`${field} "${val}" is disabled in config.targets.`);
}
for (const [field, val] of [["dev_model", devModel], ["reviewer_model", reviewerModel]]) {
  if (typeof val !== "string" || !val.trim()) die(`${field} must be a non-empty model id or portable tier.`);
}

const testCmd = ticket.testCmd || config?.orchestrator?.testCmd?.[ticket.area];
if (!testCmd || typeof testCmd !== "string" || !testCmd.trim()) {
  die(`${ticketId} has no test command. Set ticket.testCmd or config.orchestrator.testCmd.${ticket.area || "<area>"}; ` +
    `cross-review will not create or merge an unverified PR.`);
}

// ── Eligibility — the same gate the orchestrator itself applies, so this command can't start
//    work the rest of the kit wouldn't consider ready (blocked, human-gated, out of scope, or
//    already claimed). --resume is the only way around it, and only onto an existing PR.
const plan = (() => {
  try {
    const p = readPlanForBoard(dataPath);
    return planIsGating(p) ? p : null;
  } catch {
    return null;
  }
})();

if (resume) {
  if (!["in-progress", "review"].includes(ticket.status)) {
    die(`--resume needs ${ticketId} to be "in-progress" or "review" — it is "${ticket.status}".`);
  }
} else {
  const eligible = eligibleTickets(data, archive.tickets ?? [], plan ? { plan } : {}).some((t) => t.id === ticketId);
  if (!eligible) {
    const doneIds = new Set([
      ...(archive.tickets ?? []).map((t) => t.id),
      ...data.tickets.filter((t) => t.status === "done").map((t) => t.id),
    ]);
    const unmet = (ticket.depends_on || []).filter((d) => !doneIds.has(d));
    const reasons = [];
    if (ticket.status !== "todo") reasons.push(`status is "${ticket.status}", not "todo"`);
    if (ticket.human_gate) reasons.push(`human-gated ("${ticket.human_gate}")`);
    if (unmet.length) reasons.push(`depends on ${unmet.join(", ")}, not done yet`);
    if (plan && !reasons.length) reasons.push(`out of the plan's scope: ${scopeVerdict(ticket, plan).reason}`);
    die(`${ticketId} is not eligible to run right now — ${reasons.join("; ") || "see 'maestro validate' for why"}. ` +
      `Pass --resume if it's already in-progress/review and you want to pick up its existing PR.`);
  }
}

console.log(`${ticketId}: ${ticket.name || "(no name)"}`);
console.log(`  dev       ${devRuntime}/${devModel}`);
console.log(`  reviewer  ${reviewerRuntime}/${reviewerModel}`);
console.log(`  merge     ${autoMerge ? "automatic after approval + checks" : "manual — stops after approval"}`);
console.log(`  tests     ${testCmd}`);

// Board ids are labels, not filesystem paths. Keep the conventional spelling for normal ids,
// but collapse every path/ref-significant character so a malformed board cannot escape the
// dedicated worktree parent or manufacture extra branch path segments.
const ticketSegment = String(ticketId).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
const branchName = `feat/${ticketSegment}-${slugify(ticket.name)}`;
const worktreeDir = join(repoDir, "..", ".maestro-wt", ticketSegment);
console.log(`  branch    ${branchName}`);
console.log(`  worktree  ${resolve(worktreeDir)}`);

if (dryRun) {
  console.log("\n(dry run — nothing was executed; no board write, no worktree, no agent, no gh call)");
  process.exit(0);
}

function slugify(s) {
  return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "ticket";
}

function ensureBinary(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  if (r.error?.code === "ENOENT") die(`"${cmd}" was not found on PATH.`);
}
ensureBinary(devRuntime);
ensureBinary(reviewerRuntime);
ensureBinary("gh");
if (spawnSync("gh", ["auth", "status"], { cwd: repoDir, stdio: "ignore" }).status !== 0) {
  die("gh is not authenticated in this environment — run 'gh auth login' first.");
}
if (!reviewerGhToken) {
  die("Cross-review requires MAESTRO_REVIEWER_GH_TOKEN so the reviewer uses a GitHub identity other than the PR author.");
}

function setStatus(status, extra = []) {
  const r = spawnSync(NODE, [join(KIT_ROOT, "scripts", "board-write.mjs"), "set-status", ticketId, status, "--board", dataPath, ...extra],
    { stdio: "inherit", cwd: repoDir });
  if (r.status !== 0) die(`Could not move ${ticketId} to "${status}" (see above) — it is left wherever it last was.`);
}

/** The single open (or most recent) PR for a branch, found via gh — never trusted from an
 *  agent's own claim. Returns null if none exists yet. */
function findPr(branch) {
  const r = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "url,number,state"],
    { cwd: repoDir, encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout || "[]");
    return list.find((p) => p.state === "OPEN") || null;
  } catch {
    return null;
  }
}

function ghPrJson(prUrl, fields) {
  const r = spawnSync("gh", ["pr", "view", prUrl, "--json", fields], { cwd: repoDir, encoding: "utf8" });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The reviewer's verdict as GitHub itself recorded it (latest review's state), not as the
 *  reviewer agent claimed it — a claimed "approve" GitHub refused to record (e.g. self-review)
 *  reads as no verdict here, which the caller treats as a hard failure. */
function verifiedVerdict(prUrl, reviewerLogin, previousCount) {
  const info = ghPrJson(prUrl, "reviews");
  const reviews = (info?.reviews || []).filter((review) => review.author?.login === reviewerLogin);
  if (reviews.length <= previousCount) return null;
  const state = String(reviews[reviews.length - 1]?.state || "").toUpperCase();
  return { APPROVED: "approve", CHANGES_REQUESTED: "request-changes", COMMENTED: "comment" }[state] ?? null;
}

function ghLogin(env) {
  const r = spawnSync("gh", ["api", "user", "--jq", ".login"], { cwd: repoDir, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0 || !r.stdout.trim()) die("Could not resolve a GitHub login for one of the pipeline roles.");
  return r.stdout.trim();
}

function runTests(cwd) {
  console.log(`\n→ verification: ${testCmd}`);
  const r = spawnSync(testCmd, { cwd, shell: true, stdio: "inherit", timeout: timeoutMs });
  if (r.status !== 0) die(`Test command failed; ${ticketId} remains in-progress/review and will not merge.`);
}

/** A fresh worktree has the tracked code but none of the gitignored install output. Give it
 *  its own real `node_modules` (never a symlink to the main checkout's) — worktrees run
 *  concurrently, and a shared install directory means one ticket's `npm install` (e.g. adding
 *  a dependency) silently corrupts another ticket's environment mid-run. No-op for a worktree
 *  that isn't a JS/TS project. */
function installDeps(cwd) {
  if (!existsSync(join(cwd, "package.json"))) return;
  const hadLockfile = existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "pnpm-lock.yaml")) || existsSync(join(cwd, "yarn.lock"));
  const [cmd, args] = existsSync(join(cwd, "package-lock.json")) ? ["npm", ["ci"]]
    : existsSync(join(cwd, "pnpm-lock.yaml")) ? ["pnpm", ["install", "--frozen-lockfile"]]
    : existsSync(join(cwd, "yarn.lock")) ? ["yarn", ["install", "--frozen-lockfile"]]
    : ["npm", ["install"]];
  console.log(`\n→ installing dependencies in ${cwd} (${cmd} ${args.join(" ")})…`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", timeout: timeoutMs, shell: process.platform === "win32" });
  if (r.status !== 0) die(`"${cmd} ${args.join(" ")}" failed in ${cwd} (see above) — the worktree can't build or run tests.`);
  // A missing lockfile means `npm install` just generated one — commit it now so the worktree
  // starts clean; left uncommitted, it reads as dev-agent output and fails
  // assertCleanCommittedWorktree even though the agent never touched it.
  if (!hadLockfile && git(cwd, ["status", "--porcelain", "--", "package-lock.json"]).stdout.trim()) {
    git(cwd, ["add", "package-lock.json"]);
    git(cwd, ["commit", "-m", "chore: generate package-lock.json"], { stdio: "inherit" });
  }
}

function assertCleanCommittedWorktree(cwd, baseBranch) {
  const dirty = git(cwd, ["status", "--porcelain"]);
  if (dirty.status !== 0 || dirty.stdout.trim()) die(`Developer handoff left uncommitted files in ${cwd}; commit or revert them before review.`);
  const commits = git(cwd, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
  if (commits.status !== 0 || Number(commits.stdout.trim()) < 1) die("Developer handoff contains no committed change relative to the default branch.");
}

/** Run one agent stage headlessly in `cwd` and return its final response text. */
function runAgent(runtime, model, prompt, extraFlags, cwd, envOverride) {
  const cmd = runtime === "claude" ? "claude" : "codex";
  const codexModelArgs = CODEX_EFFORT[model]
    ? ["-c", `model_reasoning_effort=${CODEX_EFFORT[model]}`]
    : ["-m", model];
  const args = runtime === "claude"
    ? ["-p", prompt, "--model", model, ...extraFlags]
    : ["exec", prompt, ...codexModelArgs, ...extraFlags];
  const env = envOverride ? { ...process.env, ...envOverride } : process.env;
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"], env,
  });
  if (r.error) die(`Failed to run "${cmd}": ${r.error.message}`);
  if (r.signal === "SIGTERM") die(`${cmd} timed out after ${timeoutMs / 1000}s (--timeout to change it).`);
  if (r.status !== 0) die(`${cmd} exited ${r.status}. Its output:\n${r.stdout || "(none)"}`);
  return r.stdout || "";
}

function devPrompt() {
  return `You are the developer for AI Maestro ticket ${ticketId}: "${ticket.name || ""}".

Description:
${ticket.desc || "(none)"}

Area: ${ticket.area || "(unspecified)"}

You are already on branch "${branchName}" in an isolated worktree. Implement this ticket here.
When you are done:
1. Run the relevant checks, including this required command: ${testCmd}
2. Commit your work on this branch (do not create or switch to a different branch).
3. Do NOT push, open a pull request, or merge. The deterministic runner owns those actions.`;
}

function reviewerPrompt(prUrl) {
  return `You are the independent reviewer for AI Maestro ticket ${ticketId}: "${ticket.name || ""}", reviewing pull request ${prUrl}.

Description / acceptance criteria:
${ticket.desc || "(none)"}

You are a read-only reviewer. Do not edit, format, commit, push, switch branches, or merge.
Review the PR's diff against the ticket using git and gh. Then take exactly ONE of these real
GitHub actions yourself:
  - Defects found:            gh pr review ${prUrl} --request-changes -b "<specific defects>"
  - Acceptable, but you want a human to look before it lands: gh pr review ${prUrl} --comment -b "<notes>"
  - Meets the ticket and is safe to land: gh pr review ${prUrl} --approve -b "<summary>"

Do NOT run \`gh pr merge\` yourself under any circumstances — merging is a separate, gated
step regardless of your verdict.`;
}

// ── Dev stage (skipped on --resume when a PR already exists) ──────────────────────────────
let prUrl = resume ? findPr(branchName)?.url : null;
let defaultBranch = "";

const fetch = git(repoDir, ["fetch", "origin"], { stdio: "inherit" });
if (fetch.status !== 0) die("git fetch origin failed; refusing to start from an unknown base.");
git(repoDir, ["remote", "set-head", "origin", "-a"]);
const remoteHead = git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
if (remoteHead.status !== 0) die(`Could not resolve origin/HEAD in ${repoDir} — does it have a remote?`);
defaultBranch = remoteHead.stdout.trim().replace(/^origin\//, "");

if (!prUrl) {
  if (resume) die(`--resume was passed but no PR was found for branch "${branchName}" — nothing to pick up. Run without --resume once the ticket is eligible again, or open the PR by hand.`);

  if (existsSync(worktreeDir)) {
    die(`${resolve(worktreeDir)} already exists — a previous run may be in progress or was left ` +
      `uncleaned. Inspect it (git -C ${repoDir} worktree list) and remove it yourself before retrying.`);
  }

  console.log(`\n→ dev stage (${devRuntime}/${devModel})…`);
  setStatus("in-progress", ["--expect-version", readVersion]);

  mkdirSync(dirname(worktreeDir), { recursive: true });
  const wt = git(repoDir, ["worktree", "add", worktreeDir, "-b", branchName, `origin/${defaultBranch}`], { stdio: "inherit" });
  if (wt.status !== 0) die(`git worktree add failed (see above) — ${ticketId} is left "in-progress".`);
  installDeps(worktreeDir);

  runAgent(devRuntime, devModel, devPrompt(), flagAll(devRuntime === "claude" ? "claude-flag" : "codex-flag"), worktreeDir);

  assertCleanCommittedWorktree(worktreeDir, defaultBranch);
  runTests(worktreeDir);
  const push = git(worktreeDir, ["push", "-u", "origin", branchName], { stdio: "inherit" });
  if (push.status !== 0) die(`Could not push ${branchName}; ${ticketId} remains in-progress.`);
  const create = spawnSync("gh", ["pr", "create", "--head", branchName,
    "--title", `${ticket.name || ticketId} (${ticketId})`,
    "--body", `AI Maestro cross-review delivery for ${ticketId}.\n\nTest: ${testCmd}`],
    { cwd: worktreeDir, stdio: "inherit" });
  if (create.status !== 0 && !findPr(branchName)) die(`Could not create a PR for ${branchName}.`);

  const pr = findPr(branchName);
  if (!pr) {
    die(`Dev stage finished but no PR was found for branch "${branchName}" (checked via gh pr list) — ` +
      `${ticketId} is left "in-progress"; the worktree at ${resolve(worktreeDir)} is left for you to inspect.`);
  }
  prUrl = pr.url;
  console.log(`  PR: ${prUrl} (verified via gh pr list)`);
  setStatus("review");
} else {
  console.log(`\n→ resuming from existing PR: ${prUrl}`);
  if (!existsSync(worktreeDir)) {
    console.log(`  (worktree missing locally — recreating it checked out on ${branchName})`);
    git(repoDir, ["fetch", "origin", branchName]);
    const wt = git(repoDir, ["worktree", "add", worktreeDir, branchName], { stdio: "inherit" });
    if (wt.status !== 0) die(`Could not recreate the worktree for ${branchName} (see above).`);
    installDeps(worktreeDir);
  }
  const clean = git(worktreeDir, ["status", "--porcelain"]);
  if (clean.status !== 0 || clean.stdout.trim()) {
    die(`The resumed worktree at ${resolve(worktreeDir)} has uncommitted changes; refusing to overwrite or review them.`);
  }
  const fastForward = git(worktreeDir, ["merge", "--ff-only", `origin/${branchName}`], { stdio: "inherit" });
  if (fastForward.status !== 0) die(`Could not fast-forward the resumed worktree to origin/${branchName}.`);
  const localHead = git(worktreeDir, ["rev-parse", "HEAD"]).stdout.trim();
  const remoteHead = git(worktreeDir, ["rev-parse", `origin/${branchName}`]).stdout.trim();
  if (!localHead || localHead !== remoteHead) {
    die(`The resumed worktree does not match origin/${branchName}; refusing to review or test stale code.`);
  }
  if (ticket.status !== "review") setStatus("review");
}

// ── Reviewer stage ──────────────────────────────────────────────────────────────────────────
console.log(`\n→ reviewer stage (${reviewerRuntime}/${reviewerModel})…`);
const reviewerEnv = reviewerGhToken ? { GH_TOKEN: reviewerGhToken, GITHUB_TOKEN: reviewerGhToken } : undefined;
const devLogin = ghLogin();
const reviewerLogin = ghLogin(reviewerEnv);
if (reviewerLogin === devLogin) {
  die(`Developer and reviewer resolve to the same GitHub account (${devLogin}). Supply a distinct reviewer token; GitHub cannot record an independent approval from the PR author.`);
}
const priorReviewerReviews = (ghPrJson(prUrl, "reviews")?.reviews || [])
  .filter((review) => review.author?.login === reviewerLogin).length;
const reviewerHeadBefore = git(worktreeDir, ["rev-parse", "HEAD"]).stdout.trim();
const reviewerStatusBefore = git(worktreeDir, ["status", "--porcelain"]).stdout;
runAgent(reviewerRuntime, reviewerModel, reviewerPrompt(prUrl), flagAll(reviewerRuntime === "claude" ? "claude-flag" : "codex-flag"), worktreeDir, reviewerEnv);
const reviewerHeadAfter = git(worktreeDir, ["rev-parse", "HEAD"]).stdout.trim();
const reviewerStatusAfter = git(worktreeDir, ["status", "--porcelain"]).stdout;
if (reviewerHeadAfter !== reviewerHeadBefore || reviewerStatusAfter !== reviewerStatusBefore) {
  die("Reviewer mutated the worktree; its verdict is rejected and the PR remains unmerged for inspection.");
}

const verdict = verifiedVerdict(prUrl, reviewerLogin, priorReviewerReviews);
if (!verdict) {
  die(`No matching review action was found on ${prUrl}'s own history after the reviewer stage ran — ` +
    `possibly blocked by GitHub (e.g. self-review) or the reviewer didn't actually call \`gh pr review\`. ` +
    `${ticketId} stays "review" with an unresolved PR for you to check by hand.`);
}
console.log(`  verdict (verified from GitHub): ${verdict}`);

if (verdict === "request-changes") {
  const reviewerReviews = (ghPrJson(prUrl, "reviews")?.reviews || [])
    .filter((review) => review.author?.login === reviewerLogin);
  const notes = reviewerReviews[reviewerReviews.length - 1]?.body || "(no review body)";
  const r = spawnSync(NODE, [join(KIT_ROOT, "scripts", "board-write.mjs"), "block", ticketId,
    "--name", `Review requested changes on ${ticketId}`, "--desc", `${notes}\n\nPR: ${prUrl}`,
    "--board", dataPath], { stdio: "inherit", cwd: repoDir });
  if (r.status !== 0) die(`Reviewer requested changes on ${prUrl}, but filing the blocker failed (see above).`);
  console.log(`\n${ticketId} blocked; a blocker ticket was filed with the reviewer's notes. Worktree left at ${resolve(worktreeDir)} for the next dev pass.`);
} else if (verdict === "comment") {
  console.log(`\n${ticketId} stays "review" — the reviewer commented on ${prUrl} without a verdict. Nothing else to do.`);
} else if (autoMerge) {
  runTests(worktreeDir);
  const initialChecks = ghPrJson(prUrl, "statusCheckRollup")?.statusCheckRollup || [];
  if (initialChecks.length) {
    const checks = spawnSync("gh", ["pr", "checks", prUrl, "--watch", "--fail-fast"], { stdio: "inherit", cwd: repoDir });
    if (checks.status !== 0) die(`Required PR checks failed on ${prUrl}; refusing to merge.`);
  }
  const merge = spawnSync("gh", ["pr", "merge", prUrl, "--squash"], { stdio: "inherit", cwd: repoDir });
  if (merge.status !== 0) {
    die(`Reviewer approved ${prUrl}, but \`gh pr merge\` failed (see above) — ${ticketId} is left "review" with an approved, unmerged PR.`);
  }
  const merged = ghPrJson(prUrl, "state,mergeCommit");
  if (merged?.state !== "MERGED" || !merged.mergeCommit?.oid) {
    die(`gh returned success but ${prUrl} is not confirmed MERGED; refusing to archive ${ticketId}.`);
  }
  const archiveResult = spawnSync(NODE, [join(KIT_ROOT, "scripts", "board-write.mjs"), "archive", ticketId,
    "--evidence", `Approved by ${reviewerLogin}; merged ${merged.mergeCommit.oid}: ${prUrl}; tests: ${testCmd}`,
    "--board", dataPath], { stdio: "inherit", cwd: repoDir });
  if (archiveResult.status !== 0) die(`${prUrl} merged, but archiving ${ticketId} failed (see above) — do it by hand.`);
  git(repoDir, ["worktree", "remove", worktreeDir], { stdio: "inherit" });
  git(repoDir, ["branch", "-d", branchName], { stdio: "inherit" });
  console.log(`\n${ticketId} merged, archived, and its worktree cleaned up.`);
} else {
  console.log(`\nApproved: ${prUrl}\n${ticketId} stays "review" — merge it yourself, then archive the ticket and clean up:` +
    `\n  gh pr merge ${prUrl} --squash` +
    `\n  node ${join(KIT_ROOT, "scripts", "board-write.mjs")} archive ${ticketId} --evidence "<...>" --board ${dataPath}` +
    `\n  git -C ${repoDir} worktree remove ${worktreeDir} && git -C ${repoDir} branch -d ${branchName}`);
}
