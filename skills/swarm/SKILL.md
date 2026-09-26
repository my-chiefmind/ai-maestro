---
name: "swarm"
description: "Run, stop, enable, disable, or inspect a continuously replenished Maestro delivery pool that schedules safe worktree lanes, enforces independent QA and delivery gates, splits stale tickets, and serializes merges. Use for sustained multi-agent board delivery; not for a one-off ticket or generic brainstorming."
---

# Swarm

Run one coordinator over a bounded pool of agents. The board is the durable queue; Maestro
lanes decide which tickets may run together. This skill supplies the control policy around
those existing mechanisms. It inherits the orchestrator's scheduling and gate rules, but does
not spawn orchestrator agents or promise more concurrency than the active harness provides.

## Modes

Interpret the requested mode before changing anything:

- **Enable** — run `maestro swarm enable` with any requested policy flags, then run Maestro
  sync. Enabling changes configuration; it does not start background work.
- **Disable** — run `maestro swarm disable`, stop new dispatch immediately, and let active
  agents reach a safe checkpoint. Interrupt active work only when the user explicitly asks
  for an immediate abort. Preserve branches and worktrees either way.
- **Status** — run `maestro swarm status` and report configured policy, actual harness
  capacity, active lanes, gate queues, blockers, and the next startable tickets. Do not start
  work.
- **Run** — execute the continuous wave loop below. If disabled, report the exact enable
  command and stop; never silently opt a project into autonomous delivery.
- **Stop** — use the graceful Disable behavior unless the user explicitly says to abort.

Portable configuration commands:

```sh
maestro swarm enable --agents 10 --worktrees 5 --wave-minutes 30
maestro swarm enable --auto-merge
maestro swarm disable
maestro swarm status --json
```

`targetAgents` is the desired number of active worker agents; the single coordinator is
additional. Actual worker occupancy is the smaller of that target and the harness capacity left
after the coordinator. Report a capacity shortfall; do not simulate extra agents or count
completed agents as active.

## Coordinator execution model

The assistant session in which this skill was invoked is the **one coordinator**. It owns the
wave loop, lane-to-ticket state, board reconciliation, stage transitions, and merge queue. It
must not delegate that responsibility or spawn an `orchestrator` agent. The coordinator applies
the orchestrator contract itself and dispatches bounded specialist tasks through the host's
agent spawn/delegation facility:

| Stage | Concrete agent type |
| --- | --- |
| Missing acceptance criteria, planning, or stale-work split | `principal-engineer` |
| Implementation | the ticket's area/plan agent: `backend-developer`, `frontend-developer`, `pipeline-developer`, `devops`, or `technical-writer` |
| Independent review | `qa` |
| Delivery approval | `principal-delivery` |
| Delivery-control checkpoint (startup, recovery, drift, or merge contention) | `tpm` |
| Repair | the affected implementation agent, never `qa` or `principal-delivery` |

Use the host's live-agent inventory before dispatch, its spawn/delegate primitive to start a
stage, its follow-up primitive only to continue the same owned task, and its event/wait primitive
to collect completions. The coordinator never implements, repairs, or reviews ticket code.

Harness capacity is runtime state, not configuration. If the harness reports a limit, subtract
the coordinator and currently active workers, then cap new dispatch at the remaining slots. If
it does not report a limit, label capacity **unknown**, start at most one new worker at a time,
and treat a refused spawn as the observed ceiling for that wave. Never report `targetAgents` as
actual capacity. If the host has no agent delegation facility, Run mode is unavailable; Status,
Enable, Disable, and Stop still work.

## Pre-flight

Before every initial run and after recovery from a systemic failure:

1. Run `maestro swarm status --json`, then read `{{BOARD}}/data.json` and
   `{{BOARD}}/archive.json`. Confirm the swarm is enabled. The status command resolves the
   project-owned config correctly in vendored, sibling-kit, and package layouts.
