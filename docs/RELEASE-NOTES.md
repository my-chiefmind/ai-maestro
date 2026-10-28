# Release notes

## 0.6.20 — safe updates for vendored kits, opt-in delivery rules (2026-10-27)

`update` no longer drops your edits to kit files, and several rules projects had patched into
their vendored kit are now part of the kit, opt-in. See
[Kit upgrades and opt-in delivery rules](./KIT-UPGRADES.md).

Updates:

- Kit files outside `board/`, `agents/` and `skills/` are refreshed with a 3-way merge instead of
  being replaced. An edited script keeps your change and gains the release's; a conflicting edit
  gets conflict markers, and the update stops before re-rendering until you resolve it and
  re-run. The vendor lock now records a hash per vendored file, and
  `maestro/.maestro-vendor-base/` keeps the pristine copy of each file you edited. `--base <dir>`
  supplies the previous release when it cannot be found locally; otherwise it is fetched from npm.
- The vendored CLI updates its own kit: `node maestro/bin/cli.mjs update` no longer stops at
  "no update channel". `--from <dir>` updates from a local kit copy. A plain (non-git, non-npm)
  copy of the kit finds `./maestro` without `--kit`.
- A `kitSource.path` that names no kit no longer breaks `sync` or the usage hook: `sync` falls
  back with a warning and `update` rewrites it to the vendored kit (`"."`).
- `maestro validate` with no path finds `maestro/board/data.json` from the repo root.

Board:

- `maestro ticket add` and `edit` take `--touches` as a JSON array or a comma list, and refuse a
  malformed value. The board API refuses a string or quoted fragments too; the validator warns.
- New `maestro ticket edit-many --changes-file <json>` and `editTickets()`: several edits in one
  validated, all-or-nothing write.
- Opt-in `ticketReadiness`: `gates` and `inputs` on every live ticket, no `todo`/`in-progress`
  while an owner input is missing, and a creation checklist for `add` and `import`
  (`gatesAndInputsIssues`, `ticketCreationIssues`). `failureKind` accepts `external`.
- Opt-in board merge driver: `maestro merge-driver install` merges `data.json` and
  `archive.json` by ticket id in git.

Swarm and lanes:

- `orchestration.maxWorktrees` accepts `"unlimited"` in the validator, `maestro lanes`, and
  `maestro swarm enable --worktrees unlimited`. Numeric values keep the 1–5 range.
- Exclusive merge lock: `maestro swarm lock` / `unlock` and `acquireMergeLock`,
  `releaseMergeLock`, `withMergeLock` in `scripts/swarm-core.mjs`. One merge at a time across all
  worktrees of a checkout. **Behaviour change for `autoMerge: true`:** `effectiveAutoMerge` is now
  true in any git checkout, so a requested auto-merge that was fail-closed becomes effective.
  Run `maestro swarm enable --no-auto-merge` before updating if you do not want that.

Checks:

- Opt-in `maestro check process-ratio` and `maestro check evidence-budget`, configured by
  `config.json` `checks`.

Projects that opt into nothing see the same board validation and output as 0.6.19, apart from
the warning for malformed `touches`.

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
