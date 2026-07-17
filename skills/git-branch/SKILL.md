---
name: "git-branch"
description: "Branch conventions for ticket work. Use when starting a ticket to create a correctly named branch off an up-to-date main, and to decide when to branch versus commit directly. Keeps main clean and branches traceable to tickets."
---

# Git Branch

Every ticket gets its own branch, named so anyone can trace it back to the ticket.

## Naming

```
<type>/<ticket-id>-<short-slug>

feat/T-014-rate-limit-api
fix/T-021-null-session-crash
chore/T-008-bump-deps
docs/T-030-getting-started
```

- `type` ∈ `feat` / `fix` / `chore` / `docs` / `refactor` / `infra`.
- Always include the **ticket id** — it's the link between the branch, the board, and the PR.
- Lowercase, hyphenated slug; keep it short.

## Starting a branch

1. **Never work on `main` directly.** If you find yourself on `main` with changes, branch
   first (see below), then continue.
2. Branch from an **up-to-date** `main`:
   ```bash
   git fetch origin
   git switch -c feat/T-014-rate-limit-api origin/main
   ```
   (Under the orchestrator this happens inside a fresh worktree — see the `worktree-cleanup`
   skill.)
3. If a protected `main` disallows direct pushes, that's expected: push the branch and open a
   PR.

## Committing

- Commit messages: imperative subject, reference the ticket id (`T-014: add token-bucket
  limiter`). Keep the body to *why*, not *what* the diff already shows.
- Keep each commit coherent. Don't fold unrelated changes into a ticket's branch — that's a
  separate ticket.
- **Only commit or push when the work is asked to land** — not reflexively after every edit.

## Before pushing

- Rebase onto the latest `main` if it moved (`git fetch && git rebase origin/main`), resolve
  conflicts locally, and re-run the release gate before you push the resolution.
