---
name: "delivery-tpm"
description: "Run delivery control for the current Maestro project, ticket, swarm, or messy worktree. Reconciles board and repository evidence into a proceed/block decision; does not implement, merge, deploy, or silently clean up work."
---

# Delivery TPM

Use this skill to establish the delivery truth for the current project or a named ticket.
It is a control and recovery entry point: it turns real board, branch, PR, worktree, and gate
evidence into one next action. It is not an implementation, QA, merge, deployment, or
status-narration workflow.

## Choose the scope

- **Named ticket** — assess that ticket before it starts, resumes, or proceeds through a gate.
- **Current board** — assess active work, blockers, drift, and the one next eligible ticket.
- **Swarm** — assess pool readiness at startup/recovery or when capacity, lanes, or merges are
  contended. Use the `swarm` skill for continuous dispatch; this skill supplies the
  proceed/hold decision.
- **Messy worktree or branch** — assess ownership and safe recovery. Preserve all work; do not
  delete, recreate, or dispatch replacement work while ownership is unresolved.

## Gather evidence before deciding

1. Run the `board-validate` and `orchestration-health` skills. Read
   `{{BOARD}}/data.json` and `{{BOARD}}/archive.json`; use the project’s supported board CLI
   for any authorized mutation, never a hand edit.
2. Inspect the relevant repository state: primary checkout status, active worktrees and their
   branches, commits relative to the default branch, open/merged pull requests, and current
   test/QA/delivery evidence. Record unknown facts as `unknown`, not as complete.
3. For a ticket, confirm it is neither deferred, duplicated, already delivered, nor externally
   blocked; its dependencies are complete; its acceptance criteria are measurable; and it has
   one expected delivery PR and verification command.
4. For swarm, run `maestro swarm status --json` and `maestro lanes next --board
   {{BOARD}}/data.json --json`. Do not start lanes here. A board error, unexplained claim,
   ownership conflict, or invalid lane schedule is a hold condition.

## Decide the smallest safe outcome

Return exactly one outcome per affected ticket:

- **Proceed** — the ticket is ready for its named next stage. State that stage.
- **Resume** — an owned `in-progress` ticket has a coherent worktree/branch and a concrete
  next stage.
- **Finish landing** — the change merged but its archive/evidence/board reconciliation remains.
- **Blocked** — give the reproducible failed command, unmet dependency, unavailable authority,
  credential/environment, or ownership conflict; name who can remove it and the smallest next
  action.
- **Owner decision required** — a deferred, inactive, or blocked ticket has live work. Preserve
  it and ask the owner to choose resume, archive, or cleanup.

For a healthy swarm, return one pool-wide **Proceed** and only list its startable lanes. Invoke
this skill again only when there is drift, stale work, merge contention, a recovery event, or
new evidence that changes readiness. Do not consume a TPM slot for every healthy lane.

## Handoff and boundaries

- A `Proceed` hands a ticket to the orchestrator or the swarm coordinator. For an explicit
  ticket checkpoint, use `"agent_plan": ["tpm", "pe", "backend"]` (substitute the real
  implementation role).
- QA independently reviews implementation. Principal Delivery makes the final land/no-land
  decision. TPM never replaces either role.
- Do not create separate tickets for minor findings or reminders. Keep in-scope repairs with
  the current ticket. Only a genuinely independent release boundary, owner, or shared
  prerequisite warrants a new ticket.
- Stop agent work for an external blocker. Never create speculative code or documentation-only
  work around a missing approval, credential, deployment authority, or real-user test.

## Report

Lead with a qualitative project judgment based only on the evidence gathered:

- **Healthy** — the board matches repository state, active work has a coherent next stage, and
  no current blocker prevents the eligible delivery flow.
- **At risk** — delivery can continue, but drift, an aging gate/branch, unresolved evidence, or
  constrained capacity needs a named next action.
- **Blocked** — an external prerequisite, invalid schedule, ownership conflict, failed gate, or
  missing authority stops the affected delivery flow.

Then return this table. Use short bullet fragments inside cells when more than one fact is
needed; write `—` when there is none. Never manufacture a row or a percentage merely to make
the report look complete.

| Scope | Done / evidence | Missing | Blocker / owner | Next |
| --- | --- | --- | --- | --- |
| Project judgment — <Healthy / At risk / Blocked> | <facts supporting the judgment> | <unmet delivery gates or unknowns> | <concrete issue and owner, or —> | <one highest-leverage action> |
| Active ticket — <ID, title, stage> | <completed acceptance criteria, revision, checks> | <specific remaining criterion or gate> | <exact blocker and owner, or —> | <one next stage/action> |
| Other affected ticket / lane — <ID> | <evidence, or —> | <what it needs> | <blocker and owner, or —> | <next action> |

After the table, include `Drift or risk:` only when board, branch, worktree, QA, PR, or merge
state disagrees. State the evidence and remediation; otherwise say `Drift or risk: none`.

Do not say “almost done” or infer completion from a branch or PR alone. A project judgment is
not a release declaration: individual tickets are done only after their applicable acceptance,
verification, QA, delivery, merge, and board-reconciliation gates complete.
