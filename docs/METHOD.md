# The AI Maestro Method

This is the working method AI Maestro packages. It came out of running a multi-repo product
portfolio as a solo operator with AI agents doing most of the implementation. The tools
matter less than the discipline; this doc is the discipline.

## 0. The plan is the boundary

Before the board says *what work is happening*, the plan says **what this project is for and
what it will not do**. It lives in `board/plan.json`: a goal with a metric, a scope with both
halves, and id'd deliverables, use cases, functional and non-functional requirements.

That is not documentation. Every ticket carries `traces_to` naming the plan items it serves, and
the orchestrator **refuses to run a ticket that traces to nothing**, to an id the plan doesn't
define, or to something the plan explicitly excluded. Agents are fast and agreeable; without a
boundary they will cheerfully build whatever the last sentence implied. The plan is where you
decide once, in writing, and have the machinery hold you to it.

The plan reports a completeness percentage, and it is honest about itself: placeholder text
doesn't count as filled, and when a reporting skill finds something the plan doesn't cover it
files a **gap** — required or optional — that holds the percentage down until a human accepts or
declines it. A plan is never finished by being ignored.

Two escape hatches, both deliberate: the gate stays off until the plan names real work, so a new
project isn't refused everything; and a human can write a `scope_exception` on a ticket, which
clears the gate and then shows up in every report so it can't quietly become the norm.

## 1. The board is the source of truth

Chat sessions are volatile. Context windows fill, sessions get reset, you run two in
parallel and forget which did what. So **the durable state of the work lives in
`board/data.json`**, not in any conversation.

- **Epics** group related work into outcomes.
- **Tickets** are the unit of delivery — one independently shippable thing.
- `archive.json` records finished tickets and their verification evidence, so `data.json`
  only ever shows *live* work.

If it isn't on the board, it isn't happening. If it's done, it's archived. A glance at the
board should always tell you the true state.

## 2. Every ticket routes itself to agents and a model

A ticket is not just a description — it's an execution plan the orchestrator can act on
without you:

| Field | Purpose |
| --- | --- |
| `agent_plan` | Ordered pipeline of agent roles, e.g. `["pe", "backend", "qa", "merge"]` |
| `model` | Which model tier the work runs on (`haiku` / `sonnet` / `opus`) |
| `area` | Which part of the system (backend / frontend / infra / docs …) — sets defaults |
| `depends_on` | Tickets that must be `done` before this one is eligible |
| `priority` / `swag` | Ordering and size, for picking what to do next |
| `execution_mode` | `single-agent` for small work, `multi-agent` for a full pipeline |

The point: **the decision of who works a ticket and how expensive it is to run is made once,
when you write the ticket** — not re-litigated every session.

## 3. Work flows through a pipeline, not a hero

No ticket goes straight from idea to `main`. The default flow:

```
pe (plan) → dev (build) → qa (review) → merge (land + archive)
```

- **Plan** (principal-engineer): turns the ticket into a concrete approach before any code.
- **Build** (backend / frontend / devops): implements against the plan, in isolation.
- **QA**: reviews the diff against the ticket's acceptance criteria — an independent pass.
- **Merge / delivery**: lands the change and archives the ticket with evidence.

Review and delivery are *structural stages*, not optional afterthoughts. That's what keeps
quality from depending on you remembering to check.

## 3b. Invariants are checks, not instructions

A rule an agent is *told* to follow is a rule it can talk itself past. "Always scope queries by
tenant" in a brief survives exactly until a model is confident and in a hurry.

So a plan item can carry an **`enforce`** command — something that exits non-zero when the rule
is broken. `verify` describes how a human would check the bar; `enforce` *is* the check:

```sh
maestro plan add nonFunctional --text "No record is written unencrypted" \
  --budget "zero plaintext writes" --enforce "npm run check:encryption"
```

`maestro plan check` runs every one of them — wire it into CI and it holds for human commits
too. The release gate runs the ones a ticket traces to, and a non-zero exit is a **hard no-go**,
not something weighed against how good the change looks. The kit ships the mechanism and no
rules: what must never be violated is a property of your product, not of this framework.

An NFR with a measurable budget but no `enforce` is reported as *checked by judgment* — true,
and worth seeing.

## 4. Isolation by construction — one worktree per ticket

Each ticket runs in its **own git worktree** off a fresh branch. Consequences:

- Parallel tickets never collide.
- A failed or abandoned ticket leaves `main` untouched — you just delete the worktree.
- The "clean up after yourself" step is a first-class skill (`worktree-cleanup`), not a
  manual chore you forget.

