# AI Maestro — repo guidance

> This is the **AI Maestro kit** itself (the framework), not a project managed by it.

## What lives here

| Path | What it is |
| --- | --- |
| `board/` | The board format (schema) + an example board. Not this repo's own workboard. |
| `agents/` | The generic agent roster (source of truth; projects render copies). |
| `skills/` | Reusable skills (source of truth; projects render copies). |
| `render/sync.mjs` | Generates a project's `.claude/` from its config + context. |
| `scripts/validate-board.mjs` | Board integrity check. |
| `starters/` | Capsules users copy into their repos. |
| `docs/` | The method and guides. |

## Rules for changing the kit

| Rule | Detail |
| --- | --- |
| **Product-neutral** | No company/vendor/cloud specifics in the core — those belong in a project's `context.md` or in examples. |
| **Frontmatter** | Agents and skills carry `name` + `description` frontmatter. Keep roles non-overlapping. |
| **Validate the example board** | After touching it: `node scripts/validate-board.mjs board/data.json`. |
| **Deterministic renderer** | Keep it deterministic — the lock file must not depend on timestamps. |
| **Version** | **Never bump it in a PR** — CI rejects that. The version belongs to a *release*, not a change: on `main`, `npm version patch` bumps `package.json`, syncs `VERSION`, commits, and tags in one step. See [Releasing](./CONTRIBUTING.md#releasing). |
