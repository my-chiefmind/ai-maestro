# Model routing

Maestro routes each ticket to a model tier so you spend big-model budget only where
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

- **Per ticket:** the `model` field (highest precedence).
- **Per area / default:** your project's `context` file can set floors and defaults per
  `area` so tickets inherit a sensible tier.

## A caveat worth knowing

If your harness has a "fork current agent" mode that inherits the parent's model, a
per-ticket `model` override may be ignored for that sub-agent — it'll silently run on the
parent's model. When a ticket must run on a specific (cheaper or pricier) tier, dispatch it
as a fresh agent with the model set explicitly rather than forking.
