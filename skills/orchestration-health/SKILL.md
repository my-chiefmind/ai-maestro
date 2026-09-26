---
name: "orchestration-health"
description: "Read-only diagnostic for a stuck or suspicious board run: in-progress tickets nothing is actually working on, stale or orphaned worktrees, agent plans with unknown codes, unresolved dependencies, and quietly eligible backlog. Reports findings and remediations without mutating the board, worktrees, or git, and files what the project plan doesn't cover as a plan gap. Run before starting a new run or when a run looks stuck."
---

# Orchestration Health

A read-only diagnostic over the orchestration state: the board (`{{BOARD}}/data.json` +
`archive.json`), the per-ticket worktrees (`../.maestro-wt/*`), and their branches. It reports
inconsistencies and recommends fixes; it **never** changes board state, worktrees, or git.
Apply remediations by hand or through the orchestrator — not from here.

## Checks

Run all checks. Classify each finding as **ERROR** (blocks a safe run) or **WARNING**.

### 1. Claims vs. reality

The kit's loop is one orchestrator at a time, claiming by `status: in-progress` — so a claim
with nothing behind it poisons every later run (the orchestrator skips the ticket forever).

- Every `in-progress` ticket should have a live worktree (`../.maestro-wt/<ticket-id>`) or a
  branch with commits newer than the claim. A claim with neither is an abandoned run —
  **ERROR**; remediation: reset the ticket to `todo` (or `blocked` with the reason) so it
  becomes eligible again.
- An `in-progress` ticket whose branch has merged to the default branch is a run that landed
  but never archived — **ERROR**; remediation: finish the land step (evidence + move to
  `archive.json`, see `land-and-archive`).

### 2. Orphaned and stale worktrees

- Every directory under `../.maestro-wt/` should map to an active (`in-progress`) ticket. A
  worktree for a `done`/archived ticket is leftover from a landed run — **WARNING**; safe to
  clean up (see `worktree-cleanup`). A worktree for a ticket that doesn't exist on the board
  at all is orphaned — **WARNING**.
- A worktree whose branch has no commits beyond its base is an empty shell — **WARNING**.

### 3. Stuck and under-explained tickets

- An `in-progress` ticket whose branch has had no new commits for a long stretch is
  potentially stuck — **WARNING**; inspect the worktree for a failed stage before resuming.
- A `blocked` ticket with no blocker ticket and no recorded reason is unexplained —
  **WARNING**; the next human to read the board can't tell what decision it's waiting on.

### 4. Plan and dependency integrity

- Every code in every `agent_plan` maps to a real agent in `agents/` (or the project's
  overlay) — **ERROR** otherwise; the dispatch would fail mid-run.
- Every `depends_on` id exists on the active board or in `archive.json` — **ERROR** if
  missing; eligibility can never be computed for it.
- Every `human_gate` value is in `config.humanGates` — **WARNING** otherwise; free-text gates
  don't match reliably.

### 5. Quietly eligible backlog

- A `backlog` ticket with every dependency `done` and no recorded reason to wait is a
  promotion candidate — **WARNING**, informational; surface it so eligible work isn't
  invisible to the next run.

## Output

```
=== Orchestration Health ===
Tickets: <n>   Worktrees: <w>   In-progress: <p>

ERRORS (block a safe run):
  <ticket-id | worktree>: <check> — <detail> — <remediation>

WARNINGS (review):
  <id>: <check> — <detail>

SUMMARY: <n> error(s), <m> warning(s)
```

No errors → safe to start the next run. Any error → fix it first; a run dispatched over a
broken state wastes the run at best and double-claims work at worst.

## File what's missing as a plan gap

A finding that the **project plan** doesn't cover belongs in the plan, not only in this report.
A report is read once; a gap sits against the plan, holds its completeness percentage down, and
has to be answered.

Check first — a project with no plan has nothing to file against:

```sh
maestro plan status --board {{BOARD}}/data.json
```

If a plan exists, file each uncovered finding once:

```sh
maestro plan gap-add --board {{BOARD}}/data.json --from "orchestration-health" \
  --need required --text "<what the plan is missing, stated as a gap>"
```

- **`--need required`** — the plan is genuinely incomplete without it: an unstated requirement
  the project clearly depends on, a quality bar the work is already being judged against, a
  deliverable nobody wrote down. These lower the percentage until a human accepts or declines
  them.
- **`--need optional`** — worth considering. Never affects the percentage.

Rules that keep this from becoming noise:

- **State the gap, not the fix.** "No stated availability target for the API" — not "add
  a health check".
- **Only what the plan is missing.** A bug, a stale branch, or a failing test is a report
  finding and belongs in the report. It is not a plan gap.
- **Be sparing with `required`.** Classify as required only what you could defend to the owner.
  A wall of required gaps reads as noise and gets ignored wholesale.
- Re-runs are safe: a gap whose text already exists is skipped, not duplicated.

Name every gap you filed in your summary, with its id and `need`. Triage happens in
`/plan-update`, never here — you file, a human decides.
