# Maestro 🎼

**Conduct a roster of AI coding agents against a work board.**

Maestro is a small, opinionated kit for running software delivery as an *orchestra* of
AI agents instead of a single chat session. You keep a **board** of epics and tickets;
every ticket declares **which agents work it** (a pipeline like `plan → build → qa → merge`)
and **which model** each stage should run on. An **orchestrator** picks the next unblocked
ticket, runs it through that pipeline in an isolated git worktree, gates it, and lands it —
then moves to the next one.

It's the distilled, product-neutral version of a system I've been running across a
multi-repo portfolio for months. This repo is me sharing the structure so you can adopt
the same way of working.

```
        ┌──────────── board/data.json ────────────┐
        │  epics → tickets                          │
        │  each ticket: agent_plan[] + model        │
        └───────────────────┬──────────────────────┘
                            │  orchestrator picks next unblocked ticket
             ┌──────────────┼───────────────┐
             ▼              ▼               ▼
          plan (PE)      build (dev)       qa ──► merge
         opus/sonnet    sonnet/haiku      sonnet     │
             └──── isolated git worktree ────────────┘
                            │
                     land + archive ticket
```

## Why work this way

- **The board is the source of truth, not the chat.** Work survives context resets,
  handoffs, and parallel sessions because it lives in `board/data.json`, not in a
  conversation you'll lose.
- **The right agent and model per task.** A one-line CSS fix and a database migration
  should not run on the same model or the same prompt. Tickets route themselves.
- **Pipelines, not heroics.** Every ticket flows plan → build → review → merge. Review
  and delivery gates are structural, not something you remember to do.
- **Isolated by construction.** Each ticket runs in its own git worktree, so parallel
  work never collides and a bad branch never dirties `main`.
- **Reusable skills.** Git branch conventions, worktree cleanup, landing a change,
  catching up a stale checkout, validating the board — packaged once, used everywhere.

## What's in the box

| Piece | What it is |
| --- | --- |
| [`board/`](./board/) | The board format (`board.schema.json`) + a runnable example board |
| [`agents/`](./agents/) | A generic agent roster: orchestrator, principal-engineer, backend, frontend, devops, qa, principal-delivery |
| [`skills/`](./skills/) | Reusable skills — board hygiene, release gate, security review, and the git/worktree basics |
| [`render/`](./render/) | `sync.mjs` — generates a project's `.claude/` from its config + context |
| [`starters/`](./starters/) | Two starter capsules: full orchestrated project, or a lightweight single-area one |
| [`cockpit/`](./cockpit/) | A React/MUI board console — stat cards, epic sidebar, filterable ticket cards (model + agent plan), edit-in-place with backups |
| [`docs/`](./docs/) | The method, model-routing policy, and a getting-started guide |

## Quickstart

```bash
# 1. Clone
git clone https://github.com/spourali/maestro.git && cd maestro

# 2. Look at the example board
cat board/data.json | less

# 3. Validate it
node scripts/validate-board.mjs board/data.json

# 4. Open the board console (React/MUI UI)
npm run cockpit:install   # first time only
npm run board             # data service on :4600, UI on http://localhost:5273

# 5. Bootstrap the kit into one of your own repos
cp -R starters/orchestrated-project/. ~/path/to/your-repo/maestro/
cd ~/path/to/your-repo/maestro
node ../../maestro/render/sync.mjs --project . --kit ../../maestro
```

Then, from inside a Claude Code (or compatible) session in that repo, point the
orchestrator at the board and let it pick up the first unblocked ticket. See
[`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md).

## The core idea in one ticket

```jsonc
{
  "id": "T-014",
  "epicId": "e2",
  "name": "Add rate limiting to the public API",
  "area": "backend",
  "priority": "P1",
  "swag": "M",
  "status": "todo",
  "depends_on": ["T-011"],
  "agent_plan": ["pe", "backend", "qa", "merge"],  // the pipeline
  "model": "sonnet"                                  // the model to run it on
}
```

The orchestrator reads that and does the rest: it won't touch `T-014` until `T-011`
is `done`; when it does, it runs a principal-engineer plan, hands the plan to the
backend agent in a fresh worktree, gates through QA, then merges and archives.

## Status

Early and evolving — the structure is battle-tested; the packaging is new. Issues and
ideas welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
