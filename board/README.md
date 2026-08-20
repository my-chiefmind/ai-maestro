# The board

The board is AI Maestro's source of truth. Two files plus a specs folder, and the plan the work
is scoped against:

- **`plan.json`** — the **project plan**: goal, scope, deliverables, use cases, functional and
  non-functional requirements, milestones, risks, and gaps other skills raised against it. Every
  item carries a stable id (`D-`, `UC-`, `FR-`, `NFR-`, `M-`, `OUT-`) that a ticket's
  `traces_to` points at. See [Plan and scope](#plan-and-scope) below.
- **`plan.md`** — a **generated** readable mirror of `plan.json`, rewritten on every plan write.
  Never edit it: your changes are discarded on the next write.
- **`data.json`** — live work: epics and unresolved tickets, with dependency order.
- **`archive.json`** — completed tickets and their verification evidence. Done work moves
  here so `data.json` only ever shows what's live.
- **`specs/`** — one file per ticket that needs more than its `desc`: `specs/<ticket-id>.md`.
  Reference it from the ticket (`Companion spec: board/specs/<id>.md`) so it's discoverable.
- **`board.schema.json`** / **`plan.schema.json`** — the canonical shapes. Validate with
  `node ../scripts/validate-board.mjs data.json`, which checks the board *and* its scope
  against the plan.

## Ticket lifecycle

```
backlog → todo → in-progress → review → done
                       │
                       └──► blocked  (needs a prerequisite or a human)
```

- A ticket is **eligible** only when every id in `depends_on` is `done`.
- `human_gate` tickets are never auto-picked — a human clears them first.
- When a ticket lands, move it from `data.json` to `archive.json` with its `evidence`.

## Writing the board

Use `maestro ticket` — not an editor, and not read-file/edit/write-file:

```sh
maestro ticket next-id --count 12             # allocate free ids (--epics for epic ids)
maestro ticket add --name "…" --desc "…" --traces-to FR-3
maestro ticket add-epic --name "…" --traces-to D-1
maestro ticket import plan.json --replace-sample   # a whole planned board, in one write
maestro ticket set-status T-010 in-progress   # optionally --agent-plan/--current-agent/…
maestro ticket retrace T-010 --traces-to FR-3 | --scope-exception "…"
maestro ticket block T-010 --name "BLOCKER: …" --desc "…"
maestro ticket archive T-010 --evidence "merged abc123: …" --done-at 2026-08-09
maestro ticket drop T-010 --reason "superseded"    # leaves unfinished, via the archive
maestro ticket version                        # the board's content version
```

`import` is the one op that takes a whole document, and it is safe for one reason: it **only
adds**. An id already live or archived is a hard error, never an overwrite — so it cannot modify
or delete existing work. Its single removal, `--replace-sample`, touches only items a starter
marked `"sample": true`, which is why it is safe to pass even on a project full of real tickets.

`drop` is the honest delete: the ticket leaves through `archive.json` carrying *why*, under
`wont-do` / `duplicate` / `archived`. It refuses when other live tickets depend on it — because
eligibility treats every archived id as a **satisfied** dependency, so dropping a prerequisite
silently makes its dependents runnable.

And `maestro plan` — never an editor — for the plan:

```sh
maestro plan status                           # completeness %, what's thin, open gaps
maestro plan questions                        # the next unanswered questions
maestro plan add functional --text "…" --verify "…"
maestro plan scope --in "…" --out "…"         # --out mints an OUT- id the gate enforces
maestro plan gap-add --need required --from atomic-report --text "…"
maestro plan coverage                         # plan items vs the tickets working them
```

Plan writes take the **same lock** as board writes — the lock guards the directory, not one
file — so a run that reads the plan and the board together always sees a coherent pair.

Every op is **declarative** — it names the change, not the resulting board — and is applied
to the file as it exists at write time, under a lock, validated, and written atomically.

That matters because the obvious alternative silently destroys work. Read the board, change
one ticket in memory, write the whole file back, and any change another writer made in
between is gone: no error, no conflict, and the result is valid JSON that passes this
directory's own validator. It happened on this repo's board on 2026-08-08 and cost a filed
ticket, which is why the tooling no longer offers that shape.

Exit codes are the contract: **0** written, **1** the request was wrong (do not retry),
**2** contended — the board moved or the lock was busy, so re-run the same command.

The cockpit's save button and `maestro ticket` share one version token, so a UI tab and an
agent cannot disagree about whether the board changed underneath them.

## Fields that drive execution

| Field | Drives |
| --- | --- |
| `agent_plan` | The pipeline of agents that work the ticket |
| `model` | The model tier each stage runs on |
| `area` | Area defaults (model floor, test command) |
| `depends_on` | Eligibility ordering |
| `human_gate` | Whether the orchestrator may auto-pick it |
| `traces_to` | Whether the ticket is in the plan's scope at all |

## Plan and scope

A ticket's `traces_to` names the plan items it serves. That one field answers two questions the
board couldn't answer before: *what is this ticket for?* and *is it in scope?*

The gate is deliberately split:

| Where | Behaviour |
| --- | --- |
| `maestro validate` / the cockpit's save | **Warns.** The board stays valid — you must be able to jot a ticket before the plan covers it. |
| The orchestrator picking a ticket | **Blocks.** Nothing runs that the plan doesn't cover. |

A ticket is out of scope when it traces to nothing, to an id the plan doesn't define, or to an
`OUT-` id. Three ways out, in order of preference:

1. Add the requirement to the plan — `/plan-update` — and trace the ticket at it.
2. Decide the ticket shouldn't exist.
3. Have a human write a `scope_exception` explaining why it runs anyway. It clears the gate and
   stays visible in every report, so an exception can't quietly become the norm.

The gate is **off** until the plan names at least one deliverable, use case, or requirement — a
project one minute past `maestro setup` isn't refused everything.

See [`../docs/METHOD.md`](../docs/METHOD.md) for the why, and
[`board.schema.json`](./board.schema.json) / [`plan.schema.json`](./plan.schema.json) for the
full field lists.
