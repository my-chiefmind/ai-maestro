# Contributing to Maestro

Maestro is an opinionated distillation of a working method, so contributions land best
when they sharpen the method rather than broaden it.

## Good contributions

- **New reusable skills** that are genuinely product-neutral (git/CI/release/hygiene).
- **Agent-roster improvements** — clearer role boundaries, better handoff contracts.
- **Renderer / schema fixes** and validation coverage.
- **Docs** — clearer explanations of the method, more worked examples.

## Ground rules

- Keep it **product-neutral**. No company-, vendor-, or cloud-specific assumptions baked
  into the core — put those in examples or a project's own `context` file.
- **One concern per PR.** Small, reviewable changes.
- Skills follow the `skills/<name>/SKILL.md` layout with `name` + `description`
  frontmatter.
- Agents follow the `agents/<name>.md` layout with `name` + `description` frontmatter.
- Run `node scripts/validate-board.mjs board/data.json` before pushing board changes.

## Filing issues

Use the ticket template. If you're proposing a new skill or agent, describe the *role*
and the *handoff* — what it receives and what it hands off — not just the feature.
