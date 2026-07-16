---
name: "board-validate"
description: "Check board/data.json for structural and logical integrity. Use before running the orchestrator, after hand-editing the board, or when a run picks the wrong ticket — validates the schema, dependency graph, agent plans, and status consistency."
---

# Board Validate

Run `node scripts/validate-board.mjs board/data.json` and fix what it flags. Validate
whenever the board was hand-edited or a run behaves unexpectedly.

## What to check

- **Schema** — every ticket matches `board/board.schema.json` (valid `status`, `priority`,
  `swag`, `model`; required `id` + `status`).
- **Unique ids** — no two epics or tickets share an id.
- **Dependencies resolve** — every id in `depends_on` exists, and there are **no cycles**. A
  cycle means nothing in it is ever eligible.
- **Eligibility sanity** — at least one `todo` ticket is unblocked, or the orchestrator will
  correctly report `idle`. If you expected work to run, this is usually why it didn't.
- **Agent plans** — every code in `agent_plan` maps to a real agent in `agents/`. Terminal
  gates are appended automatically, so a bare `["backend"]` is fine.
- **Epic references** — every `epicId` points at a real epic.
- **Human gates** — `human_gate` values come from the project's configured vocabulary, not
  free text, so they're matched reliably.

## Common failures

- A ticket stuck because it `depends_on` something that's `blocked`, not `done`.
- A dev ticket wrongly depending on a release/prod ticket — prod is a separate track; remove
  the dependency.
- A ticket with no `model` — it'll fall back to the area default; set it explicitly if it
  matters.