2. Run the `board-validate` and `orchestration-health` skills. Do not dispatch against an
   invalid board, an unexplained `in-progress` claim, or an orphaned worktree. After either
   initial pre-flight or recovery from a systemic failure, invoke `tpm` once for a
   pool-wide proceed/hold directive. It must name each affected ticket and either the exact
   next action or the owner decision required; do not spend one TPM agent per healthy lane.
3. Confirm the primary checkout is the clean, current default branch. All ticket and board
   mutations happen in lane worktrees or through the supported board CLI.
4. Resolve the schedule only through:

   ```sh
   maestro lanes next --board {{BOARD}}/data.json --json
   ```

5. Start only tickets returned by that command, up to the configured worktree count and actual
   harness capacity. A serial-only ticket drains the pool and runs alone.

Never weaken `touches`, dependencies, acceptance criteria, gates, or human controls merely to
increase parallelism.

## Continuous wave loop

A wave is a reconciliation interval, not a batch that waits for human permission. While the
swarm remains enabled:

1. **Observe.** Reconcile agents, branches, PRs, worktrees, board status, and elapsed time.
   Invoke `tpm` only when this reveals drift, merge contention, a stale checkpoint,
   or evidence that changes a ticket's readiness; otherwise keep capacity on delivery stages.
2. **Collect.** Receive completed development, QA, repair, and delivery results. Persist
   evidence before replacing an agent.
3. **Gate.** Route every completed implementation through independent QA. A change eligible
   for automatic merge must then pass the delivery gate.
4. **Repair.** Route concrete QA or delivery findings to an implementation agent selected by
   the affected files. QA and delivery agents never fix the work they review. Cap a ticket at
   two repair rounds; after that, block it with evidence and continue unrelated lanes.
5. **Land.** Revalidate against the latest default branch and process approved work through the
   coordinator's one-at-a-time merge queue. Update and archive the ticket through Maestro's
   supported commands. Automatic merge remains blocked unless runtime status confirms a real
   exclusive merge lock; otherwise leave the approved PR queued for an explicitly authorized
   manual merge.
6. **Recompute.** Run `maestro lanes next` again. Refill safe capacity immediately; do not wait
   for the user between healthy waves.
7. **Report.** At the configured wave interval, report active lane → ticket → stage, queued
   gates, merges, stale/split work, blockers, capacity target versus actual, and what starts
   next. Do not emit empty progress messages between checkpoints.

Wait on active agents using the harness's event/wait facility rather than polling rapidly.
Rebalance at completions and wave boundaries.

## Staffing policy

Roles are dynamic; `5 development / 3 QA / 2 repair` is an initial shape, not a reservation.
Fill capacity from current pressure in this order:

1. Keep the single coordinator outside the worker target.
2. When a QA queue exists, keep at least one independent QA agent assigned.
3. When a failed gate has an actionable finding, keep at least one repair agent assigned.
4. When a delivery queue exists, assign delivery capacity so approved branches do not age.
5. Give remaining capacity to implementation agents for startable lane heads.
6. When a queue empties, immediately return its unused slots to the highest-pressure eligible
   stage. Never invent busywork to keep the target full.

Prefer completion flow over raw utilization: a full pool that grows an unreviewed branch queue
is unhealthy. Do not start a second implementation of the same ticket.

## Mandatory development quality

No development ticket starts without acceptance criteria, a real verification command, a
declared file scope, and the applicable reuse decision. Send an underspecified ticket to the
principal engineer before allocating a development lane.

Every implementation must provide:

- relevant tests added or updated for changed behavior;
- the ticket's focused tests plus applicable lint, type, and build checks;
- a reviewable commit and concise evidence;
- independent QA by an agent that did not implement or repair that revision;
- delivery-gate approval before an automatic merge.

A test-only or QA-only ticket still needs its own declared acceptance criteria and evidence.
Never convert a failed test into an exclusion merely to make a gate green.

## Time budgets and stale work

Use the ticket's `swag` as the default wall-clock delivery budget:

