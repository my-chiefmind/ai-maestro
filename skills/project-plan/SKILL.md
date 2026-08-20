---
name: "project-plan"
description: "Turn a project brief into a plan and then a board: first the project plan (goal, scope, deliverables, use cases, functional and non-functional requirements), then 3-6 outcome-based epics and 5-15 dependency-ordered tickets that each trace to a plan item, validated, then stopped for human review. Use at the start of a new project, when the board is still the starter sample, or when asked to plan/re-plan the work before any implementation."
---

# Project Plan

You turn the project's brief into **a plan, and then a board the orchestrator can execute**.
**You plan only** — you never write application code, never run a ticket, and never invoke the
orchestrator.

Two phases, in order, with a human between them:

1. **The plan** — what this project is for and where its boundary is. Stop for review.
2. **The board** — epics and tickets, each tracing to a plan item. Stop for review.

Phase 2 without phase 1 is how a board ends up full of confident work nobody asked for. The
scope gate enforces the order: a ticket that traces to nothing is refused at run time.

## Read first

1. The project's **`context.md`** — how to work here: stack, run/test commands, guardrails. It
   sits beside the board, one level up from `{{BOARD}}/`.
2. The project's **`config.json`**, beside it — the allowed `areas`, agent codes, model names,
   and human gates.
3. **`{{BOARD}}/plan.json`** — the plan, if one exists. Check it first:
   `maestro plan status --board {{BOARD}}/data.json`.
4. `{{BOARD}}/board.schema.json` and `{{BOARD}}/plan.schema.json` — the exact shapes.
5. `{{BOARD}}/data.json` — the current board (a fresh project holds sample content to replace).

---

# Phase 1 — the plan

Skip to phase 2 only if `maestro plan status` already reports a plan with a goal, a scope
boundary, and requirements, and the user has approved it. Otherwise the plan comes first.

## Resolve the brief's open questions

`maestro setup` writes `context.md` from the user's answers and marks anything they left as
`propose one` under **Open questions**. Before planning:

- Propose a concrete answer for each open item, drawn from the real repository where one
  exists (an existing `package.json` script beats an invented command).
- Write those answers into `context.md`, remove the resolved entries from **Open questions**,
  and list every proposal in your summary as an assumption to confirm.
- Never plan around a blank. A ticket whose test command is `TBD` cannot pass a release gate.

## Write the plan

Follow the **`plan-update`** skill's method and command set — it owns the section-by-section
detail, and duplicating it here would let the two drift. In short: work the order
`maestro plan questions` gives you, propose from the real repo, write each item with
`maestro plan`, and never hand-edit `plan.json` or `plan.md`.

For a first plan, aim for:

- a **goal** with at least one measurable metric;
- a **scope** with both halves — the `--out` list is what makes the gate mean anything;
- **3-8 deliverables**, **3-8 use cases**, **6-20 functional requirements** each with a
  `--verify`, and the **non-functional requirements** the brief actually implies (an internal
  tool with three users does not need a five-nines NFR — inventing one gates real work on
  imaginary bars);
- risks and open questions where they're real.

## Stop for review

Report the plan back in prose — goal, boundary, what it commits to — plus the completeness
percentage and every assumption you made. **Get the human's approval before phase 2.** A board
built on an unapproved plan is a board that has to be rebuilt.

---

# Phase 2 — the board

## Never write the board with an editor

`{{BOARD}}/data.json` is written through `maestro ticket` — locked, validated, atomic — and
**not** with read-file/edit-file/write-file. Reading the board, changing it in memory and
writing the whole thing back silently destroys anything another writer added in between: no
error, no conflict, and valid JSON that passes the validator. That is not hypothetical; it cost
this kit a filed ticket.

Write a plan-sized board in **one** atomic import:

```sh
# 1. Allocate ids from the board as it is right now.
maestro ticket next-id --count 12 --board {{BOARD}}/data.json
maestro ticket next-id --epics --count 4 --board {{BOARD}}/data.json

# 2. Write the epics + tickets you designed to a file, using exactly those ids.
#    (A scratch file, not the board — this one is reviewable before anything lands.)

# 3. Preview, then land it.
maestro ticket import <file> --replace-sample --dry-run --board {{BOARD}}/data.json
maestro ticket import <file> --replace-sample --board {{BOARD}}/data.json
```

