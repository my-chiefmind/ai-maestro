# Maestro — repo guidance

This is the **Maestro kit** itself (the framework), not a project managed by it.

## What lives here

- `board/` — the board format (schema) + an example board. Not this repo's own workboard.
- `agents/` — the generic agent roster (source of truth; projects render copies).
- `skills/` — reusable skills (source of truth; projects render copies).
- `render/sync.mjs` — generates a project's `.claude/` from its config + context.
- `scripts/validate-board.mjs` — board integrity check.
- `starters/` — capsules users copy into their repos.
- `docs/` — the method and guides.

## Rules for changing the kit

- **Product-neutral.** No company/vendor/cloud specifics in the core — those belong in a
  project's `context.md` or in examples.
- **Agents and skills carry `name` + `description` frontmatter.** Keep roles non-overlapping.
- **Validate the example board** after touching it: `node scripts/validate-board.mjs board/data.json`.
- **Keep the renderer deterministic** — the lock file must not depend on timestamps.
- Bump `VERSION` on user-visible changes to agents/skills/renderer.