| Swag | Progress checkpoint | Stale deadline |
| --- | ---: | ---: |
| `XS` | 30 minutes | 60 minutes |
| `S` | 60 minutes | 120 minutes |
| `M` | 120 minutes | 240 minutes |
| `L` | 240 minutes | 480 minutes |
| `XL` | do not dispatch | split before work |

At the progress checkpoint, require at least one of: a reviewable commit, completed test
evidence, a reproducible failure, or a precise blocker. Silence, repeated attempts without new
evidence, and work beyond the deadline are stale. A known bounded command that is still making
observable progress may finish; record why it is not stale.

For stale work:

1. Stop after the current atomic command and preserve the branch, worktree, logs, commits, and
   uncommitted diff.
2. Have the principal engineer diagnose the blocker and separate completed from remaining
   behavior.
3. Split remaining work into independently testable `XS`–`M` child tickets using the supported
   board command. Preserve the parent's acceptance criteria, dependencies, `touches`, trace,
   reuse decision, and evidence across the children.
4. Do not mark the parent complete until all required children land and an integration QA pass
   proves the original acceptance criteria.
5. Recompute lanes; never dispatch children whose dependencies or scope are unresolved.

Elapsed time alone is a signal to checkpoint and split, not permission to discard working code.

## Worktree drift and TPM decisions

When a worktree is messy, stale, orphaned, or disagrees with its board status, freeze only the
affected lane unless a merge conflict invalidates the whole schedule. Preserve its branch,
worktree, commits, logs, and uncommitted diff. Run `orchestration-health`, then give the
delivery TPM the ticket id, board status, worktree path, branch/PR state, and latest gate
evidence. TPM must choose exactly one outcome:

1. **Resume** — an owned, active ticket has a coherent next stage and no conflicting work.
2. **Finish landing** — the branch already merged but the board/archive evidence is stale.
3. **Block** — a reproducible prerequisite, ownership conflict, or gate failure prevents work.
4. **Owner decision required** — an inactive, deferred, or blocked ticket still has a branch or
   worktree; the owner must choose resume, archive, or cleanup.

Never delete or recreate that worktree as a shortcut, and never dispatch a replacement
implementation while its ownership is unresolved. Resume unrelated safe lanes once the lane
schedule remains valid.

## Merge and authority policy

`autoMerge` is a requested policy, not proof that automatic merging is available. Read
`maestro swarm status --json` and require `runtime.effectiveAutoMerge: true`. The shipped local
coordinator currently reports it as false because it has no exclusive merge-lock primitive;
therefore it fails closed and queues approved PRs for manual merge.

A future runtime may allow automatic merge only when `autoMerge` is enabled and all of these
are true:

- independent QA passed the current revision;
- the delivery gate passed the current revision;
- required tests and plan invariants are green;
- the branch was refreshed and revalidated against the latest default branch;
- the ticket has no uncleared human gate;
- the action does not deploy to or mutate production;
- runtime status identifies the exclusive merge-lock primitive, the coordinator holds it, and
  no other merge is running.

Human-gated tickets and production actions always wait for explicit approval. Development that
prepares production tooling may continue when it has no production side effect.

On a merge conflict, freeze new dispatch for the whole pool, preserve every branch/worktree,
report the conflicting tickets and file scopes, and repair the schedule before resuming. Do not
force-resolve or continue building on a known-wrong schedule.

## Stop and recovery conditions

Continue healthy independent lanes when one ticket is blocked. Stop replenishing the whole pool
when the swarm is disabled, the board becomes invalid, ownership is ambiguous, a merge conflict
invalidates the schedule, the harness loses required capacity/credentials, a configured budget
is exhausted, or only human-gated/production work remains.

An active chat session is not a durable 24/7 service. If the user requests unattended operation,
use the host's supported recurring automation or service supervisor to wake one coordinator;
the board and worktrees remain the recovery state. Never create competing coordinators. State
the actual scheduler, concurrency limit, and notification behavior in the final report.
