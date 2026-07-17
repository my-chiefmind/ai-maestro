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
- **Project overlay:** `<project>/agents/*.md` and `<project>/skills/<name>/SKILL.md` are
  merged in, overriding a kit file of the same name. Custom agents/skills live with the
  project and survive every render.

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
