# Model routing

AI Maestro routes each ticket to a model tier so you spend big-model budget only where
judgment actually pays off. The routing decision is made **once, on the ticket** (the
`model` field), and the orchestrator honors it when it dispatches each stage.

## Tiers

| Tier | Use for |
| --- | --- |
| `haiku` | Cheap, mechanical, well-specified work: rename sweeps, docstring passes, simple config edits, high-volume extraction with a fixed shape. |
| `sonnet` | The default. Most feature work, most reviews, most refactors. |
| `opus` | Judgment-heavy or high-blast-radius work: architecture, data migrations, security-sensitive changes, ambiguous specs, cross-cutting refactors. |

## Rules of thumb

- **Default to `sonnet`.** Only drop to `haiku` when the task is genuinely mechanical and
  fully specified; only reach for `opus` when a mistake is expensive or the path is unclear.
- **Never run review or delivery gates on the cheapest tier.** QA and principal-delivery are
  where an independent, capable pass earns its keep — keep them at `sonnet` or above.
- **The plan stage can outrank the build stage.** It's often worth planning on `opus` and
  building on `sonnet`: get the approach right cheaply-per-token where it matters most.
- **Floor by area.** Give risky areas (infra, auth, migrations) a higher default floor in
  your project config so a mistuned ticket can't quietly downgrade them.

## Where it's configured

- **Per ticket:** the `model` field — the ticket's baseline tier.
- **Per area / default:** `config.json` → `model.default` and `model.floors` (e.g.
  `{ "infra": "opus" }`).

The **effective model** a ticket runs on is the **stronger** of its own `model` and its area's
floor — a floor can *raise* a ticket but never lower it. The orchestrator applies this (the
policy is baked into the generated `CLAUDE.md` and `AGENTS.md`), and `validate-board` warns when a ticket's
`model` sits below its area floor.

## A caveat worth knowing

If your harness has a "fork current agent" mode that inherits the parent's model, a
per-ticket `model` override may be ignored for that sub-agent — it'll silently run on the
parent's model. When a ticket must run on a specific (cheaper or pricier) tier, dispatch it
as a fresh agent with the model set explicitly rather than forking.

In Codex, Maestro keeps the current model by default and maps these portable workload tiers to
reasoning effort: `haiku` → low, `sonnet` → medium, `opus` → high. Project-scoped Codex agent
files intentionally omit `model`, so they inherit the parent unless the caller explicitly
selects another model at dispatch time.

## Independent dev/reviewer models and runtimes

A ticket's `model` is one tier for its whole `agent_plan`. A ticket can instead run its
implementation and its review as independently chosen roles — different model, different
runtime, or both — via `dev_runtime`/`dev_model` and
`reviewer_runtime`/`reviewer_model`, dispatched with `maestro run <ticket-id>`. See
[CROSS-REVIEW.md](./CROSS-REVIEW.md). These per-role model fields accept either a portable
tier or a runtime-specific model id. The bundled Codex adapter maps portable tiers to
reasoning effort and passes any other value as `codex exec -m <model>`.