See the `git-branch`, `worktree-cleanup`, and `land-and-archive` skills.

## 4b. Lanes — parallelism without a merge pile-up

One worktree means no parallelism. A worktree per ticket means ten or fifteen long-lived
branches whose merge order nobody planned. Merge pain grows with *(branches alive)* ×
*(files they share)* × *(how long they live)*, and the second arrangement maximises all three.

A **lane** is a worktree that runs a *queue* of tickets, landing each before starting the next.
A small fixed pool of lanes inverts every term: branches alive equals the number of lanes (cap
5, default 3) rather than the number of tickets; lanes share no files by construction; and no
lane is ever more than one ticket diverged, because it rebases before each and merges
immediately after.

Two tickets go in **different** lanes only when nothing suggests they touch the same files:

| Signal | Confidence |
| --- | --- |
| `touches` globs on both tickets, disjoint | Highest — the only thing that can override the two below |
| Same `epicId` | Assume shared code |
| Same `area` | Assume shared code |
| A dependency between them | Same lane, always — the dependent builds *on* the other's code |
| Either touches a serial-only file (migrations, lockfiles, generated schema) | Runs **alone**, pool drained first |

Every judgment resolves toward sequential. Being wrong about "related" costs wall-clock; being
wrong about "independent" costs a conflicted merge and possibly destroyed work. Those are not
comparable, so the scheduler never guesses in the expensive direction — and it tells you which
pairs are held back *only* because their file scope is undeclared, since that is the one thing
you can fix.

```sh
maestro lanes plan     # the schedule, and the reason for every decision
maestro lanes next     # exactly what may start this instant
maestro lanes check T-004 T-007
```

Opt in with `orchestration.maxWorktrees`. Left unset, the kit runs one ticket at a time.

## 5. Prod is a separate track — never a blocker on dev

Deployment/release work lives in its own epic and is *gated*. Development work proceeds on
its own epics and **never** waits on a prod step. You don't add a `depends_on` from a dev
ticket to a deploy ticket. Writing release tooling is dev work and stays actionable; only
*running* the release is gated behind a human go-ahead.

This keeps momentum on the build while keeping the finger-on-the-button steps deliberate.

## 6. Delivery hygiene — keep the board honest

Boards rot when every thought becomes a ticket. The rules (see the `delivery-hygiene`
skill):

- One ticket per independently shippable outcome.
- Blocker tickets only when they unlock multiple downstream tickets or need a separate owner.
- Verification stays in the parent's acceptance criteria unless it's a standalone gate.
- Docs and cleanup ride with the parent unless the artifact *is* the deliverable.
- Migrations/refactors get an explicit fan-out budget up front.

## 7. Human gates where judgment is required

Some steps should never be auto-picked: releasing to production, deleting something
irreversible, spending real money, touching customer data. Those carry an explicit
`human_gate` on the ticket; the orchestrator skips them until a human clears them.

Autonomy inside the guardrails; a hard stop at the guardrails.

## 8. The Agile lineage — adapted for a solo operator

This method is Agile delivery, re-fitted for its actual team shape: **one human
conducting AI agents**. It is not a Jira clone or a generic ticketing system — the board
exists to drive *incremental, testable, gated delivery*, not to catalogue work.

What carries over from Agile directly:

- **Small shippable increments.** The ticket definition — one independently shippable
  outcome — *is* the Agile increment. One lands per run.
- **Working software as the measure of progress.** Done means passed QA and archived with
  verification evidence, never "I think it's finished."
- **Built-in quality.** QA and delivery gates are pipeline structure, not discipline you
  have to summon.
- **Flow over timeboxes.** Kanban-style pull: the orchestrator takes the next unblocked
  ticket by priority. Reprioritizing costs nothing because there is no sprint commitment
  to protect.
- **Simplicity.** The hygiene rules (§6) are "maximize the work not done" made concrete.

What is deliberately adapted, because the ceremonies assume a team:

- **Stand-ups, sprint planning, sprint reviews** collapse into the **between-ticket
  checkpoint** — the orchestrator stops after every landed increment and you review
  before starting the next.
- **Self-organizing team** becomes **self-routing tickets**: the who/how/cost decision is
  made once, when you write the ticket, instead of re-negotiated in meetings.
- **Customer collaboration** is you — the solo operator is also the product owner, so
  epics group tickets into the outcomes you'd otherwise demo to a stakeholder.

---

That's the whole method: **a durable board, self-routing tickets, pipeline delivery,
isolated worktrees, a gated prod track, honest hygiene, and Agile increments at solo
scale.** AI Maestro is just the scaffolding that makes it easy to run.
