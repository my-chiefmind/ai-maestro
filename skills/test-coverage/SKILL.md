---
name: "test-coverage"
description: "A focused test pass over a change before it lands. Use on tickets that add or modify behavior — new endpoints, business logic, bug fixes, or refactors. Confirms the change is actually covered by tests, flags gaps with a file:line and the missing case, and blocks landing on untested critical paths."
---

# Test Coverage

Run this on changes that alter behavior: new features, bug fixes, refactors of logic, or
anything touching a critical path. Skip it only for pure docs, comments, or formatting.

## Look for

- **Untested new logic** — new functions, branches, or endpoints with no test exercising
  them. Each new decision point (if/switch/guard) needs at least one test.
- **Bug fix without a regression test** — a fix that doesn't add a test reproducing the
  original bug will silently regress. The test must fail on the old code and pass on the new.
- **Happy-path only** — tests that cover success but not the error, empty, boundary, and
  null/invalid-input cases the code clearly handles.
- **Assertion-free tests** — tests that run code but assert nothing, or assert only that "no
  error was thrown." These give false confidence.
- **Coverage theater** — lines executed by a test but whose behavior is never asserted; high
  line-coverage numbers hiding untested logic.
- **Flaky or order-dependent tests** — reliance on real time, network, randomness, or shared
  mutable state instead of controlled fakes.
- **Broken or skipped tests** — `.skip`, `xit`, commented-out tests, or a failing suite
  shipped as-is.

## Report

For each gap: the **file:line** of the untested code, the **specific case that's missing**
(e.g. "no test for empty cart → expected 400"), and a **concrete test to add** — ideally the
arrange/act/assert outline. Confirm the suite runs green with the project's test command (see
`context.md`) and name the command you ran. Skip demands for tests on trivial or generated
code with no logic.

This pass gates the merge the same way QA and the release gate do: new or changed
critical-path logic without a passing test that covers it blocks landing.
