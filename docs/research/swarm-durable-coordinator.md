# Research spike: a durable swarm coordinator

Status: research only (T-039). No dependency, no production code. This note extends the
[Reuse decision](../SWARM.md#reuse-decision) of 10 September 2026, which deferred Temporal to a
future durability ticket. Versions below were checked on 25 September 2026.

## Constraints any answer must meet

- **Opt-in, off by default.** A durability layer is enabled by project configuration; with it
  off, the swarm behaves exactly as `docs/SWARM.md` describes today.
- **Graceful degradation.** If the layer is absent, misconfigured, or its lease/journal is
  unreadable, the coordinator falls back to the current attended, single-session mode and says
  so. It never blocks board writes or delivery.
- **No new mandatory service or secret (NFR-5).** Anything needing a server, database, or
  credential may only be an optional adapter, never a requirement of the kit.
- Runtime parity (Claude Code and Codex) and Node 18+ with zero runtime dependencies.

## (a) Restart recovery of in-flight tickets, worktrees and agent slots

**What exists.** The board is the durable record: a claimed ticket is `in-progress` with
`currentAgent`/`nextAgent` coordination fields, written atomically under the board lock.
Worktrees and branches are durable on disk (`git worktree list`). What is lost on a crash is
the coordinator's in-memory view: which harness agent owned which slot, and whether it was
mid-step.

**Maestro-native.** Recover by *reconciliation*, not replay. On start, the coordinator joins
three facts: `in-progress` tickets on the board, `git worktree list` plus branch heads, and the
live harness agent inventory. Each in-progress ticket falls into one bucket: live agent (leave
it), worktree with commits but no agent (re-dispatch the same role into the same worktree),
worktree with no commits (re-dispatch fresh), no worktree (reset to `todo` via
`maestro ticket set-status`; `set-status` has no reason flag today, so follow-up 1 adds one). Slots are never persisted: they are
recomputed from inventory, so there is nothing to corrupt. Agents are idempotent at the
ticket level because each writes to its own branch.

**Temporal.** Workflow history replays the coordinator exactly, including timers and
retries. The fit is poor at the edges that matter: worktrees, harness agents and the board are
external side effects, so every one must become an idempotent Activity anyway, which is the
same reconciliation logic plus a server.

**Other: none needed.** A journaled state machine library would add the same replay semantics
with the same external-effect problem.

## (b) Can two coordinators claim one ticket?

**What exists.** `maestro ticket claim <id>` (`claimTicket` in `scripts/board-api.mjs`) runs
inside `mutateBoard`: it takes the `.board.lock` (created with `open(..., "wx")`, atomic
create-if-absent, `scripts/board-io.mjs`), re-reads the board from disk, re-checks
eligibility, and only then transitions to `in-progress`. A second claimer sees
`in-progress`, finds the ticket ineligible, and gets `claimed: false` without writing. Optional
`--expect-version`/`--expect-archive-version`/`--expect-plan-version` refuse a claim made from
a stale snapshot.

**Experiment (disposable, not committed).** Eight concurrent claims on a copy of the starter
board in a scratch directory:

```sh
REPO=$(pwd); S=/private/tmp/claude-501/t039-race; mkdir -p $S && cp -R starters/orchestrated-project/board $S/ && cd $S
for i in 1 2 3 4 5 6 7 8; do (node $REPO/scripts/board-write.mjs claim T-001 \
  --board board/data.json --current-agent coord-$i --json > out-$i.json 2>&1; \
  echo "coord-$i exit=$?" >> exits.txt) & done; wait
```

Output: all eight exited 0; `"claimed":true` exactly once, `"claimed":false` seven times; the
board ended `in-progress` with `currentAgent: coord-2`. No lost update, no double claim.

**Remaining race windows.**

1. *Stale-lock steal.* A lock older than `LOCK_STALE_MS` (30 s) is deleted and retaken. A holder
   paused longer than that (suspend, debugger, overloaded CI) can resume and write after a
   second writer took the lock. The version check inside `mutateBoard` narrows this but is not
   a fence. Board mutations are sub-second, so this needs a pathological pause.
2. *Non-shared filesystem.* The lock is local-file atomicity. Two coordinators on different
   hosts with separate checkouts each hold their own board; the claim is only exclusive per
   copy. Cross-host exclusivity needs a shared arbiter (the git remote, see (d)).
3. *Claim-then-crash.* A claim is durable before any work starts; recovery is (a).

**Temporal / other.** A single-workflow-per-ticket id in Temporal gives cross-host
exclusivity but only by adding the server. For the local contract the existing lock is
sufficient; no candidate is needed.

## (c) Merge serialization without concurrent merges or rebase storms

**Maestro-native.** Treat merging as a single-consumer queue owned by the leader (d): one PR at
a time, in board priority order. Before merging, rebase or update only the head of the queue,
re-run its gate, merge, then advance. Tickets behind it are not rebased until they reach the
head, so a landing change triggers one rebase, not N. File-scope lanes already keep
concurrent tickets mostly disjoint, which keeps that single rebase cheap. When
`effectiveAutoMerge` is false the queue stops at "ready" and waits for a human, as today.

**Temporal.** A per-repository workflow can serialize merges with signals; correct but heavy
for a queue of length one to five.

**Other: the forge's native merge queue** (for example GitHub merge queue). It batches, rebases
and re-tests server-side and is the best answer where available, but it is host-specific and
often a paid-plan feature; it should be an optional adapter behind the native queue, not the
design (product-neutral rule).

## (d) Unattended single-coordinator wake-up without a daemon

**Maestro-native.** A *tick* command, run by whatever scheduler the project already has, that
does one bounded pass: acquire lease, reconcile (a), claim and dispatch up to the free slots,
advance the merge queue (c), release or renew the lease, exit. Schedulers are adapters only:
cron, launchd, systemd timers, a CI scheduled workflow, or a harness scheduled task.

**Leader lease.** Store the lease as a board-directory file written through the same lock:
`{holder, host, pid, expiresAt}`. A tick takes the lease if absent or expired, renews it if it
holds it, and otherwise exits 0 as a no-op. TTL must exceed the tick interval plus the longest
tick; the holder must re-check the lease before each side effect (claim, merge) so an expired
leader stops rather than racing. Across hosts the arbiter is the git remote: publish the lease
as a ref update (`git push` with `--force-with-lease` against the expected old value), which
is a compare-and-swap the remote enforces, with no new service or secret beyond the push
access the coordinator already needs.

**Temporal.** Schedules plus workers give exactly-once wake-up, but a worker is a daemon and
the server is a mandatory service: it violates NFR-5 unless optional.

**Other: pg-boss.** Singleton and cron jobs on Postgres; still a mandatory database, and its
current release requires Node 22.12+, above the kit's Node 18 floor.

## Comparison

| Option | Version (pinned) | License | Fit | Security | Maintenance | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| Maestro-native (lock + claim + lease file/ref + tick) | kit `main` | kit license | All four questions; zero deps | No new secret; uses existing git push access | Ours; small surface (reconcile, lease, queue) | None |
| [Temporal TS SDK](https://www.npmjs.com/package/@temporalio/client/v/1.24.0) + [Temporal server](https://github.com/temporalio/temporal/releases/tag/v1.32.0) | SDK 1.24.0 (15 Sep 2026); server v1.32.0 (11 Sep 2026) | MIT / MIT | Strong durable replay; side effects still need idempotent activities; needs worker daemon | New service, network port, and (for cloud) API key/mTLS secret | Active; large dependency tree incl. native core | Self-host ops, or paid cloud |
| [pg-boss](https://www.npmjs.com/package/pg-boss/v/12.34.0) | 12.34.0 (23 Sep 2026) | MIT | Singleton/cron jobs only; not recovery or merges | Mandatory Postgres + credentials | Active; Node >= 22.12 | Database hosting |
| Forge merge queue (question c only) | host-managed | proprietary service | Best-in-class for (c) where offered | Host token already used for PRs | Vendor | Often plan-dependent |

## Verdict: adapt

Build a thin, opt-in durability layer on existing primitives: reconcile-on-start, the proven
`maestro ticket claim`, a leased leader, and a single-consumer merge queue, woken by any
scheduler through one tick command. Do not adopt Temporal: it answers (a) and (d) well but
only by adding a mandatory service and daemon, and it still leaves side-effect idempotency to
us. Revisit Temporal only if a project needs multi-host fan-out beyond one leader.

## Proposed e7 follow-ups (not filed; no board edits made by this spike)

1. **Coordinator reconcile-on-start** (swag: S). ACs: classifies every `in-progress` ticket into
   live/resume/restart/reset from board + `git worktree list` + agent inventory; resets use
   `maestro ticket set-status`, which gains a `--reason` flag recorded on the ticket; dry-run prints the plan; tests cover all four
   buckets.
2. **Leader lease** (swag: M). ACs: lease file under the board lock with holder/expiry; take,
   renew, expire, and no-op paths tested; optional git-ref CAS mode for multi-host; claim and
   merge re-check the lease; off by default.
3. **`maestro swarm tick`** (swag: M). ACs: one bounded pass (lease, reconcile, dispatch, merge
   queue step), exit 0 as a no-op when not leader; documented cron/launchd/systemd/CI/harness
   examples; no daemon; disabled unless configured; degrades to attended mode with a message.
4. **Single-consumer merge queue** (swag: M). ACs: only the queue head is rebased and re-gated;
   respects `effectiveAutoMerge`; one merge at a time; optional forge-queue adapter.
5. **Stale-lock fencing** (swag: S). ACs: a writer whose lock was stolen detects it before
   rename (token check) and aborts with exit 2; regression test with an induced pause.
