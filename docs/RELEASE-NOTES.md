# Release notes

## 0.6.19 — local shared ticket status (2026-10-26)

Ticket status can now live on the machine instead of in git. This mode is opt-in:
`"localStatus": { "enabled": true }` in `config.json`. Definitions stay in `board/data.json`:
name, acceptance criteria, touches, gates, test command and epic. Progress moves to one store in
the git common dir, shared by every worktree: status, current and next agent, evidence,
`done_at`, claim and lane state, and whether a ticket is archived. A status change or an archive
move no longer needs a commit, a PR or a resync. Every worktree sees it immediately.
See [Local shared status](./LOCAL-STATUS.md).

- Every read returns the board with the store applied. That covers the `./board` API,
  `maestro ticket`, `maestro validate`, `maestro lanes`, `maestro run`, and the orchestrator,
  which now reads the board through the new `maestro ticket read --json`.
- Writes take one lock shared by all worktrees and install the store with a git ref
  compare-and-swap, so concurrent writers never lose an update. Each change is an append-only
  log entry (`maestro status log`).
- `maestro status sync` writes the store's view into `data.json` and `archive.json` and
  archives done tickets, ready for one daily PR. It writes nothing when nothing changed.
- `maestro status export` and `maestro status import` back up and restore the store. Sync also
  takes a backup before it writes.
- New `./board` exports: `readTicket`, `overlayLocalStatus`, `readLocalStatus`,
  `localStatusLog`, `syncLocalStatus`, `exportLocalStatus`, `importLocalStatus` and
  `DEFAULT_STATUS_FIELDS`.
- `npm test` runs the new `test/` suite.

With the mode off, which is the default, board files, versions and output are unchanged.

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
