# Contributing to AI Maestro

> AI Maestro is an opinionated distillation of a working method, so contributions land best
> when they sharpen the method rather than broaden it.

## Good contributions

| Area | What lands well |
| --- | --- |
| **New reusable skills** | That are genuinely product-neutral (git/CI/release/hygiene). |
| **Agent-roster improvements** | Clearer role boundaries, better handoff contracts. |
| **Renderer / schema fixes** | And validation coverage. |
| **Docs** | Clearer explanations of the method, more worked examples. |

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

## Releasing

**Don't touch the version in a PR.** CI fails any pull request that changes `version` in
`package.json` or the `VERSION` file. A version identifies a *release*, not a change — bumping
per commit produced six versions in two hours, three of which were never published, and left
the file, the git tag, and the npm registry all claiming different numbers.

So a branch carries code, tests, and docs at the version already on `main`. Generated projects
stamp `{{KIT_VERSION}}` from `VERSION`, so an unreleased clone truthfully reports the last
release.

When a batch is ready to ship, from `main`:

```bash
git checkout main && git pull
npm version patch          # or minor — bumps package.json, syncs VERSION, commits "vX.Y.Z", tags it
git push --follow-tags
npm publish                # prepublishOnly re-checks the board and package.json/VERSION parity
```

`npm version` is doing four things at once, which is the point: the file, the commit, and the
tag cannot disagree, and `npm publish` then ships exactly what the tag names. Never hand-edit
the version to release — that skips the tag, and a tagless release is invisible in the history.

To see what's waiting to go out: `git log $(git describe --tags --abbrev=0)..main`.

## Filing issues

> Use the ticket template. If you're proposing a new skill or agent, describe the *role*
> and the *handoff* — what it receives and what it hands off — not just the feature.
