# Ticket usage — time and tokens per ticket

> What did this ticket actually cost, start to finish, and which agents and models spent it?

AI Maestro doesn't run models itself. It conducts Claude Code and Codex against a board, so the
answer has to come from what those tools already record. This feature assembles it from two
sources and never confuses them:

| | Source | What it gives you | Honesty |
| --- | --- | --- | --- |
| **Measured** | `board/telemetry.jsonl`, written by `maestro run` | Exact stage duration, exact cycle time, and provider-reported token counts | It is a measurement |
| **Reconstructed** | Your local Claude Code session transcripts | Historical time and tokens for work already done | Inferred, with a stated confidence, and labelled *estimated* everywhere it appears |

Ticket totals are **derived** from both. Nothing is written onto the ticket record itself.

---

## Why measurements are runs, not ticket fields

The obvious design is `started_at` / `ended_at` on the ticket. It is wrong. A ticket gets worked
more than once — a dev stage, a reviewer stage, a retry after a failed review, a model swapped
partway, a run resumed days later. All of that has to collapse onto one record, and the moment it
does you have lost the breakdown the dashboard exists to show.

So `board/board.schema.json` is untouched, and each run appends one line to
`board/telemetry.jsonl`:

```jsonc
{ "v": 1, "runId": "run_9f2c…", "ticketId": "T-033", "stage": "dev", "runtime": "claude",
  "model": "opus", "modelId": "claude-opus-5", "sessionId": "…",
  "startedAt": "…", "endedAt": "…", "durationMs": 812345,
  "usage": { "input": 1200, "output": 8400, "cacheRead": 91000, "cacheWrite": 43000, "thinking": 2600 },
  "usageSource": "provider", "outcome": "ok" }
```

Append-only, so two concurrent runs can't lose each other's writes and no lock is needed. The file
is git-ignored and excluded from `npm pack` — it describes one person's local runs.

**Readers must ignore fields they don't know, and writers must never repurpose one.** That is what
lets cost be added later, as a `cost` object on new records, without invalidating a single existing
line — and it is why this kit ships no price table. Rates change, differ per account, and a
subscription has no per-token price at all; a dollar figure computed from today's list price and
yesterday's tokens would be confidently wrong.

A stage that fails is still recorded. A twenty-minute run that then failed is exactly the run you
most want to see.

### Reading what the runtime reports

`scripts/run-stage.mjs` invokes the adapter and appends the record. It is deliberately separate
from `run-ticket.mjs`: the full dev → PR → reviewer pipeline needs a GitHub remote and a second
account's token, so a stage runner that only existed inside it could only be proven by doing
something irreversible.

Claude Code is asked for `-p --output-format json`, whose envelope carries `session_id`,
`duration_ms`, `usage` and a per-model `modelUsage`. **The two usage blocks are spelled
differently** — `usage` uses `input_tokens`, `modelUsage` uses `inputTokens` — and only the
top-level block reports reasoning tokens. So a single-model stage records the top-level block
(counts plus reasoning), and only a stage that spanned several models falls back to
`modelUsage`, where `thinking` is 0 because the runtime does not break reasoning down per model.
Reading one spelling for both wrote a record stamped `usageSource: "provider"` with every
counter at zero, which claims a stage was free; `test/fixtures/claude-json-envelope.json` is a
real envelope kept as a regression.

A caller who passes their own `--output-format` keeps it, and the run is then recorded with no
usage — their flag is an explicit instruction, and instrumentation does not override it.

---

## Reconstructing history from transcripts

Opt-in, off by default, because it reads files outside the repo:

```jsonc
// config.json
"usage": { "scanTranscripts": true }
```

or `MAESTRO_USAGE_SCAN=1` for one command.

Claude Code writes one JSONL per session under `~/.claude/projects/<encoded-cwd>/`, plus one per
subagent with its `agentType` in a sibling meta file — which is where the per-agent breakdown comes
from. Reading is local and read-only.

### Privacy

Everything downstream of the scanner inherits this: the `/api/usage` response, the JSON and CSV
exports, the HTML snapshot and the on-disk cache are all built from the report object, which
holds only counts, durations, ticket ids and board metadata. A test asserts end-to-end that a
secret present in a transcript appears in none of them.

A transcript is the most sensitive file on the disk. `scripts/usage-scan.mjs` is the only code that
opens one, and from each record it keeps **only** timestamps, model ids, token counts, the git
branch, session/agent ids, ticket-shaped identifiers, and board commands reduced to `(verb, id)`.
Message text, tool inputs, tool results and file contents are matched and dropped inside `distill()`.
The on-disk cache holds only that output, so it is aggregate-only by construction rather than by
promise. Mentions are deliberately **not** harvested from tool *results* — reading `archive.json`
into one would otherwise "mention" every archived ticket at once.

### Ticket ids come from the board, not from this reader

Boards choose their own id prefixes — this kit uses `T-`, but other boards use `kit-096` or
`tl-226`. The scanner therefore matches anything ticket-SHAPED (a short prefix, a hyphen,
digits) and attribution accepts it **only if that board defines it**. Being generous in the
match is safe; being narrow is not. A hardcoded `T-` reported 0% of one board's 142 real
tickets as unattributable, which reads as "no work happened here" rather than "this reader only
knows one prefix". Noise like `UTF-8` is matched, carried, and then refused.

### The confidence ladder

Every turn lands with a confidence and the evidence that produced it. A turn that can't be justified
is left unassigned rather than guessed at.

| Confidence | Evidence |
| --- | --- |
| `exact` | A run telemetry record measured it |
| `high` | The git branch names the ticket (`codex/t-029-…`) |
| `high` | The session ran a board write for it (`set-status`, `archive`, `block`, `run`) |
| `medium` | The ticket was named — **and it exists on the board** |
| *unassigned* | Nothing above applied |

