---
name: "atomic-report"
description: "Read-only atomic bullet-point status snapshot: what landed in the last 24h, every open/in-progress ticket, the next eligible tickets in the queue, and every open branch/worktree. Use for /atomic-report or a quick daily status check — terser than dev-report, scanned in ten seconds."
---

# Atomic Report

A one-line-per-fact status snapshot scoped to **right now**: what happened recently, what's
open, what's next, and what git state is lying around. Every bullet must trace back to a git
or board command — no narrative, no synthesis, no speculation.

This is not `dev-report` — `dev-report` is the full narrative status, correlated against the
board section by section. This is the terse, disposable version. Don't reproduce
`dev-report`'s full correlation logic here; if the user wants that depth, point them at
`/dev-report` instead of expanding this one.

## Before reporting

Fetch first — same discipline as `gc`: `git fetch --all --prune`. A stale checkout inverts
every bucket below. If the fetch fails (no remote, offline), say "fetch failed — report may be
stale" and continue rather than guessing.

## 1. Last 24 hours

`git log --oneline --since="24 hours ago" --all` on the repo, plus any ticket worktrees
(`git worktree list`, under `../.maestro-wt/*` if present). One bullet per commit: sha,
subject, branch. Where a commit sha matches a `{{BOARD}}/archive.json` entry, collapse that
ticket's whole commit sequence into a single "landed" bullet (`T-0NN landed — <name>`) instead
of listing each commit separately.

If nothing landed in the last 24h, say so plainly — don't pad the section with older commits.

## 2. Open / in-progress

From `{{BOARD}}/data.json`: every ticket with an in-progress/claimed status, one bullet each —
id, name, and its evidence (branch/worktree if one exists, or "claimed, no branch" if not —
the same "claimed but empty" finding `dev-report` flags; flag it the same way here).

## 3. Next up

From `{{BOARD}}/data.json`: backlog tickets whose `depends_on` are all satisfied (landed, or in
`archive.json`) — the next eligible tickets in board order, capped at 5. One bullet each: id,
name, priority. If nothing is eligible, say so and name the blocker (e.g. "all backlog blocked
on T-0NN").

## 4. Branches & worktrees

- `git worktree list` — one bullet per worktree: path, branch, ticket id if the branch name
  encodes one.
- `git branch -a --no-merged origin/<default>` — one bullet per unmerged branch not already
  covered above.
- Flag anything merged-but-not-deleted as a candidate for `worktree-cleanup`.

## Output

Flat bullets under the four headers above, nothing else — no summary paragraph, no
recommendations beyond naming the skill that would act on a finding (`worktree-cleanup`,
`orchestration-health`, `gc`). If a section is empty, write "none" — don't omit the header.

```
# Atomic Report

## Last 24h
- <sha> <subject> (<branch>)
- T-0NN landed — <name>
- none

## Open / in-progress
- T-0NN <name> — <branch or "claimed, no branch">

## Next up
- T-0NN <name> (<priority>)

## Branches & worktrees
- <path> → <branch> (T-0NN)
- <branch> — unmerged, no worktree
```

## Rules

- **Read-only, always.** No edits, commits, pushes, or board writes.
- **One fact per bullet.** If a line needs "and", split it into two bullets.
- **Unknown beats guessed.** A failed git command is reported as unknown, not silently skipped
  or omitted.
