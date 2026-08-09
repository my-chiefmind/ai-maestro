---
name: "repo-audit"
description: "Audit ONE repo — security findings, gaps, and a ranked improvement plan — written to a report file under the board. Takes a project name or path, `next` (walk the queue one repo at a time), or `status` (show sweep progress). Use when asked for a security review, gap analysis, or improvement report for a specific repo, including via /repo-audit."
---

# Repo Audit (entry point)

Runs the **`repo-audit`** agent against **exactly one repository** and reports back.

## Arguments

| Arg | Meaning |
| --- | --- |
| *(project name or path)* | Audit that repo — e.g. `/repo-audit my-app`, `/repo-audit ~/code/other` |
| `next` | Read the index, pick the first repo not yet audited (or stale > 30 days), audit it |
| `status` | Read the index and show sweep progress — **no agent run** |
| *(nothing)* | Show the queue and ask which repo to audit |

## The queue

There is no hardcoded list. Candidates come from, in order:

1. **The project registry** — `maestro-registry.json`, if this project has one. Entries are
   candidates in file order. Entries with `status: parked` are **excluded** unless the user names
   one explicitly; that is what parked means. See
   [`schemas/maestro-registry.schema.json`]({{KIT}}/schemas/maestro-registry.schema.json).
2. **No registry** — the current repository is the only candidate.

`status: parked` and `kind: ops` are both worth surfacing when you show the queue: an ops repo is
portfolio tooling, so its board-drift section will legitimately be thin.

## Procedure

1. Resolve the argument to **exactly one** repo. If it matches nothing, or more than one, **ask —
   do not guess.**
2. Launch the agent via the Agent tool with `subagent_type: "repo-audit"`, passing the resolved
   repo path and any extra focus the user gave (e.g. "focus on the upload path"). Run it in the
   foreground so you can relay the result.
3. When it returns, relay: the verdict line, severity counts, the top 3 improvements, and the
   **report file path** as a clickable link.
4. State the next repo in the queue, so the user can run `/repo-audit next`.

## Rules

- **One repo per invocation, always.** If asked to "audit everything", run the first repo,
  deliver its report, and say where that leaves the queue. Do not fan out parallel agents across
  repos — these reports are meant to be read and acted on one at a time, and a batch of them
  reliably goes unread.
- The agent is **read-only against code**. Its only writes are the report file under
  `{{BOARD}}/reports/` and `{{BOARD}}/reports/repo-audit-INDEX.md`.
- Suggested tickets in a report are **proposals**. Do not write them to any board unless the user
  asks — the audit's job is to inform the board, not to file into it.
- Never let an audit reach production, and never surface a secret's value when relaying findings
  — name the kind and the location, and say *rotate*.
