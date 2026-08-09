# render/

`sync.mjs` turns a project's two hand-maintained files into a full `.claude/` setup.

```
config.json  +  context.md  +  the kit  ──sync.mjs──►  .claude/agents/   (chosen roster)
                                                        .claude/skills/   (chosen skills)
                                                        CLAUDE.md         (header + context)
                                                        .maestro.lock     (content hashes)
```

## Usage

```bash
node render/sync.mjs --project <dir> [--kit <dir>] [--check]
```

- `--project` — the managed project directory (must contain `config.json`; `context.md`
  optional but recommended).
- `--kit` — the AI Maestro kit root. Defaults to `config.kitSource.path` (relative to the
  project), else the kit this script lives in.
- `--check` — verify the committed generated files match what would be rendered; exit 1 on
  drift. Use it in a pre-commit hook or gate so generated files never go stale.

## Contract

- **Generated files are committed** (so the project works without re-rendering) but
  **never hand-edited** — change `config.json` / `context.md` and re-run.
- The lock file is **deterministic** (no timestamps) — only the kit version and content
  hashes are baked in, so `--check` is stable.
- Removing an agent from `roster` or a skill from `skills` and re-rendering deletes the
  stale generated file. Only files recorded in the previous `.maestro.lock` are pruned, so
  anything else you keep under `.claude/` is never touched.
- **Your existing `.claude/` is adopted, not overwritten.** On the first render, any
  `.claude/agents/*.md` or `.claude/skills/<name>/SKILL.md` that isn't in the previous lock was
  written by you, not by this tool. It is moved into `<project>/custom/` and reported — which
  both preserves it and keeps it the thing that renders, since `custom/` overrides a kit file of
  the same name. `CLAUDE.md` / `AGENTS.md` have no `custom/` slot, so those are left in place
  with a warning instead.
- **Adding vs replacing.** A project file whose name the kit doesn't ship *adds* an agent and
  costs nothing. One whose name the kit *does* ship *replaces* it — this project then stops
  receiving kit improvements to it. `sync` reports the two separately and names the alternative
  (`<name>.overlay.md`) for the common case of only wanting to add a rule.
- **Project overlay:** `<project>/custom/agents/*.md` and `<project>/custom/skills/<name>/SKILL.md`
  are merged in, overriding a kit file of the same name, and are **not** filtered by `roster` /
  `skills` — those select which *kit* files you take; your own are always included. `custom/` is
  never a vendored kit folder, so `maestro update` cannot touch it.
- **Legacy overlay location:** `<project>/agents` and `<project>/skills` are still read, but
  only when the project dir and the kit dir are different (the `init` capsule layout). Under
  `setup` the kit is vendored *into* the project, so those paths are the kit's own folders —
  reading them there re-added every kit agent regardless of `roster`, and `update` swept away
  anything a project had put in them. `update` migrates what it finds there into `custom/`.

## config.json shape

See `starters/orchestrated-project/config.json` for a full example. Keys:

| Key | Meaning |
| --- | --- |
| `project.name` | Substituted into generated files as `{{PROJECT_NAME}}`. |
| `project.areas` | The areas your tickets use (backend/frontend/infra/…). |
| `roster` | Agent file basenames to include (omit = all). |
| `skills` | Skill dir names to include (omit = all). |
| `model.default` / `model.floors` | Default model tier + per-area floors. |
| `humanGates` | Allowed `human_gate` phrases for tickets. |
| `kitSource.mode` / `kitSource.path` | Where the kit lives (`sibling` / `vendor`). |
