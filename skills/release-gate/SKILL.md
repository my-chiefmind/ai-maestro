---
name: "release-gate"
description: "The quality gate a ticket must pass before it lands. Use at the merge/delivery stage to confirm tests are green, the diff is scoped, and evidence is captured. A red or placeholder gate blocks the merge — it is never a judgment call."
---

# Release Gate

Run this before any ticket merges. The gate is structural: it either passes or the ticket
becomes a blocker.

## The gate

1. **Tests green.** Run the ticket's `testCmd` if set, otherwise the ticket's `area` test
   command. A placeholder like "no test command configured" is a **failure**, not a pass —
   configure a real command.
2. **Scope matches the ticket.** The diff does what the ticket says and nothing unrelated.
3. **Acceptance criteria met.** Every AC from the ticket/plan is satisfied and tested.
4. **No new warnings/errors** introduced (lint, type-check, console).
5. **Evidence captured.** Record commit SHA + test result on the ticket before archiving.
6. **No human gate bypassed.** If the ticket carries a `human_gate`, it must have been
   cleared by a human — the gate does not clear it.

## Local gate over CI

Maestro assumes the gate runs **locally, deterministically** — a single command you can
trust — rather than depending on remote CI. Wire your `area` test commands so that one
command per area gives a trustworthy pass/fail. Keep a known-good baseline; a jump above it
is a regression to fix, not noise to ignore.

## On failure

A failing gate sends the ticket back to build or files a blocker with the specific failure.
Never land a change to hit a schedule — an unverified merge costs more than a late one.
