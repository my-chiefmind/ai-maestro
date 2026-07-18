# Getting started

New to AI Maestro? Start here — zero to a running board in your repo, in plain language, no prior
knowledge of the kit assumed.

## What AI Maestro actually is (30-second version)

AI Maestro is a way to run software work as a **team of AI agents** instead of one long chat.

- You keep a **board** — a list of epics and tickets, like a to-do list for the repo.
- Each **ticket** says which agents should work it (e.g. `plan → build → qa → merge`) and
  which AI model to run them on.
- An **orchestrator** agent reads the board, picks the next ready ticket, does the work in an
  isolated copy of your repo, checks it, merges it, and moves on.

The board — not a chat window — is the source of truth, so work survives context resets, new
sessions, and handoffs.

**Jargon, once:**

- **Agent** — an AI role with a focused job (a planner, a backend dev, a reviewer).
- **Model** — which AI runs an agent (e.g. `opus`, `sonnet`, `haiku`); bigger = smarter/slower/pricier.
- **Worktree** — a throwaway second copy of your repo on its own branch, so an agent can work
  without touching your `main` checkout. AI Maestro creates and cleans these up for you.
- **Rendering** — AI Maestro generates the agent/skill files for your project from a couple of
  config files. You edit the config; a script writes the rest.

## Before you start

You'll need:

- **git** and a repo (new or existing — both work the same way).
- **Node.js 18+** — check with `node --version`.
- **An agentic coding tool** that can run subagents — [Claude Code](https://claude.com/claude-code)
  or a compatible harness.

That's it. The core kit is **dependency-free**, so setup needs no `npm install` and starts
nothing running.

## Set up — one command, answer two questions

Run one command in your project:

```bash
cd ~/code/my-app     # your project
npx @mychiefmind/ai-maestro setup # asks project name + areas
```

That copies the kit into `./maestro/` and sets it up — cockpit UI included, so `npm run board`
works right away. If you prefer git (updates via `git pull`), cloning produces the identical layout:

```bash
cd ~/code/my-app                                          # your project
git clone https://github.com/my-chiefmind/ai-maestro.git maestro
cd maestro && npm run setup                               # asks project name + areas
```

> `npm run setup` runs from inside the `maestro/` folder. If you'd rather stay at your project
> root, `node maestro/bin/cli.mjs setup` is exactly equivalent.

`setup` writes your `config.json` + `context.md` and seeds a board inside `maestro/`, then
renders the agents & skills to **`.claude/` and `CLAUDE.md` at your repo root** — where the
coding tool discovers them, so the orchestrator operates on *your* repo, not the `maestro/`
subfolder. An existing root `CLAUDE.md` is never overwritten. It's idempotent — re-running does
nothing once you're set up.

At the end, `setup` asks **"Open the visual board now?"** — answer `Y` and it installs the
cockpit's deps (first run only) and starts it at `http://localhost:5273`; answer `n` and nothing
is left running. Pass `--yes` to open it without asking, or `--no-board` to skip the prompt (both
handy for scripted/CI runs, which never auto-start the server). You can always launch it later
with `npm run board` from the `maestro/` folder.

Running `ai-maestro` (or `maestro`) with **no command** prints the help and then, in an
interactive terminal, shows a numbered picker so you can choose `setup` / `sync` / `validate` /
`init` instead of retyping it.

### Let Claude Code do the onboarding

Prefer not to run the questionnaire by hand? Open your project in
[Claude Code](https://claude.com/claude-code) (or a compatible agentic tool) and paste the
prompt below. It runs `setup`, fills in your `context.md` from the real codebase, and seeds a
few starter tickets for you to review — then stops, so nothing runs until you say so:

```text
Add AI Maestro — the AI-agent orchestration kit — to this project.

1. From the repo root, run: npx @mychiefmind/ai-maestro setup
   It's interactive: it asks for a project name and the areas of this
   codebase (e.g. frontend, backend, infra). Infer sensible answers from
   the repo, but show them to me before you commit to them.
   This vendors the kit into ./maestro/ and renders agents + skills into
   ./.claude/ at the repo root. It must NOT touch my application code.

2. Fill in maestro/context.md — the brief every agent reads. Summarize
   what this project is, its stack, key conventions, and how to run and
   test it, drawn from the ACTUAL codebase (README, package manifests,
   configs) — not guesses.

3. Seed maestro/board/data.json with a few real starter tickets based on
   obvious near-term work you can see (TODOs, missing tests, rough edges).
   Keep them status: "todo" and let me review before anything runs.

4. Report back: the areas you chose, the agent roster, and whether I
   should commit maestro/ or gitignore it.

Do NOT start executing tickets. Stop after setup so I can review — then
I'll invoke the `orchestrator` agent myself.
```

## How it sits in your project

AI Maestro is a **sidecar**: the kit (vendored by `npx @mychiefmind/ai-maestro setup` or cloned by you) and
your settings live in `maestro/`, and the generated agents land at your repo root. It never
touches your application code.

```
my-app/
├── src/ …                    ← your real code (untouched)
├── maestro/                  ← the kit + your settings
│   ├── config.json           ← project name, areas, models   (setup writes this)
│   ├── context.md            ← the brief every agent reads    (you fill in)
│   ├── board/data.json       ← epics + tickets (edit here or in the cockpit)
│   ├── agents/*.md           ← optional: your own custom agents
│   └── skills/*/SKILL.md     ← optional: your own custom skills
├── .claude/                  ← GENERATED — agents & skills (don't hand-edit)
└── CLAUDE.md                 ← GENERATED — project brief
```

You maintain **three things** — `config.json`, `context.md`, and the **board**. Everything in
`.claude/` is rendered from them. After any change to `config.json` or `context.md`, re-render
(from inside the `maestro/` folder):

```bash
npm run sync
```

In CI or a pre-commit hook, add `--check` to fail if the generated files are stale. `sync` only
removes files it generated last time (tracked in `.maestro.lock`), so anything else you keep
under `.claude/` is left alone.

## 1. Describe your project — `maestro/context.md`

This is the **brief every agent reads** — the single biggest lever on output quality. `setup`
seeds a template; replace it with something short and true:

- What the app is and who it's for
- Stack and conventions per area
- **The test command for each area** (e.g. `backend → make test-api`)
- Guardrails: protected branches, where secrets come from, anything human-gated, known-failing tests

> **Existing project?** This is where you write down the tribal knowledge — how tests run, what
> not to touch, what's fragile.
> **New project?** Start with two lines and grow it as the project takes shape.

Re-run `sync` after editing so the context reaches the agents.

## 2. Tune models & areas — `maestro/config.json` (optional)

`setup` already wrote sensible defaults. Adjust to taste:

```jsonc
{
  "project": {
    "name": "my-app",
    "areas": ["backend", "frontend", "infra", "docs"]   // your real areas
  },
  "model": {
    "default": "sonnet",
    "floors": { "infra": "opus" }                        // per-area minimum model
  },
  "humanGates": ["prod release approved", "owner sign-off"]
}
```

- **`areas`** — the parts of your app. Every ticket is tagged with one.
- **`model.floors`** — a ticket runs on the **stronger** of its own `model` and its area's
  floor (a floor can raise a ticket, never lower it). `validate-board` warns on below-floor tickets.
- **`humanGates`** — the allowed `human_gate` phrases; the validator warns on anything else.

## 3. Seed the board

Open `maestro/board/data.json` (or use the cockpit — see below). A ticket needs at minimum an
`id` and a `status`; a **runnable** ticket also wants `name`, `area`, `agent_plan`, and `model`
(the validator warns when a `todo` ticket is missing them):

```jsonc
{
  "id": "T-001",
  "epicId": "e1",
  "name": "Add a health-check endpoint",
  "area": "backend",
  "status": "todo",
  "depends_on": [],                                 // ids of tickets that must finish first
  "agent_plan": ["pe", "backend", "qa", "merge"],   // the pipeline (qa → merge is appended if omitted)
  "model": "sonnet"                                  // the model to run it on
}
```

Validate before running:

```bash
node maestro/scripts/validate-board.mjs maestro/board/data.json
```

## 4. Run the orchestrator

Open your agentic coding tool at your **repo root** (not inside `maestro/`) and invoke the
`orchestrator` agent. Each run it will:

1. Read `maestro/board/data.json` and pick the highest-priority unblocked `todo` ticket.
2. Create a worktree + branch for it (via the `git-branch` skill).
3. Run the ticket's resolved plan (`qa → merge` are appended if absent) on its effective model.
4. Land the change and archive the ticket, or file a blocker and stop.

It does **one ticket per run** unless you tell it to keep going, so you stay in the loop between
tickets. Run **one orchestrator at a time** — claiming a ticket is best-effort, not atomic.

## 5. Watch the board (optional UI)

A visual console — stat cards, epics, filterable tickets, a roster view. The only part that runs
a server:

```bash
cd maestro && npm run board   # installs the cockpit's deps if needed, then → http://localhost:5273
```

## 6. Keep it clean

- After a ticket lands, the `worktree-cleanup` skill removes its worktree/branch.
- Use the `gc` skill to catch a stale checkout up to `main`.
- Use the `delivery-hygiene` skill when the board starts to feel noisy.

---

## Alternative layouts

The flow above is all most people need. Two variations for teams that reuse one kit across
several repos:

### A shared kit for several repos — `maestro init`

Clone the kit once, then `init` drops a small **capsule** (just `config.json`, `context.md`,
`board/` — not the whole kit) into each repo and points it at the shared kit:

```bash
git clone https://github.com/my-chiefmind/ai-maestro.git ~/maestro   # once, anywhere
cd ~/code/my-app
node ~/maestro/bin/cli.mjs init                               # writes maestro/, renders .claude/ to the repo root
```

### Clone the kit in, but keep it out of your git

Clone into the repo, ignore the tooling (like `node_modules`), and let `init` write the tracked
capsule:

```bash
cd ~/code/my-app
git clone https://github.com/my-chiefmind/ai-maestro.git .maestro-kit
printf '\n.maestro-kit/\n.maestro/\n' >> .gitignore
node .maestro-kit/bin/cli.mjs init
```

Commit `maestro/`, `.claude/`, and `CLAUDE.md`; the kit stays untracked. Update with
`git -C .maestro-kit pull`, then `node .maestro-kit/render/sync.mjs --project maestro`.

### By hand (or on Windows)

`init` just automates these steps — copy a starter capsule, edit the two config files (**set
`"outDir": ".."`** so `.claude/` renders to the repo root), then render and validate:

```bash
cd ~/code/my-app
cp -R ~/maestro/starters/orchestrated-project/. maestro/    # PowerShell: Copy-Item ~\maestro\starters\orchestrated-project\* maestro\ -Recurse
# edit maestro/config.json — add "outDir": ".." — and fill in maestro/context.md
node ~/maestro/render/sync.mjs --project maestro --kit ~/maestro
node ~/maestro/scripts/validate-board.mjs maestro/board/data.json
```

### Detached / vendored

To make a project self-contained (no external kit to keep in sync), set
`"kitSource": { "mode": "vendor", "path": ".kit" }` in `config.json` and drop a kit snapshot at
`maestro/.kit/`, then re-run `sync`. The lock file pins the kit version so `--check` still
detects drift.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `kit not found at … (no agents/ dir)` | Your `--kit` path or `kitSource.path` is wrong — point it at the AI Maestro repo root. |
| `.claude/` rendered inside `maestro/`, not the repo root | Add `"outDir": ".."` to `config.json` and re-run `sync` (`setup`/`init` set this for you). |
| `sync` reports drift under `--check` | A generated file was edited, or `config.json`/`context.md` changed without re-rendering. Re-run `sync` (without `--check`). |
| Board validation fails | An invalid/duplicate ticket id, a `depends_on`/`epicId` pointing at an id that doesn't exist, or a dependency cycle. Fix and re-validate. |
| Orchestrator picks nothing | No ticket is both `todo` and unblocked (all its `depends_on` must be `done`) with any `human_gate` cleared. |
