# Getting started

Maestro works with any agentic coding harness that can read files and run a subagent
(Claude Code, and compatible tools). This guide gets a board running in one of your repos.

## 1. Pick a starter capsule

| Capsule | Use when |
| --- | --- |
| `starters/orchestrated-project/` | You want the full board-driven, multi-agent flow with multiple areas. |
| `starters/lightweight-project/` | You want the kit's agents/skills in a repo without an active board. |

```bash
cp -R starters/orchestrated-project/. ~/code/my-app/maestro/
```

## 2. Configure the project

Edit two hand-maintained files in the copied capsule:

- **`config.json`** — project name, areas, model defaults, human-gate vocabulary, and where
  the kit lives (`kitSource`).
- **`context.md`** — the project-specific brief every agent reads: what the app is, its
  conventions, test commands per area, and any guardrails.

Everything else (`.claude/agents/`, `.claude/skills/`) is **generated** from these two files
plus the kit — you don't hand-edit generated files.

## 3. Render the agents & skills

```bash
node /path/to/maestro/render/sync.mjs --project ~/code/my-app/maestro --kit /path/to/maestro
```

This writes the project's `.claude/agents/*.md` and `.claude/skills/*` and a lock file for
drift detection. Re-run it any time you change `config.json` or `context.md`. Run with
`--check` in CI/pre-commit to fail on drift.

## 4. Seed the board

Open `board/data.json`. Create your epics, then your first few tickets. A ticket needs at
least an `id`, `status`, an `agent_plan`, and a `model`. Validate:

```bash
node /path/to/maestro/scripts/validate-board.mjs board/data.json
```

## 5. Run the orchestrator

From an agent session in the repo, invoke the `orchestrator` agent. It will:

1. Read `board/data.json` and pick the highest-priority unblocked `todo` ticket.
2. Create a worktree + branch for it (see the `git-branch` skill).
3. Run the ticket's `agent_plan` — plan, build, qa — on the ticket's `model`.
4. Land the change and archive the ticket, or file a blocker and stop.

You stay in the loop between tickets; the orchestrator does one ticket per run unless you
tell it to keep going.

## 6. Keep it clean

- After a ticket lands, the `worktree-cleanup` skill removes its worktree/branch.
- Use the `gc` skill to catch a stale checkout up to `main`.
- Use the `delivery-hygiene` skill when the board starts to feel noisy.

## Detached / vendored use

A project should keep working if moved out from next to the kit. Set
`kitSource.mode: "vendor"` in `config.json` and drop a kit snapshot at
`maestro/.kit/`, then re-run `sync.mjs`. The lock file records the exact kit version so
`--check` still detects drift.
