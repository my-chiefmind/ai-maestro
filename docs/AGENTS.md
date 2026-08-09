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
| `pipeline` | [pipeline-developer](../agents/pipeline-developer.md) | Implements data-pipeline work against the plan, holding the idempotency invariant. | Ticket + plan | A branch with the change |
| `devops` | [devops](../agents/devops.md) | Infra, CI, build/release tooling (writing it, not running prod). | Ticket + plan | A branch with the change |
| `docs` | [technical-writer](../agents/technical-writer.md) | Writes the document a ticket asks for, when the document *is* the deliverable. | Ticket + plan | A branch with the document |
| `qa` | [qa](../agents/qa.md) | Independent review of the diff vs. acceptance criteria. | A branch + the ticket | Pass, or a specific list of defects |
| `pd` | [principal-delivery](../agents/principal-delivery.md) | Final delivery validation and landing decision. | A reviewed branch | Merge, or a blocker with a reason |

One agent sits outside the pipeline — it answers a question about a repo rather than advancing
a ticket, so it takes no `agent_plan` slot:

| Code | Agent | Role | Receives | Produces |
| --- | --- | --- | --- | --- |
| `repo-audit` | [repo-audit](../agents/repo-audit.md) | Audits exactly one repo — security findings, gaps, a ranked improvement plan. Read-only against code. | A repo | A graded report under the board's `reports/` |

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

In a **project**, add an agent as `maestro/custom/agents/<code>.md` with `name` + `description`
frontmatter and a crisp role/handoff definition, then reference its code in `agent_plan`.
`custom/` is the one folder `maestro update` never touches, and it needs no `roster` entry —
`roster` selects which *kit* agents you take; your own are always rendered. To change a kit
agent rather than add one, prefer `custom/agents/<code>.overlay.md`, which appends to it and
keeps the kit's half updating; a full `custom/agents/<code>.md` replaces it and opts the project
out of every later improvement to it.

In the **kit** itself, the same file goes in `agents/`. Either way, keep roles
**non-overlapping** — if two agents could each do a task, the handoff is unclear.
