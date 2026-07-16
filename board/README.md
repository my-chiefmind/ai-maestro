# The board

The board is Maestro's source of truth. Two files plus a specs folder:

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
