---
name: "dev-report"
description: "Read-only status snapshot of the work: every repo and worktree's branches, ahead/behind, and uncommitted changes, correlated against the board so each ticket reads as landed, in flight, stale, or unstarted. Use to answer \"where are we?\" — before starting a run, after a batch of tickets, or when the board and the git history disagree."
---

# Dev Report

Answers one question: **what is the actual state of the work right now?** It reads git and the
board, correlates them, and reports. It changes nothing — the only state-touching command it
may run is `git fetch`.

This is the *status* skill. It is not the others:

| Question | Skill |
| --- | --- |
| Where are we? | **this one** |
| Is the orchestration state broken? | `orchestration-health` |
| Is my checkout stale? | `gc` |
| Can I delete this worktree/branch? | `worktree-cleanup` |

Don't re-derive their checks here — point at them. A report that quietly disagrees with
`orchestration-health` is worse than no report.

## Before you report

**Fetch first.** A checkout a few commits behind will confidently call already-merged work
"unmerged" and archived tickets "in flight" — the whole report inverts. Run the `gc` skill's
fetch step, or at minimum `git fetch --all --prune` per repo, before judging anything. If a
fetch fails (no remote, offline), say so in the report and mark that repo's ahead/behind
**unknown** — never guess a count.

## 1. Find the repos

The default scope is the project repo plus its ticket worktrees:

- The repo containing the board.
- Every worktree under `../.maestro-wt/*` (`git worktree list`).

For a workspace of sibling repos, read the project's `config.json` (next to the board, at
`{{BOARD}}/../config.json`): if it has a `repos` array of paths, sweep those too.

```json
"repos": ["../service-api", "../web-app"]
```

Never assume a path is a repo — verify with `git -C <path> rev-parse --is-inside-work-tree`
and skip cleanly if it isn't. Report an expected repo that's missing rather than dropping it
silently.

## 2. Gather per repo (read-only)

- Current branch and HEAD sha — `git -C <p> branch --show-current`; flag a detached HEAD.
- Worktrees — `git -C <p> worktree list`.
- Working tree — `git -C <p> status --porcelain=v1 -b` (staged / unstaged / untracked counts,
  upstream tracking line). Counts only; never paste diffs.
- Ahead/behind vs the default branch. Resolve it, don't hardcode `main`:
  ```bash
  default_branch=$(git -C <p> symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')
  git -C <p> rev-list --left-right --count "origin/$default_branch...<branch>"
  ```
- Recent commits — `git -C <p> log --oneline -10` on the current branch.
- Merged and stale branches — `git -C <p> branch --merged "origin/$default_branch"`, plus each
  branch's last-commit date.

## 3. Correlate with the board

Read `{{BOARD}}/data.json` (active) and `{{BOARD}}/archive.json` (landed). Ticket ids show up
in branch names and commit subjects — that's the join key. Match on the id, not on prose.

Place each ticket in exactly one bucket, and prefer git over the board when they disagree:

| Bucket | Evidence |
| --- | --- |
| **Landed** | in `archive.json`, or its commits are merged into the default branch |
| **In flight** | unmerged branch or live worktree with commits |
| **In progress** | uncommitted changes in a worktree |
| **Claimed but empty** | `in-progress` on the board with no branch and no worktree |
| **Unstarted** | on the board, no git trace |

The last bucket is the one worth surfacing loudly — it's a claim nothing is behind, and it
blocks the ticket from ever being picked up again. Report it and hand the diagnosis to
`orchestration-health`; don't fix it here.

If the board files are missing or unparseable, say so and produce the git-only report — the
per-repo half still stands on its own.

## Output

Terse markdown, scanned rather than read. Lead with the two sections that get acted on.

```
# Dev Report

## TL;DR
- 2–5 bullets: what's moving, what just landed, what needs a decision.

## Needs attention
- Claimed but empty: <ticket> (in-progress, no branch/worktree) → run orchestration-health
- Merged branches safe to delete: <branch> (repo) → worktree-cleanup
- Dirty trees, detached HEADs, branches behind the default, missing repos, fetch failures

## Per repo
### <repo>  (branch: <b> @ <sha>, clean | N changed)
- vs origin/<default>: ahead X / behind Y
- Worktrees: <ticket-id> → <branch> (N commits, last <date>)
- Unmerged branches: <branch> → <ticket> <bucket>
- Recent: <3 commit subjects>

## Board
- Landed: <ids>   In flight: <id → branch>   In progress: <id → repo>
- Blocked / gated: <id> — <blocker or gate>
```

## Rules

- **Read-only, always.** No edits, commits, branch switches, pushes, or board writes. State
  fixes as recommendations naming the skill that performs them — never run them.
- **Accurate over complete.** A failed command means **unknown**, printed as unknown. A
  confidently wrong status report is worse than a short one.
- **No dumps.** Commit subjects and changed-file counts, not logs and diffs.
