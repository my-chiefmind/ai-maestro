---
name: "project-plan"
description: "Turn a project brief into a reviewable board: 3-6 outcome-based epics and 5-15 dependency-ordered tickets, validated, then stopped for human review. Use at the start of a new project, when the board is still the starter sample, or when asked to plan/re-plan the work before any implementation."
---

# Project Plan

You turn the project's brief into a board the orchestrator can execute. **You plan only** — you
never write application code, never run a ticket, and never invoke the orchestrator.

## Read first

1. The project's **`context.md`** — the brief: outcome, users, stack, constraints, run/test
   commands. It sits beside the board, one level up from `{{BOARD}}/`.
2. The project's **`config.json`**, beside it — the allowed `areas`, agent codes, model names,
   and human gates.
3. `{{BOARD}}/board.schema.json` — the exact ticket shape.
4. `{{BOARD}}/data.json` — the current board (a fresh project holds sample content to replace).

## Resolve the brief's open questions first

`maestro setup` writes the brief from the user's answers and marks anything they left as
`propose one` under **Open questions**. Before planning:

- Propose a concrete answer for each open item, drawn from the real repository where one
  exists (an existing `package.json` script beats an invented command).
- Write those answers into `context.md`, remove the resolved entries from **Open questions**,
  and list every proposal in your summary as an assumption to confirm.
- Never plan around a blank. A ticket whose test command is `TBD` cannot pass a release gate.

## Then write the board

Replace the sample content in `{{BOARD}}/data.json`:

1. **3-6 epics**, each an outcome, with a unique `id`, `name`, and short `description`.
2. **5-15 tickets** across those epics. Each is small and independently verifiable — split
   anything XL.
3. Every ticket carries: `id`, `epicId`, `name`, `description` with concrete acceptance
   criteria, `area`, `priority`, `swag`, `status`, `depends_on`, `agent_plan`,
   `execution_mode`, and `model`.
4. Use only the `areas`, agent codes, and model names `config.json` allows.
5. Every ticket starts at `status: "todo"`.
6. Build an **acyclic** `depends_on` graph: foundations first, then user-visible vertical
   slices as early as they can safely land. Leave at least one ticket with an empty
   `depends_on` so the first run has something eligible.
7. Include tests, docs, security, accessibility, deployment, or observability **only where the
   brief makes them relevant**. Put the required verification in each ticket's acceptance
   criteria rather than filing vague cleanup tickets.
8. Reserve `P0` for work that blocks the whole MVP; prefer `P1`/`P2`.
9. Keep prod/release and human-gated steps as separate tickets with a `human_gate` from
   `config.humanGates` — never as a dependency of ordinary development work.

## Validate, then stop

Run the `board-validate` skill (`node {{KIT}}/scripts/validate-board.mjs {{BOARD}}/data.json`)
and fix everything it flags.

Then report, and **stop for review**:

- the epic list;
- the tickets in delivery order, with their dependencies;
- which ticket is ready first;
- assumptions, risks, and decisions that need a human's approval.

Done when: the board validates clean, one valuable ticket is immediately eligible, and the
human has approved the plan. Only then may the orchestrator start.
