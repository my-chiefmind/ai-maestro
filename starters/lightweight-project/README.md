# Lightweight project capsule

For a repo that wants AI Maestro's agents and skills but doesn't run an active board. No
`board/` — just a small roster and the git/workflow skills.

```bash
cp -R starters/lightweight-project/. ~/code/my-lib/maestro/
cd ~/code/my-lib/maestro
$EDITOR config.json context.md
node /path/to/maestro/render/sync.mjs --project . --kit /path/to/maestro
```

You get `.claude/agents/` (a minimal roster) and `.claude/skills/` (dev-setup, git-branch,
worktree-cleanup, land-and-archive, gc, release-gate, security-review). Add more later by
editing `config.json` and re-rendering.
