---
name: "frontend-quality"
description: "Gate frontend changes on quality contracts: a universal build + lint pass, plus opt-in Lighthouse, accessibility (axe), and bundle-size budgets that run only when the project declares them with an explicit command and threshold. The frontend counterpart to a backend test gate. Use before merging any frontend change."
---

# Frontend Quality

Validates frontend changes against quality contracts. Build and lint are **universal** — they
run on every frontend change. Lighthouse, accessibility (axe), and bundle-size budgets are
**opt-in**: they run only when the project has declared them with an explicit command and
threshold, and are otherwise **skipped, not failed**. An unconfigured budget must never block
a merge — a gate nobody agreed to isn't a gate, it's a surprise.

## Universal checks (always run)

### 1. Build

Run the frontend area's test command from `context.md` (the same command the release gate
uses) from the project root.

- Must exit 0 with no type errors.
- A build failure is a blocking defect.

### 2. Lint

- Use the lint command the project wires into its frontend gate (often part of the command
  above, e.g. `npm run lint`).
- **Zero new lint errors.** A change that adds errors is a blocking defect. Pre-existing
  errors on the default branch are not this change's responsibility — but do not add to them.

## Opt-in budgets (run only when declared)

Each budget runs **only** when the project's `context.md` declares it under a
**Frontend quality budgets** heading with a command and a threshold, e.g.:

```markdown
## Frontend quality budgets

- Lighthouse: `npm run lighthouse:ci`, min score 90
- Accessibility (axe): `npm run test:a11y`, zero serious/critical
- Bundle size: `npm run bundle:report`, max 250 KB gzipped
```

When a budget is not declared, record it as SKIPPED and move on.

- **Lighthouse** — run the declared command; fail if the score is below the declared
  minimum.
- **Accessibility (axe)** — run the declared command; fail on any serious/critical
  violation (or the project's declared threshold).
- **Bundle size** — run the declared command; fail if the measured size exceeds the
  declared budget.

## Output

```
=== Frontend Quality ===

Build:         PASS / FAIL
Lint:          PASS / FAIL          (<n> new errors)
Lighthouse:    PASS / FAIL / SKIP   (<score> vs threshold)
Accessibility: PASS / FAIL / SKIP   (<n> serious/critical)
Bundle size:   PASS / FAIL / SKIP   (<size> vs budget)

BLOCKERS:
  - <description>

WARNINGS:
  - <description>

VERDICT: SHIP / BLOCK
```

A SKIP never contributes to BLOCK. A BLOCK sends the ticket back to build with the specific
failure — same contract as the `release-gate` skill.
