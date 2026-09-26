# Orchestrated project capsule

The full board-driven setup. Copy this into your repo, then render.

```bash
cp -R starters/orchestrated-project/. ~/code/my-app/maestro/
cd ~/code/my-app/maestro
$EDITOR config.json context.md          # make them yours
node /path/to/maestro/render/sync.mjs --project . --kit /path/to/maestro
node /path/to/maestro/scripts/validate-board.mjs board/data.json
```

Hand-maintained (you edit these):

- `config.json` — roster, skills, model routing, human gates, kit source.
- `context.md` — the project brief every agent reads.
- `board/data.json` — your epics and tickets.

Generated (committed, never hand-edited): `.claude/agents/`, `.claude/skills/`, `CLAUDE.md`,
`.maestro.lock`.

Then run the `orchestrator` agent from a session in the repo to pick up `T-001`.
