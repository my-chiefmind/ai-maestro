---
name: "release-gate"
description: "The quality gate a ticket must pass before it lands. Use at the merge/delivery stage to confirm tests are green, upstream verdicts are ship, the diff is scoped and mergeable, and evidence is captured. A red, placeholder, or missing gate blocks the merge — it is never a judgment call."
---

# Release Gate

Run this before any ticket merges. The gate is structural: it either passes or the ticket
becomes a blocker. It **fails closed** — anything missing or unverifiable is a failure, not
a pass.

## The gate

1. **Tests green.** Run the ticket's `testCmd` if set, otherwise the ticket's `area` test
   command. Green means more than exit 0: **no skipped tests masking the change**, and
   coverage at or above the declared threshold if the project declares one. A placeholder
   like "no test command configured" is a **failure**, not a pass — configure a real
   command.
2. **Scope matches the ticket.** The diff does what the ticket says and nothing unrelated.
3. **Acceptance criteria met.** Every AC from the ticket is satisfied and tested. A
   ticket with **no acceptance criteria at all** is an automatic **no-go** — there is
   nothing verifiable to gate against. Send it back to get ACs written first.
4. **The plan's bar is met.** Read the ticket's `traces_to` against `{{BOARD}}/plan.json`
   (`maestro plan show --board {{BOARD}}/data.json`):
   - **Run the invariants.** `maestro plan check --traces <the ticket's traces_to> --board
     {{BOARD}}/data.json`. Every `enforce` command the ticket's plan items declare must exit 0.
     A non-zero exit is a **hard no-go** — not a judgment, not something to weigh against how
     good the change looks, and never something to "fix" by editing the check. That is the
     entire reason the field exists: a rule stated in prose is one an agent can talk itself
     past; a rule that exits non-zero is one it cannot.
   - Every `FR-` it traces to has its `verify` method actually run, and the result recorded.
   - Every `NFR-` it traces to has evidence **against that NFR's stated budget** — the measured
     number, not an assurance. "Should be fast" does not clear `p95 < 300ms`; a p95 you
     measured does. An NFR with no budget in the plan is a **no-go on the plan**, not on the
     ticket: send it to `/plan-update` to get a number, and say so.
   - A ticket whose `traces_to` is empty or points at ids the plan doesn't define should never
     have run — the orchestrator's scope gate should have refused it. Finding one here is a
     **no-go**, and worth reporting as a process failure rather than quietly fixing.
5. **Upstream verdicts verified.** The qa stage returned a pass; on security-sensitive
   surfaces, security-review returned ship; no stage in the plan is incomplete or errored.
   A **missing verdict is a failure, not a pass** — the gate never infers a stage went fine
   because nothing says otherwise.
6. **Mergeable.** The branch merges cleanly onto the default branch; every `depends_on`
   ticket is actually `done`; the diff contains no debug code, leftover secrets, or
   commented-out blocks.
7. **No new warnings/errors** introduced (lint, type-check, console).
8. **Evidence captured.** Record commit SHA + test result on the ticket before archiving.
9. **No human gate bypassed.** If the ticket carries a `human_gate`, it must have been
   cleared by a human — the gate does not clear it.

## Local gate over CI

AI Maestro assumes the gate runs **locally, deterministically** — a single command you can
trust — rather than depending on remote CI. Wire your `area` test commands so that one
command per area gives a trustworthy pass/fail. Keep a known-good baseline; a jump above it
is a regression to fix, not noise to ignore.

## Output

Report the gate as a structured block, not prose — same contract as the `frontend-quality`
and `pipeline-quality` skills:

```
=== Release Gate ===
Ticket: <id>   Branch: <branch>

Tests:                PASS / FAIL
Scope:                PASS / FAIL
Acceptance criteria:  PASS / FAIL   (<n met> / <total>; 0 total = automatic NO-GO)
Plan (traces_to):     PASS / FAIL   (<ids>; FR verify run: <result>; NFR budget: <measured vs bar>)
Plan invariants:      PASS / FAIL   (maestro plan check --traces <ids>: <n> ran, <n> failed)
Upstream verdicts:    PASS / FAIL   (qa: <verdict>; security-review: <verdict or N/A>)
Mergeable:            PASS / FAIL   (conflicts / open deps / debug leftovers)
Warnings/errors:      PASS / FAIL
Evidence:             PASS / FAIL
Human gate:           CLEAR / PENDING / N/A

NO-GO REASONS:
  - <specific blocker>

VERDICT: GO / NO-GO
```

Every line gets a value — an item that could not be checked is FAIL with the reason listed,
never omitted.

## On failure

A failing gate sends the ticket back to build or files a blocker with the specific failure.
Never land a change to hit a schedule — an unverified merge costs more than a late one.
