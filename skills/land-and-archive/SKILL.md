---
name: "land-and-archive"
description: "The land step for a finished ticket: merge the branch, record evidence, move the ticket from data.json to archive.json, and clean up the worktree. Use when a ticket has passed its gates and is ready to become real."
---

# Land and Archive

The closing ritual for a ticket. Run it only after the release gate is green and any human
gate is cleared.

## Steps

1. **Confirm the gate.** Tests green, QA passed, evidence in hand. Don't land on a red or
   unverified gate (see the `release-gate` skill).
2. **Land the branch.**
   - Fast path (your own repo, non-protected `main`): merge (squash for a clean history if
     that's the project convention), then push.
   - Protected `main`: push the branch, open a PR, merge once checks are green. Merge with
     admin override **only** where the project explicitly allows it and local gates are green.
   - Rebase onto the latest `main` first if it moved; resolve conflicts and re-run the gate
     **before** the final push — never force-push over an unresolved conflict.
3. **Capture evidence** on the ticket: the merge commit SHA and the test result. This is what
   `archive.json` preserves.
4. **Archive the ticket.** Move it from `{{BOARD}}/data.json` to `{{BOARD}}/archive.json` with its
   `evidence`, and set `status: done`. `data.json` should only ever show live work.
5. **Clean up** the worktree and branch (see the `worktree-cleanup` skill).
6. **Unblock dependents.** Any ticket whose `depends_on` is now fully `done` becomes eligible
   — the next orchestrator run will see it.

## Do it promptly

Land finished work when it's finished — don't let merged-in-spirit branches linger unmerged
or done tickets sit unarchived. A stale branch diverges from `main`; an unarchived done
ticket lies about the board's state.
