# Contributing to AI Maestro

> AI Maestro is an opinionated distillation of a working method, so contributions land best
> when they sharpen the method rather than broaden it.

## Good contributions

| | Area | What lands well |
| :--: | --- | --- |
| 🧰 | **New reusable skills** | That are genuinely product-neutral (git/CI/release/hygiene). |
| 🎭 | **Agent-roster improvements** | Clearer role boundaries, better handoff contracts. |
| 🔧 | **Renderer / schema fixes** | And validation coverage. |
| 📚 | **Docs** | Clearer explanations of the method, more worked examples. |

## Ground rules

| Rule | Detail |
| --- | --- |
| **Keep it product-neutral** | No company-, vendor-, or cloud-specific assumptions baked into the core — put those in examples or a project's own `context` file. |
| **One concern per PR** | Small, reviewable changes. |
| **Skill layout** | Skills follow the `skills/<name>/SKILL.md` layout with `name` + `description` frontmatter. |
| **Agent layout** | Agents follow the `agents/<name>.md` layout with `name` + `description` frontmatter. |
| **Validate the board** | Run `node scripts/validate-board.mjs board/data.json` before pushing board changes. |

```bash
node scripts/validate-board.mjs board/data.json
```

## Filing issues

> Use the ticket template. If you're proposing a new skill or agent, describe the *role*
> and the *handoff* — what it receives and what it hands off — not just the feature.
