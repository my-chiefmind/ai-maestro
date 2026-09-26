---
name: "worktree-cleanup"
description: "Create and tear down git worktrees for tickets and lanes. Use to run a ticket in isolation off the default branch, and to clean up after it lands or is abandoned — removing a per-ticket worktree, but keeping a lane worktree and deleting only the merged ticket branch."
---

# Worktree Cleanup

Each ticket runs in its own git worktree so parallel tickets never collide and a bad branch
never dirties your main checkout. This skill covers both ends: create, and clean up.

## Create a worktree for a ticket

Resolve the default branch — don't hardcode `origin/main`; plenty of repos default to
`master` (or something else) and a hardcoded ref fails on them:

```bash
git fetch origin
git remote set-head origin -a   # in case the clone skipped setting origin/HEAD
default_branch=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')
git worktree add ../.maestro-wt/T-014 -b feat/T-014-rate-limit-api "origin/$default_branch"
```

**Bring its dependencies with it.** A fresh worktree has the tracked code but none of the
gitignored install output (`node_modules`, `.venv`, vendor caches) — nothing installs it
automatically, and a ticket dispatched into a worktree that can't build or run tests is a
wasted run. Before dispatching work:

- **Fast path:** if the main checkout already has a good, up-to-date install, link it in
  rather than reinstalling from scratch:
  ```bash
  ln -s /absolute/path/to/main/checkout/node_modules node_modules
  ```
  (or the language equivalent: a `.venv` symlink, a shared package-manager cache, …).
- **Otherwise:** run the `dev-setup` skill's install step inside the new worktree first.

Run the ticket's `agent_plan` inside `../.maestro-wt/T-014/`. The main checkout stays clean.

## Clean up after landing or abandoning

**After a ticket lands** (merged) — **only when the worktree is not a lane** (see
[Lanes](#lanes-a-worktree-that-outlives-its-ticket) below):

```bash
git worktree remove ../.maestro-wt/T-014        # removes the worktree dir
git branch -d feat/T-014-rate-limit-api          # delete the merged local branch
git push origin --delete feat/T-014-rate-limit-api   # if it was pushed
```

**When a ticket is abandoned** (branch never merged): same, but use `git worktree remove
--force` and `git branch -D` since the branch has unmerged commits you're intentionally
dropping. Confirm you're discarding the right branch first — read what's on it, don't
force-remove blind.

## Lanes: a worktree that outlives its ticket

With `orchestration.maxWorktrees` set, work runs in **lanes** (see `maestro lanes` and the
`swarm` skill). A lane is a persistent worktree that runs a *queue* of tickets one at a time,
landing each before starting the next. The worktree belongs to the lane, not to any one ticket,
so the per-ticket teardown above would delete live work for the tickets still queued behind it.

The kit fixes no directory name for a lane worktree, so identify it by what it has checked out,
not by its path:

```bash
git worktree list --porcelain   # each entry's `worktree` path and its `branch`
```

A worktree is a lane when the lane plan (`maestro lanes`) or the running swarm still has
tickets queued on it. When in doubt, treat it as a lane and leave it in place.

**After a lane's ticket lands:**

1. **Keep the worktree.** Don't `git worktree remove` it.
2. **Delete only the merged ticket branch**, locally and on the remote:
   ```bash
   git branch -d feat/T-014-rate-limit-api
   git push origin --delete feat/T-014-rate-limit-api   # if it was pushed
   ```
   `git branch -d` refuses a branch that is still checked out, so first move the lane onto the
   next ticket (step 3) or detach it (`git -C <lane-worktree> switch --detach`).
3. **Re-base the lane for its next ticket** by branching fresh off the updated default branch
   inside the same worktree (resolve `default_branch` as above):
   ```bash
   git -C <lane-worktree> fetch origin
   git -C <lane-worktree> switch -c feat/T-015-next-ticket "origin/$default_branch"
   ```
   Refresh dependencies there if the lockfile changed (see "Bring its dependencies with it").

Remove a lane's worktree only when the lane itself is retired — its queue is empty and nothing
will be scheduled onto it — and then only after the checks in "Hygiene" below.

## Hygiene

- **List and prune regularly:**
  ```bash
  git worktree list          # see everything checked out
  git worktree prune         # drop administrative entries for deleted dirs
  ```
- A per-ticket worktree that's been idle across many tickets is a smell — either it's live
  work that should be on the board, or it's abandoned and should be removed. A lane worktree
  that has hosted many tickets is normal; judge it by its current branch, not its age.
- Keep worktrees under one predictable parent dir (e.g. `../.maestro-wt/`) so they're easy to
  find and never accidentally committed into the repo.
- Never remove a worktree with **uncommitted work you didn't create** — inspect it first; it
  may be another session's in-flight ticket.
