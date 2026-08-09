# Getting started

The handbook for running AI Maestro in a real repo: what you maintain, how to tune it, the
alternative layouts, and what to do when something breaks.

Two shorter reads come first, and this guide assumes them rather than repeating them:

| If you want… | Go to |
| --- | --- |
| The pitch and the shortest path in | the [README](../README.md) |
| A step-by-step first run on a brand-new project, in plain language | the [new-project demo](https://mychiefmind.com/ai-maestro/demo) |

This guide is for the next part: adopting the kit into an **existing** codebase, and living with
it afterwards.

## Jargon, once

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

## Set up — one command, a few questions

The command and the questionnaire are covered in the
[README quickstart](../README.md#path-1--instant-setup-with-npx). The rest of this section is
what that summary leaves out.

**Answering non-interactively** — for scripts, CI, or an agent running setup on your behalf —
pass any of `--name`, `--areas`, `--outcome`, `--users`, `--stack`, `--constraints`, `--run`,
`--test`, plus `--yes`. Anything you omit falls back to `propose one`, which becomes an open
question in your brief rather than a silent blank.

**From a clone** — cloning the kit instead of using npx gives the identical layout
(`git clone https://github.com/my-chiefmind/ai-maestro.git maestro`); `npm run setup`
then runs from inside the `maestro/` folder. If you'd rather stay at your project root,
`node maestro/bin/cli.mjs setup` is exactly equivalent.

**What it won't clobber** — an existing root `CLAUDE.md` is never overwritten, and an existing
`context.md` is kept rather than replaced by your answers. `setup` is idempotent: re-running does
nothing once you're set up.

**The board prompt** — `setup` ends by asking *"Open the visual board now?"*. `--yes` opens it
without asking; `--no-board` skips the prompt entirely. Both matter for scripted/CI runs, which
never auto-start the server (it blocks until stopped).

**No command at all** — running `ai-maestro` (or `maestro`) bare prints the help, then in an
interactive terminal shows a numbered picker for `setup` / `sync` / `validate` / `init`.

> **Adopting into an existing codebase?** Don't answer the questionnaire from memory — have your
> coding agent fill it in from the real repo, then plan a board of near-term work for you to
> review. The ready-made prompt for that is
> [Path 2 in the README](../README.md#path-2--hands-free-onboarding-with-claude-code).

## What you maintain

AI Maestro is a **sidecar** — the tooling lives in `maestro/`, the generated agents land at your
repo root, and your application code is never touched. See the
[layout diagram](../README.md#how-it-sits-in-your-project) in the README.

You maintain **three things** — `config.json`, `context.md`, and the **board**. Everything in
`.claude/` is rendered from them, so it is never the thing you edit. After any change to
`config.json` or `context.md`, re-render (from inside the `maestro/` folder):

```bash
npm run sync
```

In CI or a pre-commit hook, add `--check` to fail if the generated files are stale. `sync` only
removes files it generated last time (tracked in `.maestro.lock`), so anything else you keep
under `.claude/` is left alone.

## The brief — `maestro/context.md`

This is the **brief every agent reads** — the single biggest lever on output quality. `setup`
writes it from your answers, and anything you left as `propose one` is listed under **Open
questions** for the agents to resolve and show you. Keep it short and true:

- What the app is and who it's for
- Stack and conventions per area
- **The test command for each area** (e.g. `backend → make test-api`)
- Guardrails: protected branches, where secrets come from, anything human-gated, known-failing tests

> **Existing project?** This is where you write down the tribal knowledge — how tests run, what
> not to touch, what's fragile.
> **New project?** Start with two lines and grow it as the project takes shape.

Re-run `sync` after editing so the context reaches the agents.

## Tuning areas & models — `maestro/config.json`

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

A few less common keys, for when you need them:

```jsonc
{
  "roster": ["orchestrator", "principal-engineer", "backend-developer", "qa"],  // narrow the kit's agents to just these (by file basename, no ".md")
  "skills": ["board-validate", "delivery-hygiene"],                            // same idea, for skills
  "targets": { "codex": true }                                                 // also render .codex/agents/*.toml per agent, for the Codex CLI
}
```

`roster`/`skills` default to everything the kit ships when omitted. A narrowed entry with a
typo warns (`config.roster: "xyz" matches no agent — typo?`) rather than silently vanishing —
check `sync`'s output after editing either. `targets.codex` is off by default; each generated
`.codex/agents/<name>.toml` is derived from the matching `.claude/agents/<name>.md`, so it
never drifts from it independently.

## The board — what a ticket needs

`/project-plan` writes the board for you from your brief, and the cockpit edits it with validated
pickers — but this is the shape underneath, for when you hand-edit `maestro/board/data.json`.

A ticket needs at minimum an `id` and a `status`; a **runnable** ticket also wants `name`, `area`,
`agent_plan`, and `model` (the validator warns when a `todo` ticket is missing them):

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

## Running the orchestrator

Open your agentic coding tool at your **repo root** (not inside `maestro/`) and run
**`/orchestrator`** (in Claude Code) or ask for the `orchestrator` agent by name. The skill
pre-flights the board and your working tree, then hands off to the agent. Each run it will:

1. Read `maestro/board/data.json` and pick the highest-priority unblocked `todo` ticket.
2. Create a worktree + branch for it (via the `git-branch` skill).
3. Run the ticket's resolved plan (`qa → merge` are appended if absent) on its effective model.
4. Land the change and archive the ticket, or file a blocker and stop.

It does **one ticket per run** unless you tell it to keep going, so you stay in the loop between
tickets. Run **one orchestrator at a time** — claiming a ticket is best-effort, not atomic.

## The visual board

The [cockpit](../README.md#the-cockpit) is the one part that runs a server, and it's optional:

```bash
cd maestro && npm run board   # installs the cockpit's deps if needed, then → http://localhost:5273
```

If you keep boards open for more than one project, the ports move rather than collide: 5273
and 4600 are only the starting points, and the board prints the URL it settled on.

## Keeping it clean

- After a ticket lands, the `worktree-cleanup` skill removes its worktree/branch.
- Use the `gc` skill to catch a stale checkout up to `main`.
- Use the `delivery-hygiene` skill when the board starts to feel noisy.
- Use the `dev-report` skill for a read-only "where are we?" snapshot — every repo and
  worktree's branches and uncommitted work, correlated against the board. It changes nothing.

## Updating the kit

A new kit release doesn't reach your project by itself: the kit you run is the copy `setup`
put in `maestro/`, not the npm package — so `npm update` alone changes nothing you use.
One command refreshes it:

```bash
npx @mychiefmind/ai-maestro@latest update    # from your repo root
npm run update                               # …or from the maestro/ folder — same thing
```

`update` replaces the kit's own files in `maestro/` with the new version's (upstream deletions
propagate too), keeps everything that's yours — `config.json`, `context.md`, and the board's
`data.json` / `archive.json` — then re-renders `.claude/` and re-checks the board. It's safe to
run any time: if you're already current it says so and stops, and it refuses to downgrade
unless you pass `--force`. Review the diff before committing, like any other change.

The same command covers the other install shapes:

| You installed via… | Update with |
| --- | --- |
| `npx` (the default) | `npx @mychiefmind/ai-maestro@latest update` |
| Local dependency | `npm update @mychiefmind/ai-maestro`, then `npx ai-maestro update` |
| Git clone | `node <kit>/bin/cli.mjs update` — pulls the clone, then re-renders |

For a **shared clone** used by several repos, `update` pulls once and prints the re-render
command to run per project. The cockpit UI's dependencies are removed with the old kit files
and reinstall on the next `npm run board`.

## Managing several projects

Once you're running the kit in more than one repo, a **registry** file lets a few commands
work across all of them at once instead of one `cd` at a time:

```jsonc
// maestro-registry.json — anywhere; pass its path explicitly or run from beside it
{ "projects": [
  { "name": "my-app",    "path": "~/code/my-app" },
  { "name": "other-app", "path": "~/code/other-app" }
] }
```

```bash
maestro drift --registry maestro-registry.json          # version + hand-edit report per project
node maestro/render/sync.mjs --all --registry maestro-registry.json --check   # re-render/--check all of them
```

`maestro drift` reports, per project: the installed kit version vs. the latest on npm
(`--offline` skips that check), and whether its generated files still match what its own
installed kit would render right now — a hand-edit is reported separately from being behind
on the kit version, since they call for different follow-up. Its output is the worklist for
promoting a local improvement upstream — see [CONTRIBUTING.md](../CONTRIBUTING.md#promoting-a-downstream-improvement).

`sync.mjs --all` renders every registry project in its own subprocess, so one broken project's
error doesn't abort the rest of the batch — useful for `--check` in a script that watches
several repos at once.

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
`node .maestro-kit/bin/cli.mjs update` (pulls the clone, then re-render with
`node .maestro-kit/render/sync.mjs --project maestro`).

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
