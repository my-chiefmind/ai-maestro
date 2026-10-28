# Swarm mode

Swarm mode is Maestro's optional policy for continuously replenishing a bounded agent pool.
It reuses the board, lane scheduler, specialist roster, QA/delivery gates, worktree lifecycle,
and serialized landing rules already shipped by Maestro. It is disabled by default.

```sh
maestro swarm enable --agents 10 --worktrees 5 --wave-minutes 30
maestro swarm enable --auto-merge
maestro swarm status
maestro swarm disable
maestro swarm lock --holder <id> [--ticket T-123] [--pr <url>] [--pid <n>]
maestro swarm unlock --holder <id>     # or --force to break a lock
```

Enabling stores policy in `config.json`; `--agents 10` targets ten active workers plus one
coordinator. It does not install a daemon or exceed the active agent harness's concurrency
limit. Run the rendered `$swarm` skill in Codex or `/swarm` in
Claude. For unattended operation, arrange for one supported host scheduler to wake one
coordinator. The board and lane worktrees are its recovery state.

The invoking swarm session is the executor. It does not create an `orchestrator` agent per
lane. It reads the lane plan, then directly delegates planning to `principal-engineer`, build
work to the ticket's implementation agent, independent review to `qa`, and delivery approval
to `principal-delivery`. It discovers capacity from the host's live-agent inventory and spawn
results; the configured target is never presented as measured capacity.

`--worktrees` takes an integer from 1 to 5, or `unlimited`, which opens a lane for every
independent ticket (`orchestration.maxWorktrees: "unlimited"`). The lane scheduler still keeps
tickets that may touch the same files in one lane.

## Merge lock

Since 0.6.20 the kit ships an exclusive merge lock: one merge at a time across every worktree of
a checkout. It is a file, `maestro-merge.lock`, created atomically in the checkout's common git
directory, so every worktree sees it and no commit contains it.

- `maestro swarm lock --holder <id>` takes it or exits 3 when another merge holds it (retry on
  the next wave); `maestro swarm unlock --holder <id>` releases it. Only the holder that took it
  can release it, unless `--force`.
- A lock whose recorded holder process (`--pid`) has exited is stale and is retaken. A lock with
  no pid is stale after an hour. A lock whose holder is still running is never broken.
- A merge script can hold the lock in its own process instead: `acquireMergeLock`,
  `releaseMergeLock` and `withMergeLock` from `scripts/swarm-core.mjs`.

`autoMerge` records intent. `maestro swarm status --json` reports `effectiveAutoMerge: true` only
when `autoMerge` is on and the checkout has the lock (any git checkout does), and reports the lock
under `runtime.mergeLock` (`available`, `held`, `holder`, `stale`). Outside a git checkout it stays
`false` and approved PRs wait for a manual merge. Every automatic merge takes the lock first and
releases it afterwards; the swarm skill's merge rules below still apply.

Projects that set `autoMerge: true` on 0.6.19 or earlier: that request was fail-closed until
now and becomes effective on upgrade. Run `maestro swarm enable --no-auto-merge` first if you do
not want agents to merge.

## Reuse decision

**Need.** Keep a delivery pool occupied, rebalance implementation/QA/repair work, enforce time
budgets, and land gated changes without creating an unsafe merge pile-up.

**Baseline.** Maestro already owns board scheduling, conservative file-scope lanes, atomic board
writes, worktrees, role routing, QA, delivery, and merge rules. The missing behavior is the
coordinator policy and an enable/disable configuration surface.

**Options checked on 10 September 2026.** [Temporal TypeScript SDK
1.23.0](https://github.com/temporalio/sdk-typescript/releases/tag/v1.23.0) is MIT-licensed and
provides durable distributed workflows, but requires a Temporal service and worker runtime.
[LangGraph 1.2.11](https://pypi.org/project/langgraph/1.2.11/) (MIT, Python 3.10+) provides
durable stateful agent graphs. The Rust [`ai-agents`
1.0.4](https://docs.rs/crate/ai-agents/1.0.4) (Apache-2.0, Rust 1.88+) supplies its own agent
runtime and orchestration, while its generalized background scheduler is not a shipped v1
contract. GitLab searches found platforms or early projects rather than a dependency-free
adapter for Maestro's local board/worktree protocol. No separate package from npm, PyPI,
crates.io, GitHub, or GitLab fits without replacing the existing scheduler or adding a
service/runtime.

**Decision: adapt.** Add a dependency-free skill and configuration command over Maestro's
existing primitives. Do not add another orchestration framework. This preserves the kit's Node
18+ deployment, has no new transitive dependencies, install scripts, telemetry, network
permissions, license obligations, or service fees. No package experiment or vulnerability scan
is needed because none of the candidates is installed or executed. A future
durability ticket may evaluate Temporal if customers require crash-proof multi-host execution;
that is outside this skill's local coordinator contract.
Durability follow-up (T-039): see [research/swarm-durable-coordinator.md](./research/swarm-durable-coordinator.md).

## Example: one two-lane wave

1. The swarm session reads `maestro lanes next`; it returns `T-201` and `T-202` on two safe
   lanes. Live harness inventory shows three free worker slots.
2. The session spawns `backend-developer` for `T-201` and `frontend-developer` for `T-202`; it
   remains the coordinator and does not spawn an `orchestrator`.
3. `T-201` finishes first. The coordinator uses the freed slot for `qa`, waits for the verdict,
   then assigns `principal-delivery`. `T-202` continues independently.
4. Delivery approves `T-201`. With `effectiveAutoMerge: false` the PR enters the manual merge
   queue; with `true` the coordinator takes the merge lock, merges, and releases it. The coordinator can assign the newly
   free worker slot to QA for `T-202`.
5. After an authorized one-at-a-time merge, the coordinator archives `T-201`, recomputes lanes,
   and fills only capacity the harness actually reports.

**Validation and ownership.** `test/swarm.test.mjs` covers defaults, preservation, limits, the
session-owned execution contract, truthful capacity reporting, and fail-closed auto-merge.
Maestro maintainers own policy upgrades; host operators own model cost, credentials, scheduler
availability, and production approvals.
