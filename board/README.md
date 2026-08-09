# The board

The board is AI Maestro's source of truth. Two files plus a specs folder:

- **`data.json`** — live work: epics and unresolved tickets, with dependency order.
- **`archive.json`** — completed tickets and their verification evidence. Done work moves
  here so `data.json` only ever shows what's live.
- **`specs/`** — one file per ticket that needs more than its `desc`: `specs/<ticket-id>.md`.
  Reference it from the ticket (`Companion spec: board/specs/<id>.md`) so it's discoverable.
- **`board.schema.json`** — the canonical shape. Validate with
  `node ../scripts/validate-board.mjs data.json`.

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
maestro ticket set-status T-010 in-progress   # optionally --agent-plan/--current-agent/…
maestro ticket block T-010 --name "BLOCKER: …" --desc "…"
maestro ticket archive T-010 --evidence "merged abc123: …" --done-at 2026-08-09
maestro ticket version                        # the board's content version
```

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

See [`../docs/METHOD.md`](../docs/METHOD.md) for the why, and
[`board.schema.json`](./board.schema.json) for the full field list.
