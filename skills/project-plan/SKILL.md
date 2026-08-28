---
name: "project-plan"
description: "Turn a project brief into a plan and then a board: first the project plan (goal, scope, deliverables, use cases, functional and non-functional requirements), then 3-6 outcome-based epics and 5-15 dependency-ordered tickets that each trace to a plan item, validated, then stopped for human review. Use at the start of a new project, when the board is still the starter sample, or when asked to plan/re-plan the work before any implementation."
---

# Project Plan

You turn the project's brief into **a plan, and then a board the orchestrator can execute**.
**You plan only** — you never write application code, never run a ticket, and never invoke the
orchestrator.

Phases, in order, with a human between each:

1. **The plan** — what this project is for and where its boundary is. Stop for review.
2. **Initiatives** — *only for a large project*; skip this entirely for most. Stop for review.
3. **The board** — epics and tickets, each tracing to a plan item. Stop for review.

The board without the plan is how a board ends up full of confident work nobody asked for. The
scope gate enforces the order: a ticket that traces to nothing is refused at run time.

The full hierarchy, when every level is in play:

```
Project plan   the boundary — nothing outside it may run
└── Initiative an independently valuable outcome, delivered by several epics
    └── Epic   a demonstrable delivery outcome, made of tickets
        └── Ticket  the executable, independently verifiable unit
```

Most projects have no initiative level, and that is the normal case, not a deficiency.

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

Skip ahead only if `maestro plan status` already reports a plan with a goal, a scope
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
percentage and every assumption you made. **Get the human's approval before going on.** A board
built on an unapproved plan is a board that has to be rebuilt.

Say explicitly whether you think this project needs initiatives (phase 2) or should go straight
to epics (phase 3), and why. For most projects the answer is straight to epics.

---

# Phase 2 — initiatives (skip this for most projects)

**Default to skipping.** A project goes straight from plan to epics unless it holds several
independently valuable outcomes that EACH need multiple epics. Adding initiatives to a project
that does not need them buys one more layer to keep consistent and nothing else.

Use them when the answer to "could we ship this half and stop, and it would still be worth
something?" is yes for two or more separable halves.

If you do use them:

- **2-6 initiatives.** More than six usually means they are epics wearing a bigger name.
- Each needs a **distinct outcome** — what is true for someone once it lands — and a
  **boundary**. An initiative without an outcome is a folder, which is the thing this layer
  is not.
- **Never name one after a technical layer.** "Backend", "Frontend", "Infrastructure" are not
  independently valuable outcomes; they are how one outcome is built. "Customer onboarding" and
  "Billing migration" are initiatives. "API" is not.
- Initiatives **own** plan items rather than containing copies of them. Assign an item with
  `maestro plan add|edit <ID> --initiative I-1`.
- **A project-wide requirement carries no `--initiative`.** "No PII in logs" applies to every
  initiative, so leaving it unowned is correct — assigning it to one would count its delivery
  toward that initiative alone and understate the rest.
- `--depends-on` between initiatives is **planning information only**. It never changes ticket
  eligibility or lane scheduling; nothing schedules from it.

```sh
maestro plan initiative-add --board {{BOARD}}/data.json \
  --name "Customer onboarding" \
  --outcome "A customer can create and activate an account without contacting support" \
  --metric "80% complete onboarding unaided" \
  --in "Registration" --in "Email verification" \
  --out "Billing migration"

maestro plan edit FR-1 --initiative I-1 --board {{BOARD}}/data.json
```

## Stop for review

Report the initiatives, what each owns, and what stayed project-wide. **Get approval before
phase 3.** Reorganising ownership after epics exist means moving epics too, and the writers
refuse any move that would strand a trace — so the cheap moment to get this right is now.

---

# Phase 3 — the board

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
   > **If the plan defines initiatives**, every epic also needs an `initiativeId`. An epic left
   > unassigned warns in the validator and its tickets are refused at pick time — the board
   > stays valid so a migration can proceed, but nothing under that epic runs. An epic may
   > trace only to its own initiative's items or to project-wide ones; a trace across
   > initiatives is a hard error.
   >
   > Tickets get **no** `initiativeId`. A ticket derives its initiative through its epic, and
   > storing it twice is how the two come to disagree.
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
