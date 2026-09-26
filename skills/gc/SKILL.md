---
name: "gc"
description: "Git catch-up — bring a stale local checkout in sync with the remote before trusting it. Use before claiming code is missing/unmerged, before starting a ticket, or when a report looks wrong: fetch, compare against origin, and reconcile."
---

# gc — Git Catch-Up

Local checkouts drift behind the remote. **Never claim something is missing, unmerged, or
stale from a checkout you haven't synced.** Fetch first, then judge.

## The routine

1. **Fetch everything:**
   ```bash
   git fetch --all --prune
   ```
2. **See where you stand** vs. the remote default branch:
   ```bash
   git status -sb                    # ahead/behind for the current branch
   git log --oneline origin/main -5  # what's actually on the remote
   ```
3. **Reconcile:**
   - Behind, clean tree → `git pull --ff-only` (or rebase your branch onto `origin/main`).
   - Local changes → stash or commit to your ticket branch first, then update.
   - "Missing" code → check `origin/main` and other branches before concluding it's gone; it
     usually landed on a branch your checkout hadn't fetched.
4. **Prune what's dead:** deleted-on-remote branches are cleaned by `--prune`; drop merged
   local branches (see `worktree-cleanup`).

## Why this is a discipline, not a nicety

A checkout that's a few commits behind will confidently report already-merged work as
"unmerged" and already-fixed bugs as "still broken." Audits, status reports, and "is this
done?" answers must be made **against the remote**, not against a stale local `main`. When in
doubt: `git fetch` before you assert.
