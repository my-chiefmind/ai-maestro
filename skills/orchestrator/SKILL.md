---
name: "orchestrator"
description: "Start a board run: pre-flight the board and working tree, then hand the ticket to the orchestrator agent, which selects it, dispatches the pipeline in a worktree, gates it, and lands or blocks it. Use when asked to run the board, work the next ticket, or continue delivery — including via /orchestrator."
---

# Orchestrator (run entry point)

This is the **entry point** for a board run — `/orchestrator`, "run the board", "work the next
ticket". The loop itself lives in the **`orchestrator` agent**: it selects the ticket,
dispatches each stage, enforces the gates, and lands or blocks. Your job here is to pre-flight,
hand off, and report what actually happened.

**Do not run the loop yourself.** Don't pick tickets, write code, or merge from this skill — a
run that skips the agent skips its gates.

## 1. Pre-flight

Check these first; each one is a common cause of a wasted or destructive run.

- **The board validates.** Run the `board-validate` skill. A broken dependency graph or an
  unknown agent code makes ticket selection meaningless — fix it before dispatching.
- **The working tree is clean** at the repo root (`git status`). Uncommitted work is carried
  into the ticket's worktree and muddies its diff. Ask before touching anything you didn't
  write.
- **No run is already in flight.** A ticket already `in-progress` means another orchestrator
  owns it — the loop is **one orchestrator at a time** and claiming is not atomic. Report the
  in-flight ticket and stop rather than racing it.
- **The brief is real.** If `context.md` still has **Open questions** — commands or constraints
  left as `propose one` — resolve them first (see the `project-plan` skill). A ticket whose
  test command is unknown cannot pass a release gate.
- **The ticket is in the plan.** Run `maestro plan status --board {{BOARD}}/data.json`. If the
  project has a plan, a ticket may only run when its `traces_to` names a real plan item. A
  ticket that traces to nothing, to an id the plan no longer defines, or to an `OUT-` id is
  **out of scope**: report it and stop. Do not fix it by inventing a trace — either the plan
  gains the requirement (`/plan-update`) or a human writes a `scope_exception` saying why this
  runs anyway. A project with no plan yet has the gate off; say so rather than staying silent
  about it.
- **Something is eligible.** If no `todo` ticket has all `depends_on` `done` and its
  `human_gate` cleared, report `idle` with the reason and stop. Never clear a human gate to
  make work eligible.
  > "Nothing to do" and "three things to do, none of them in the plan" call for opposite
  > responses from a human. If everything eligible is scope-blocked, report **that**, name the
  > tickets, and point at `/plan-update` — never report a bare `idle`.

## 2. Hand off

Dispatch the **`orchestrator` agent** for **one ticket**. Pass along anything the user asked
for — a specific ticket id (resume), or "what do you see" (discovery: report the board's state
and dispatch nothing).

## 3. Report

Relay the agent's outcome verbatim in substance — `done`, `blocked`, `idle`, or `merge-failed`
— with the ticket id, what ran, and the evidence (commit SHA, test result). Then say what's
eligible next.

- **`done`** → the next run picks up whatever this unblocked. Say what that is.
- **`blocked`** → surface the specific reason and the blocker ticket. Don't re-dispatch to
  "try again"; a blocker is a decision for the human.
- **`merge-failed`** → the branch and worktree still exist. Report the conflict; don't
  force-resolve it.

Never report a status you didn't get from the agent, and never soften one. A run reported
`done` that didn't merge is worse than a run reported `blocked`.

## One run = one ticket

Stop after the ticket. That pause is the point — it's where a human sees the change before the
next one starts. Continue only when asked again.
