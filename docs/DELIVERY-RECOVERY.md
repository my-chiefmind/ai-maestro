# Guarded delivery recovery

Guarded delivery is enabled by project configuration (`delivery.enabled: true`). Its
`delivery.coordination` defaults to `local`; `git` enables shared coordination. If shared
coordination is unavailable, restore access before protected operations. Do not disable it
to bypass uncertain ownership.

Board APIs default to `config.json` one directory above the board directory. Use the
`configPath` API option or the CLI's `--config /absolute/path/config.json` override for a
nondefault configuration. `delivery.requireWorktree` is optional: primary-checkout write
restrictions apply when guarded delivery and this policy are enabled. The delivery CLI's
`--execution-repo /absolute/path/worktree` selects the execution checkout; it must share
the board repository's Git directory. This supports a local-only board in the primary
checkout without copying it into each worktree.

## Verification commands are trusted executable configuration

Ticket `testCmd`, area test commands, `delivery.checks`, and traced plan `enforce` commands
run through a shell in the execution worktree. They are project-authored executable code,
not untrusted data or sandboxed expressions. Review changes to those commands and the
configuration before enabling or invoking delivery. The gate binds the effective commands
to the reviewed contract and rejects changed inputs; that binding does not make a dangerous
command safe. Never turn review text or external output directly into a check command.

## Inspect before retrying

Use the same board, config, and execution checkout as the interrupted run:

```sh
maestro delivery status T-123 --board /project/board/data.json \
  --config /project/config.json --execution-repo /worktrees/T-123 --json
```

Inspect `record.ownerSessionId`, `record.generation`, `record.state`, and
`record.dispatch.attemptId`. A dispatch with no `stoppedEvidence` is running or uncertain,
including when a spawn times out before acknowledgment. Preserve its worktree and logs.
Do not launch a replacement, clear the ledger, force a ref, or infer termination from age.

## Confirm an uncertain dispatch stopped

Identify the exact recorded attempt in the runtime's session/process records. If it is
running, stop it through that runtime and verify termination. If it never started, obtain
positive evidence from the runtime's dispatch records. Missing logs alone are insufficient.
A trusted API harness adapter can resolve the attempt synchronously; CLI recovery uses a
project-maintained `delivery.trustedDispatchEvidence` entry instead.

After verifying the runtime outcome, an authorized project operator may add this example
entry to the trusted config (merge it into existing delivery settings). Replace all sample
values with the observed attempt and actual durable evidence:

```json
{
  "delivery": {
    "trustedDispatchEvidence": {
      "recovery-123": {
        "attemptId": "actual-dispatch-attempt-id",
        "state": "stopped",
        "evidence": "Runtime session abc termination confirmed; evidence: /retained/logs/abc.txt"
      }
    }
  }
}
```

Use `not-started` only when the runtime positively confirms that outcome. This config is a
trust boundary: writing an assertion into it is not itself proof that a process stopped.
Then record the verified stop using the current owner and generation from `status`:

```sh
maestro delivery dispatch-stop T-123 --board /project/board/data.json \
  --config /project/config.json --execution-repo /worktrees/T-123 \
  --owner actual-owner-session --generation 1 \
  --attempt-id actual-dispatch-attempt-id --evidence recovery-123 --json
```

Read `status` again and confirm `stoppedEvidence` is present before resuming the appropriate
stage. A stale generation or mismatched attempt is rejected. There is no timeout takeover or
force-clear recovery command. If termination cannot be established, the dispatch remains
blocked. Ownership transfer additionally requires a trusted scoped transfer approval.

## Missing or malformed QA evidence

The reviewer is asked to write a JSON report at a specific path under the Git common
directory's `maestro/reviews` folder. Inspect the reported path, runtime logs, permissions,
and report contents. A missing, unreadable, malformed, or structurally invalid report is a
failed handoff, never approval. Preserve the original report for diagnosis. Have the
independent reviewer produce a valid report for the current committed head and delivery
contract; do not manufacture passing results or copy evidence from a different revision.
If the reviewer dispatch itself is uncertain, resolve its termination first as above.

For failed or blocked QA, repair the existing ticket and branch, then obtain fresh independent
QA. For acceptance failure after merge, use the explicit `acceptance-failed` and `repair`
transitions on that ticket; a merged PR does not close outstanding acceptance obligations.
