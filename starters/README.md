# Starter capsules

Copy one of these into your repo to adopt Maestro. Each capsule contains only the
**hand-maintained** files; the generated `.claude/` is produced by `sync.mjs`.

| Capsule | For | Ships |
| --- | --- | --- |
| [`orchestrated-project/`](./orchestrated-project/) | Board-driven, multi-agent projects | Full roster, a seed `board/`, multiple areas |
| [`lightweight-project/`](./lightweight-project/) | Repos that want the agents/skills without an active board | Minimal roster, single area, no board |

## Use

```bash
cp -R starters/orchestrated-project/. ~/code/my-app/maestro/
cd ~/code/my-app/maestro
# edit config.json + context.md, then:
node /path/to/maestro/render/sync.mjs --project . --kit /path/to/maestro
```

Re-run `sync.mjs` any time you change `config.json` or `context.md`. Commit the generated
`.claude/`, `CLAUDE.md`, and `.maestro.lock` afterward.
