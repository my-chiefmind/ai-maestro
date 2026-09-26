---
name: "pipeline-quality"
description: "Validate data-pipeline changes against quality contracts: run the pipeline test suite, verify stage idempotency, check extraction fixtures against expected output, confirm schema fixture coverage, and gate migration safety. Use before merging any pipeline change."
---

# Pipeline Quality

Validates a data pipeline against quality contracts: correctness, idempotency, fixture
coverage, and extraction fidelity. Domain-specific rules (confidence thresholds, fixture
conventions, per-entity checks) belong in the project's `context.md` — this skill carries the
contract every pipeline shares.

## Common contract

### 1. Test suite

Run the pipeline area's test command from `context.md` (the same command the release gate
uses) from the project root.

- Must exit 0.
- Report any failures with test name and failure message.
- Coverage must meet the threshold the project declares in `context.md`, if any.

### 2. Idempotency

For every pipeline stage the change touches:

- Run the stage twice on the same input.
- Assert the second run writes nothing — no new DB records, no file changes, no errors.
- A stage that is not idempotent is a blocking defect.

### 3. Fixture regression

For every extraction fixture in the test suite:

- Run the extractor against the fixture.
- Assert the output matches the expected fixture output exactly.
- A changed fixture output that was not explicitly updated is a blocking defect.

### 4. Schema completeness

For every field in the extraction schema:

- A test fixture must exercise that field with a valid, a null/missing, and an invalid value.
- Fields without fixture coverage are flagged as warnings.

### 5. Migration safety

If the change includes a database migration:

- The downgrade path must be implemented.
- A `NOT NULL` column on a non-empty table requires a server default.
- Run the migration on a throwaway DB: assert upgrade succeeds, run downgrade, assert state
  is restored.

## Domain rules

Read the project's `context.md` for pipeline-specific quality rules — QA/confidence
thresholds, fixture conventions, entity-specific invariants — and apply them alongside the
common contract. A project that only needs to *add* rules should append them in
`custom/skills/pipeline-quality/OVERLAY.md`, which keeps this skill updating underneath; a
project that needs a fundamentally different contract can replace it outright with
`custom/skills/pipeline-quality/SKILL.md`.

## Output

```
=== Pipeline Quality ===

Test suite:      PASS / FAIL   (<n> tests, <m> failures)
Idempotency:     PASS / FAIL   (<stages checked>)
Fixture parity:  PASS / FAIL   (<n> fixtures, <m> mismatches)
Schema coverage: PASS / WARN   (<n> fields, <m> without coverage)
Migration:       PASS / FAIL / SKIP

BLOCKERS:
  - <description>

WARNINGS:
  - <description>

VERDICT: SHIP / BLOCK
```

A BLOCK sends the ticket back to build with the specific failure — same contract as the
`release-gate` skill.
