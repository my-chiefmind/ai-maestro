---
name: "board-validate"
description: "Check the board (data.json) for structural and logical integrity. Use before running the orchestrator, after hand-editing the board, or when a run picks the wrong ticket — validates the schema, dependency graph, agent plans, and status consistency."
---

# Board Validate

Run `node {{KIT}}/scripts/validate-board.mjs {{BOARD}}/data.json` and fix what it flags.
Validate whenever the board was hand-edited or a run behaves unexpectedly.

## What to check

- **Schema** — every ticket matches `{{BOARD}}/board.schema.json` (valid `status`, `priority`,
  `swag`, `model`; required `id` + `status`). Tickets in `{{BOARD}}/archive.json` are
  schema-checked too — they stay dependency targets forever.
- **Unique ids** — no two epics or tickets share an id, **across `data.json` + `archive.json`**.
  A cross-file collision is an error: archive-on-done tooling deletes the wrong ticket on
  exactly that case.
- **Dependencies resolve** — every id in `depends_on` exists in `data.json` **or**
  `archive.json` (landed tickets move to the archive by design, so deps legitimately point
  there), and there are **no cycles**. An id found in neither file is a hard error: the
  runtime treats an absent dependency as satisfied, so a typo silently *unblocks* the ticket
  instead of holding it.
- **Archive-only statuses** — `archived`, `duplicate`, and `wont-do` are terminal states for
  tickets that left the board *without being completed*; they may appear only in
  `archive.json`. A live ticket carrying one is an error — folding a declined or duplicate
  ticket into `done` records work as finished that never was.
- **failureKind** — blocker tickets from a failed merge may carry `failureKind`
  (`merge-conflict`, `merge-schema-invalid`, `merge-unknown-status`, `merge-missing-sha`) so
  failures are classifiable; the validator warns on unknown values.
- **Eligibility sanity** — at least one `todo` ticket is unblocked, or the orchestrator will
  correctly report `idle`. If you expected work to run, this is usually why it didn't.
- **Agent plans** — every code in `agent_plan` maps to a real agent in `agents/`. Terminal
  gates (`qa → merge`, plus `pd` for multi-agent/human-gated) are appended at run time by the
  orchestrator, so a bare `["backend"]` is fine — it runs `backend → qa → merge`.
- **Model floors** — the validator warns when a ticket's `model` is below its area's floor
  (`config.model.floors`); it will run on the stronger model. Set it explicitly to silence the
  warning.
- **Epic references** — every `epicId` points at a real epic.
- **Plan scope** — once `{{BOARD}}/plan.json` names a deliverable, use case, or requirement,
  the validator **warns** on any ticket whose `traces_to` is empty, points at an id the plan
  doesn't define, or points at an `OUT-` id. It stays a warning here on purpose: you must be
  able to jot a ticket before the plan covers it. It becomes a **block at run time** — the
  orchestrator refuses to pick a scope-blocked ticket. Fix it by adding the requirement
  (`/plan-update`) or by having a human write a `scope_exception` with the reason. A project
  with no plan has the gate off, and the validator says so.
- **Plan coverage** — the validator lists plan items no ticket is working. An uncovered `FR-`
  is either a missing ticket or a requirement that shouldn't have been in the plan.
- **Human gates** — the validator warns when a `human_gate` value isn't in
  `config.humanGates`, so gates stay a known vocabulary the orchestrator matches reliably
  rather than free text. It also warns when a human-gated ticket sits in `todo` or
  `in-progress` — the gate makes it ineligible, so that status is misleading; clear the gate
  or move it back to `backlog`.

## Common failures

- A ticket stuck because it `depends_on` something that's `blocked`, not `done`.
- A dev ticket wrongly depending on a release/prod ticket — prod is a separate track; remove
  the dependency.
- A ticket with no `model` — it'll fall back to the area default; set it explicitly if it
  matters.
