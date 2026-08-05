---
name: "worktree-cleanup"
description: "Create and tear down per-ticket git worktrees. Use to run a ticket in isolation off main, and to reliably clean up the worktree and branch after it lands or is abandoned — so parallel work never collides and stale worktrees don't accumulate."
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

**After a ticket lands** (merged):

```bash
git worktree remove ../.maestro-wt/T-014        # removes the worktree dir
git branch -d feat/T-014-rate-limit-api          # delete the merged local branch
git push origin --delete feat/T-014-rate-limit-api   # if it was pushed
```

**When a ticket is abandoned** (branch never merged): same, but use `git worktree remove
--force` and `git branch -D` since the branch has unmerged commits you're intentionally
dropping. Confirm you're discarding the right branch first — read what's on it, don't
force-remove blind.

## Hygiene

- **List and prune regularly:**
  ```bash
  git worktree list          # see everything checked out
  git worktree prune         # drop administrative entries for deleted dirs
  ```
- A worktree that's been idle across many tickets is a smell — either it's live work that
  should be on the board, or it's abandoned and should be removed.
- Keep worktrees under one predictable parent dir (e.g. `../.maestro-wt/`) so they're easy to
  find and never accidentally committed into the repo.
- Never remove a worktree with **uncommitted work you didn't create** — inspect it first; it
  may be another session's in-flight ticket.
