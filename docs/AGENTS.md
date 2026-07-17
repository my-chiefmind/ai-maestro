# The agent roster

AI Maestro ships a small, generic roster. Each agent has one job and a clear handoff — what it
receives and what it produces. The orchestrator wires them together per the ticket's
`agent_plan`.

| Code | Agent | Role | Receives | Produces |
| --- | --- | --- | --- | --- |
| `orchestrator` | [orchestrator](../agents/orchestrator.md) | Runs the board loop: pick → dispatch → gate → land. Implements nothing itself. | The board | An advanced board + a clear status |
| `pe` | [principal-engineer](../agents/principal-engineer.md) | Turns a ticket into a concrete implementation plan. | A ticket | A plan the build agent can follow |
| `backend` | [backend-developer](../agents/backend-developer.md) | Implements server/data/API work against the plan. | Ticket + plan | A branch with the change |
| `frontend` | [frontend-developer](../agents/frontend-developer.md) | Implements UI/client work against the plan. | Ticket + plan | A branch with the change |
| `devops` | [devops](../agents/devops.md) | Infra, CI, build/release tooling (writing it, not running prod). | Ticket + plan | A branch with the change |
| `qa` | [qa](../agents/qa.md) | Independent review of the diff vs. acceptance criteria. | A branch + the ticket | Pass, or a specific list of defects |
| `pd` | [principal-delivery](../agents/principal-delivery.md) | Final delivery validation and landing decision. | A reviewed branch | Merge, or a blocker with a reason |

## Agent-plan shorthand

A ticket's `agent_plan` is an ordered list of these codes:

```jsonc
"agent_plan": ["pe", "backend", "qa", "merge"]
```

- `merge` is a terminal action handled by the delivery stage, not a separate persona.
- Terminal gates (`qa`, `pd`, `merge`) are appended automatically if you omit them, so a
  minimal plan like `["backend"]` still gets reviewed and landed.
- Use `single-agent` execution mode for small tickets (one implementer, light gate) and
  `multi-agent` for full-pipeline work.

## Extending the roster

Add a new agent by dropping `agents/<code>.md` in the kit with `name` + `description`
frontmatter and a crisp role/handoff definition, then reference its code in `agent_plan`.
Keep roles **non-overlapping** — if two agents could each do a task, the handoff is unclear.
