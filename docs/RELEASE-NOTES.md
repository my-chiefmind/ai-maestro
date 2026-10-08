# Release notes

## 0.6.18 — guarded delivery readiness (2026-10-07)

Guarded delivery adds structured QA, exact-revision delivery gates, separate acceptance and
closure, and optional shared coordination. Configuration and recovery are described in
[Delivery recovery](./DELIVERY-RECOVERY.md).

Existing local workflows remain available, with intentional runner corrections:

- Failed or malformed PR discovery now blocks instead of being treated as no matching PR.
  Restore forge access and inspect existing deliveries before retrying.
- An unreadable or malformed plan blocks eligibility instead of silently dropping scope gates.
- Review defects return to the existing ticket and branch for repair rather than creating an
  automatic blocker ticket. Resume review after pushing the repaired branch.
- Review approval must match the reviewed commit. Guarded QA reports cannot substitute for
  recorded GitHub approvals, and neither substitutes for CI results.
- Staging instructions explicitly target the assigned worktree. Missing or malformed QA
  evidence produces a failed handoff; uncertain dispatch requires verified termination.

The package CI workflow runs tests, upgrade scenarios, starter validation, and version
checks. Required-check enforcement depends on repository rules and has not been enabled by
adding this workflow.

Guarded delivery remains opt-in. Automated legacy migration and a public `./delivery`
package export are follow-up work and are not included in this release.
