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
- **An agentic coding tool** that can run subagents — [Claude Code](https://claude.com/claude-code),
  Codex, or a compatible harness.

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

**What it won't clobber** — existing root `CLAUDE.md` or `AGENTS.md` files are never overwritten,
nor are unmanaged `.codex/agents` or `.agents/skills` files. An existing `context.md` is kept
rather than replaced by your answers. `setup` is idempotent: re-running does nothing once you're set up.

**The board prompt** — `setup` ends by asking *"Open the visual board now?"*. `--yes` opens it
without asking; `--no-board` skips the prompt entirely. Both matter for scripted/CI runs, which
never auto-start the server (it blocks until stopped).

**No command at all** — running `ai-maestro` (or `maestro`) bare prints the help, then in an
interactive terminal shows a numbered picker for `setup` / `sync` / `validate` / `init`.

> **Adopting into an existing codebase?** Don't answer the questionnaire from memory — have your
> coding agent fill it in from the real repo, then plan a board of near-term work for you to
> review. The ready-made prompt for that is
> [Path 2 in the README](../README.md#path-2--hands-free-onboarding-with-an-ai-coding-agent).

## What you maintain

AI Maestro is a **sidecar** — the tooling lives in `maestro/`, the generated agents land at your
repo root, and your application code is never touched. See the
[layout diagram](../README.md#how-it-sits-in-your-project) in the README.

You maintain **three things** — `config.json`, `context.md`, and the **board**. Everything in
`.claude/`, `.agents/`, and `.codex/` is rendered from them, so it is never the thing you edit. After any change to
`config.json` or `context.md`, re-render (from inside the `maestro/` folder):

```bash
npm run sync
```

In CI or a pre-commit hook, add `--check` to fail if the generated files are stale. `sync` only
removes files it generated last time (tracked in `.maestro.lock`), so unmanaged runtime files
are left alone.

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

## The plan — `maestro/board/plan.json`

`context.md` says **how to work here**. The plan says **what this project is for and where its
boundary is** — and unlike the brief, it is enforced.

| Section | What goes in it |
| --- | --- |
| **Goal** | The outcome, plus a metric you could actually measure |
| **Scope** | In, and — the half that does the work — explicitly **out** |
| **Deliverables** | `D-1` … the artifacts that must exist at the end |
| **Use cases** | `UC-1` … an actor and what they're trying to get done |
| **Functional requirements** | `FR-1` … one behaviour each, with how it's verified |
| **Non-functional requirements** | `NFR-1` … a measurable bar: `p95 < 300ms`, `WCAG 2.2 AA` |
| **Milestones / Risks / Open questions** | Where they're real |
| **Gaps** | What reporting skills found the plan doesn't cover, split required / optional |

`setup` seeds the goal from your brief and leaves the rest empty — everything else is a
commitment only you can make, and a seeded guess would count as filled while being nobody's
decision. Three ways to fill it in:

- **`/plan-update`** — a section-by-section conversation. It proposes from your actual
  repository, writes what you agree to, and tells you the new percentage as it goes. You can
  also just say "add a requirement that exports are CSV" and skip the interview.
- **The cockpit's Plan tab** — every section, editable in place.
- **`maestro plan`** — the same operations from a shell. `maestro plan status` is the quick look.

### Completeness, and why it's a number

The plan reports a percentage. Sections are **weighted** — a goal is worth more than a
milestone list — and placeholder text (`TBD`, `propose one`) never counts as filled. Open
**required** gaps are added to the denominator, so a report finding a hole in the plan visibly
lowers the number until someone accepts or declines it.

### Invariants — rules agents cannot violate

`verify` on a plan item says how a human would check it. **`enforce`** is a command that runs:

```bash
maestro plan add nonFunctional --text "No record written unencrypted" \
  --budget "zero plaintext writes" --enforce "npm run check:encryption"

maestro plan check          # runs every enforce command — put this in CI
maestro plan check --json   # exit 1 and machine-readable output on any violation
```

The release gate runs the invariants a ticket traces to, and a non-zero exit is a hard no-go —
not weighed against how good the change looks. This is the difference between a rule stated in
a brief (which a confident model can talk itself past) and a rule that fails the build.

The kit ships the mechanism and none of the rules: what must never be violated belongs to your
product, not to this framework.

### The scope gate

Every ticket carries `traces_to`: the plan item ids it serves. That is what makes the plan more
than a document.

| Where | What happens to an out-of-scope ticket |
| --- | --- |
| `validate` / the cockpit's save button | **Warning.** The board stays valid — jot the ticket first, plan it after. |
| The orchestrator picking a ticket | **Refused.** Nothing runs that the plan doesn't cover. |

Out of scope means: traces to nothing, traces to an id the plan doesn't define, or traces to
something the plan explicitly excluded (`OUT-n`). Fix it by adding the requirement, dropping the
ticket, or — when a human really does want it anyway — writing a `scope_exception` with the
reason, which clears the gate and stays visible in every report.

The gate stays **off** until the plan names at least one deliverable, use case, or requirement.
A brand-new project isn't refused everything.

```bash
node maestro/scripts/plan-write.mjs status   --board maestro/board/data.json
node maestro/scripts/plan-write.mjs coverage --board maestro/board/data.json  # which FRs no ticket covers
```

## Running work in parallel — lanes

By default one ticket runs at a time. Set `orchestration.maxWorktrees` to opt into **lanes**:

```jsonc
"orchestration": {
  "maxWorktrees": 3,                        // pool size; hard ceiling is 5
  "serialFiles": ["infra/terraform/**"]     // added to the built-in serial patterns
}
```

A lane is a worktree that runs a *queue* of tickets, landing each before starting the next — so
the number of live branches is the number of lanes, never the number of tickets. That is what
keeps merges tractable; a worktree per ticket is the arrangement lanes exist to avoid.

Two tickets get different lanes only when nothing suggests they share files. Declaring
**`touches`** on a ticket is what unlocks parallelism:

```jsonc
{ "id": "T-014", "area": "backend", "touches": ["src/api/cart/**"] }
```

Without it the scheduler falls back to epic, then area, and puts anything it can't prove
independent in one lane. A ticket touching a **serial-only** file — migrations, lockfiles,
generated schema — runs alone with the pool drained first.

```bash
maestro lanes plan               # the schedule, and why each decision was made
maestro lanes next               # exactly what may start now
maestro lanes check T-004 T-007  # would these two conflict? (exit 1 if yes)
```

`maestro lanes plan` also lists the pairs held back **only** because their file scope is
undeclared — the one thing you can fix to get more parallelism.

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
  "targets": { "claude": true, "codex": true }                                // both default true; set either false to disable it
}
```

`roster`/`skills` default to everything the kit ships when omitted. A narrowed entry with a
typo warns (`config.roster: "xyz" matches no agent — typo?`) rather than silently vanishing —
check `sync`'s output after editing either. Claude Code and Codex output are both enabled by
default. Each `.codex/agents/<name>.toml` and `.agents/skills/<name>/SKILL.md` is derived from
the same canonical `agents/` and `skills/` sources as Claude's files, so the targets cannot drift.

## The board — what a ticket needs

`/project-plan` writes the plan and then the board for you, and the cockpit edits both with
validated pickers — but this is the shape underneath, for when you hand-edit
`maestro/board/data.json`.

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
  "model": "sonnet",                                 // the model to run it on
  "traces_to": ["FR-3"]                              // the plan items this serves — the scope gate reads this
}
```

### Writing the board

Don't hand-edit `data.json` — use `maestro ticket`, which is locked, validated and atomic, so a
tab and an agent writing at the same moment can't silently overwrite each other:

```bash
maestro ticket next-id --count 12                     # allocate free ids
maestro ticket add --name "…" --desc "…" --traces-to FR-3
maestro ticket import planned-board.json --replace-sample   # a whole planned board, one write
maestro ticket retrace T-014 --traces-to FR-3         # fix a scope-blocked ticket
maestro ticket drop T-014 --reason "superseded"       # leave the board unfinished, honestly
```

`import` only **adds** — an id that already exists is an error, never an overwrite — so it can't
damage work already on the board. `--replace-sample` clears the starter's placeholder epic and
ticket, and only items explicitly marked as samples. `/project-plan` uses exactly this path.

Validate before running:

```bash
node maestro/scripts/validate-board.mjs maestro/board/data.json
```

## Running the orchestrator

Open your agentic coding tool at your **repo root** (not inside `maestro/`) and run
**`/orchestrator`** or ask for the `orchestrator` agent by name. The skill
pre-flights the board and your working tree, then hands off to the agent. Each run it will:

1. Read `maestro/board/data.json` and pick the highest-priority unblocked `todo` ticket.
2. Create a worktree + branch for it (via the `git-branch` skill).
3. Run the ticket's resolved plan (`qa → merge` are appended if absent) on its effective model.
4. Land the change and archive the ticket, or file a blocker and stop.

It does **one ticket per run** unless you tell it to keep going, so you stay in the loop between
tickets. Run **one orchestrator at a time** — claiming a ticket is best-effort, not atomic.

### Harness mode (optional): the orchestrate Workflow

The `/orchestrator` skill is model-driven — the agent reads the method and follows it. If your
tool supports **Workflow scripts** (Claude Code's Workflow tool) you can opt into a generated
harness where the control flow is deterministic code instead: fix loops capped at 3, security
and release gate verdicts enforced at merge (fail closed), one writer lease at a time, and a
resumable run record per ticket under `.maestro/run/`.

```jsonc
// maestro/config.json
"targets": { "workflow": true },
"orchestrator": {                      // all optional
  "mergeStrategy": "pr",               // "pr" for protected mains; default "local-push"
  "publishBoard": false,               // commit+push board transitions? default false
  "testCmd": { "backend": "npm test" } // per-area test commands the gates verify with
}
```

`sync` then generates `.claude/workflows/orchestrate.js`. Run it with
`Workflow({ name: "orchestrate" })` — no args picks the next unblocked `todo` ticket;
`"start <id>"`, `"status <id>"`, `"resume <id>"`, `"abort <id>"` address one ticket. Finished
tickets are archived (the land-and-archive convention), never left `done` on the live board.

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
- Use the `atomic-report` skill for a terser, ten-second version of the same idea: flat
  bullets for what landed in the last 24h, what's open, what's next, and open branches.

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
`data.json` / `archive.json` — then re-renders both runtime targets and re-checks the board. It's safe to
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
maestro drift  --registry maestro-registry.json         # version + hand-edit report per project
maestro update --all --registry maestro-registry.json   # bring every project to this CLI's version
node maestro/render/sync.mjs --all --registry maestro-registry.json --check   # re-render/--check all of them
```

Two optional fields per project, both defaulted so the two-key form above keeps working:

| Field | Values | What it does |
| --- | --- | --- |
| `status` | `active` (default), `parked` | `parked` keeps a repo on the list but out of every sweep. Use it instead of deleting the entry, so "deliberately not being worked" stays recorded. |
| `kind` | `product` (default), `ops` | `ops` marks portfolio-level tooling that has no delivery pipeline of its own. |

### Groups of groups

An entry with `registry` instead of `path` pulls in another registry, resolved relative to the
file naming it. Each group keeps its own list, and a parent composes them — so a group can be
moved, or read on its own, without rewriting anyone's paths:

```jsonc
// ~/source/maestro-registry.json — everything
{ "projects": [
  { "registry": "./platform/maestro-registry.json" },   // a group, with its own members
  { "registry": "./labs/maestro-registry.json" },
  { "name": "standalone", "path": "~/source/standalone" },
  { "name": "old-thing",  "path": "~/source/old-thing", "status": "parked",
    "note": "Superseded by standalone; kept for reference." }
] }
```

Project **names must be unique across the whole tree** — every tool keys on them, and the
cockpit matches them exactly to decide which board a write lands on, so a duplicate is an error
rather than a race. Include cycles are detected and reported with the chain that formed them.

A registry that is missing or malformed is a **hard error**, never an empty list: "the list
failed to load" and "there is no work anywhere" must not look the same. The full shape is in
[`schemas/maestro-registry.schema.json`](../schemas/maestro-registry.schema.json).

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
node ~/maestro/bin/cli.mjs init                               # writes maestro/, renders Claude + Codex files to the repo root
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

Commit `maestro/`, `.claude/`, `.agents/`, `.codex/`, `CLAUDE.md`, and `AGENTS.md`; the kit stays untracked. Update with
`node .maestro-kit/bin/cli.mjs update` (pulls the clone, then re-render with
`node .maestro-kit/render/sync.mjs --project maestro`).

### By hand (or on Windows)

`init` just automates these steps — copy a starter capsule, edit the two config files (**set
`"outDir": ".."`** so generated runtime files render to the repo root), then render and validate:

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
| Runtime files rendered inside `maestro/`, not the repo root | Add `"outDir": ".."` to `config.json` and re-run `sync` (`setup`/`init` set this for you). |
| `sync` reports drift under `--check` | A generated file was edited, or `config.json`/`context.md` changed without re-rendering. Re-run `sync` (without `--check`). |
| Board validation fails | An invalid/duplicate ticket id, a `depends_on`/`epicId` pointing at an id that doesn't exist, or a dependency cycle. Fix and re-validate. |
| Orchestrator picks nothing | No ticket is both `todo` and unblocked (all its `depends_on` must be `done`) with any `human_gate` cleared. |
