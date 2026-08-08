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
3. **Acceptance criteria met.** Every AC from the ticket/plan is satisfied and tested. A
   ticket with **no acceptance criteria at all** is an automatic **no-go** — there is
   nothing verifiable to gate against. Send it back to get ACs written first.
4. **Upstream verdicts verified.** The qa stage returned a pass; on security-sensitive
   surfaces, security-review returned ship; no stage in the plan is incomplete or errored.
   A **missing verdict is a failure, not a pass** — the gate never infers a stage went fine
   because nothing says otherwise.
5. **Mergeable.** The branch merges cleanly onto the default branch; every `depends_on`
   ticket is actually `done`; the diff contains no debug code, leftover secrets, or
   commented-out blocks.
6. **No new warnings/errors** introduced (lint, type-check, console).
7. **Evidence captured.** Record commit SHA + test result on the ticket before archiving.
8. **No human gate bypassed.** If the ticket carries a `human_gate`, it must have been
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