Two rules keep this honest, both learned from a naive first pass that credited `T-042` and `T-999` —
a doc example and a test fixture — with 150M tokens between them and looked entirely plausible:

1. **Ids absent from `data.json`/`archive.json` are refused.**
2. **A bare mention never wins on its own.** It expires after 30 minutes or 40 turns. The one
   exception is a session whose entire evidence names exactly one real ticket: with no competitor
   to be confused with, it holds for the session — still `medium`, because one candidate is an
   absence of ambiguity, not proof.

### Why work goes unattributed, and why that's reported

Unattributed usage is shown with its reasons, never spread across tickets — distributing it would
make every row look precise and be wrong.

Unassigned usage is **kept and counted in the totals** — it appears as its own `Unassigned` row
in the ledger, in the CLI table, and in the snapshot. It is never discarded, and never forced
onto a weak match to make coverage look better.

| Reason | What it means |
| --- | --- |
| `no-ticket-in-session` | The session never named a ticket. **A fact about how the work ran**, not a limit of the reading. |
| `before-first-signal` | Turns before the session's first ticket signal. |
| `signal-expired` | The signal went stale with several tickets in play. |

### Time

- **Working time (estimated)** — the sum of gaps between consecutive turns, each capped at 5
  minutes. A transcript timestamp records *when a turn happened*, nothing more: it cannot
  distinguish agent work from a human reading their phone. So this is an inference, it is
  labelled `(est.)` in every surface that shows it, and it drops the label only for the portion
  backed by run telemetry.
- **Elapsed** — first to last turn. Calendar time, which for a ticket picked up across three weeks
  is a very different number.
- **Cycle time** — first measured stage start to last measured stage end. Exact, and computed only
  across measured runs; mixing in an inferred timestamp would put an exact label on an estimate.

### Token categories

Five counters are tracked and shown separately everywhere — table columns, CSV, JSON, snapshot —
because they are billed and cached differently and one blended figure hides which of them a
ticket actually spent:

| Counter | Field | In the total? |
| --- | --- | --- |
| Input | `input` | yes |
| Output | `output` | yes |
| Cache read | `cacheRead` | yes |
| Cache write | `cacheWrite` | yes |
| Reasoning | `thinking` | **no** |

**`total` = input + output + cache read + cache write.** Reasoning is reported by the API under
`output_tokens_details.thinking_tokens` — it is a **subset of output**, so adding it would count
those tokens twice. It is shown in its own column and never summed in.

---

## Using it

```bash
maestro usage                     # the table, plus breakdowns by model/agent/runtime/stage/date
maestro usage --csv tickets       # or model | agent | runtime | stage | date
maestro usage --json
maestro usage --html value.html   # a self-contained, shareable snapshot
```

In the cockpit, the **Value** tab shows the same figures live, with a row per ticket you can expand
for its per-agent and per-model split, and CSV/JSON/snapshot export. `maestro usage`, the exports,
the snapshot and the page all render from one function — `buildUsageReport()` in
`scripts/usage-core.mjs` — so they cannot quote different numbers for the same ticket.

A `maestro run` leaves **both** a telemetry record and a transcript. The record carries its
`sessionId`, so that session is excluded from the transcript pass and the measurement wins; the
count of turns dropped that way is reported as `coverage.skippedExact` rather than silently
swallowed.

## Across every project

```bash
maestro usage --all --registry ~/source/maestro-registry.json
maestro usage --discover ~/source        # ad-hoc, no registry file needed
maestro usage --all --html portfolio.html
```

In the cockpit, start with `--registry <file>` (or `MAESTRO_REGISTRY`) and the Value page gains
an **All projects** toggle: a project table, a `project` breakdown alongside the others, and the
per-ticket table spanning every board.

It is a **merge, not a second aggregation** — each project is measured by the same
`buildUsageReport()` its own page uses, and the rollup only sums the results, so a portfolio
total and a project's own page cannot disagree.

Three things the rollup has to get right, each of which a first pass got wrong:

| Trap | What goes wrong | How it's handled |
| --- | --- | --- |
| **Nested repos** | A group checkout with its own board sits inside a kit that also has one. Both match on a path prefix, so the inner project is counted twice and the outer is credited with work it never did. | Ownership goes to the **deepest** matching root; every project is reported with the others' roots as `excludeRoots`. |
| **The vendored kit dir** | `<project>/maestro` holds `board/data.json`, so it looks exactly like a project. Discovery produced 21 entries all named `maestro`. | The kit dir is **consumed** by the project that owns it and never walked into again. Discovery still descends elsewhere, so a genuinely nested board is not missed. |
| **Same-named projects** | Two groups can each hold an `app`. Keying roots by name collapses them; every duplicate inherits the last one's roots, excludes its own work, and reports a confident zero. | Roots are keyed by **path**. |

A project whose board is nothing but starter samples is **flagged, not dropped** — "this project
exists and no work has been booked to it" is a real answer, and hiding it would repeat the
mistake the unattributed panel exists to avoid.

## Limits worth knowing

- **Codex reports no machine-readable token counts** on its normal `exec` output, so a Codex stage
  is recorded with an exact duration and `usage: null` / `usageSource: "none"`. A zero would read as
  "this stage was free", which is a different and false claim. Codex sessions leave no local
  transcript to reconstruct either, so historical rows are Claude-only.
- **Attribution improves the more the board is used.** Working on a branch named after the ticket,
  or moving it with `maestro ticket set-status`, is what turns a `medium` row into a `high` one.