- `--replace-sample` removes the starter's placeholder epic and ticket — and **only** items
  explicitly marked `"sample": true`. It can never touch real work, so it is safe to pass on a
  re-plan too.
- Import **only adds**. An id that already exists is a hard error, never an overwrite. If you
  get one, the board moved under you: re-run `next-id` and rebuild the document.
- Everything lands in one write, or none of it does. A half-imported board is not a state the
  orchestrator can pick from.

For single tickets afterwards, use `maestro ticket add` / `add-epic`.

## What to write

1. **3-6 epics**, each an outcome, with a unique `id`, `name`, short `desc`, and a `traces_to`
   naming the plan items it delivers.
2. **5-15 tickets** across those epics. Each is small and independently verifiable — split
   anything XL.
3. Every ticket carries: `id`, `epicId`, `name`, `desc` with concrete acceptance criteria,
   `area`, `priority`, `swag`, `status`, `depends_on`, `agent_plan`, `execution_mode`, `model`,
   and **`traces_to`**.
   > `desc` — not `description`. The board schema, the validator, and the cockpit all read
   > `desc`; a ticket written with `description` validates clean and then shows up blank
   > everywhere, which is worse than an error.
4. **Declare `touches`** — the glob patterns each ticket is expected to change, e.g.
   `["src/api/cart/**"]`. This is what lets tickets run in parallel lanes: two tickets with
   disjoint declared scopes can run at once, while anything undeclared falls back to "same epic
   or same area → same lane". Guess honestly and broadly rather than precisely and wrongly — an
   over-broad scope costs some parallelism, an under-broad one costs a merge conflict. Put
   migrations, lockfiles and generated schema in their own tickets: they run alone by design.
5. **`traces_to` is not optional.** Every ticket names at least one plan item id (`D-`, `UC-`,
   `FR-`, `NFR-`, `M-`). A ticket that traces to nothing is out of scope by definition and the
   orchestrator will refuse to pick it. If you find yourself wanting a ticket the plan doesn't
   cover, that is the plan being incomplete — go back and add the requirement, don't invent a
   trace.
6. Use only the `areas`, agent codes, and model names `config.json` allows.
7. Every ticket starts at `status: "todo"`.
8. Build an **acyclic** `depends_on` graph: foundations first, then user-visible vertical
   slices as early as they can safely land. Leave at least one ticket with an empty
   `depends_on` so the first run has something eligible.
9. Include tests, docs, security, accessibility, deployment, or observability **only where the
   plan makes them relevant** — and when the plan does, trace those tickets to the NFR that
   demands them. Put the required verification in each ticket's acceptance criteria rather than
   filing vague cleanup tickets.
10. Reserve `P0` for work that blocks the whole MVP; prefer `P1`/`P2`.
11. Keep prod/release and human-gated steps as separate tickets with a `human_gate` from
    `config.humanGates` — never as a dependency of ordinary development work.

## Cover the plan

Run `maestro plan coverage --board {{BOARD}}/data.json`. Every deliverable, use case, and
functional requirement should have a ticket, or a stated reason it doesn't (a later phase, a
milestone not in this MVP). An uncovered `FR-` is either a missing ticket or a requirement that
didn't belong in the plan — say which.

## Validate, then stop

Run the `board-validate` skill (`node {{KIT}}/scripts/validate-board.mjs {{BOARD}}/data.json`)
and fix everything it flags, including the scope warnings.

Then report, and **stop for review**:

- the epic list, and what each delivers from the plan;
- the tickets in delivery order, with their dependencies and what they trace to;
- which ticket is ready first;
- plan items no ticket covers;
- assumptions, risks, and decisions that need a human's approval.

Done when: the plan is approved, the board validates clean with no scope warnings, one valuable
ticket is immediately eligible, and the human has approved the plan. Only then may the
orchestrator start.
