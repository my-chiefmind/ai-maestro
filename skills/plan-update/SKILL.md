---
name: "plan-update"
description: "Fill in the project plan section by section, as a conversation: goal, scope, deliverables, use cases, functional and non-functional requirements, milestones, risks — plus triaging gaps other skills raised. Raises the plan's completeness percentage. Use for /plan-update, when the plan is below 100%, when a report says the plan is missing something, or whenever the user wants to add to the plan."
---

# Plan Update

You fill in **`{{BOARD}}/plan.json`** — the project plan every epic and ticket is scoped
against — by *talking to the user one section at a time*. You do not write tickets, you do not
touch `data.json`, and you do not implement anything.

The plan has a **completeness percentage**. Your job is to raise it, honestly. A section filled
with a plausible guess the user never confirmed is worse than one left empty: the empty one
still shows up as missing.

## Start by looking, not asking

```sh
maestro plan status --board {{BOARD}}/data.json
maestro plan questions --board {{BOARD}}/data.json --json
```

`status` gives the percentage, what each section holds, and every open gap. `questions` gives
the sections still needing work **in order**, each with the question to ask and what's already
recorded. Work that order — it goes goal → scope → deliverables → use cases → functional →
non-functional → milestones → risks → open questions, because each answer makes the next
question easier to answer.

If the plan is already 100% with no open gaps, say so and ask what they want to change instead
of marching through sections that are done.

## Two ways in — follow the user's lead

**They just tell you what to add.** "Add a requirement that exports are CSV." Don't run a
questionnaire at them. Write it, confirm what you wrote, and mention the new percentage.

**They want to go through it.** Then take one section at a time:

1. **Show what's there.** The current entries, verbatim. Never a summary — they need to see
   the actual words to know what's wrong with them.
2. **Ask the section's question** (from `maestro plan questions`), plus the follow-up when the
   section has one. Ask it as a person would, not as a form.
3. **Offer a concrete proposal.** Draw it from the real repository and from `context.md` — an
   existing `package.json` script beats an invented command, and an existing route beats an
   imagined feature. Say where you got it.
4. **Write what they agree to**, one `maestro plan` call per item.
5. **Say the new percentage**, then move to the next section. Do not batch eight sections and
   write at the end — a plan half-written when the conversation ends should still be saved.

Between sections, ask whether they want to keep going. Someone who wanted to add one
requirement should not be held hostage to a nine-section interview.

## Writing it

Every write goes through `maestro plan` — locked, validated, atomic, and it re-renders
`plan.md` for you. **Never edit `plan.json` or `plan.md` with an editor**, and never write
`plan.md` at all: it is a generated mirror and your changes to it are discarded on the next
write.

```sh
maestro plan set-goal --text "..." --metric "..." --metric "..."
maestro plan scope --in "..." --out "..."          # --out creates an OUT- id the gate enforces
maestro plan add deliverables  --text "..."
maestro plan add useCases      --text "..." --actor "..."
maestro plan add functional    --text "..." --verify "..."
maestro plan add nonFunctional --text "..." --budget "..." --verify "..."
maestro plan add milestones    --text "..." --target "..."
maestro plan add risks         --text "..." --mitigation "..."
maestro plan add openQuestions --text "..."
maestro plan edit FR-3 --verify "npm run test:api"
maestro plan remove FR-3                            # refuses if tickets trace to it
```

All take `--board {{BOARD}}/data.json`. Exit **2** means the plan moved under you — re-read and
re-run the same command. Exit **1** means the request was wrong; retrying won't help.

## What good looks like, per section

| Section | The bar |
| --- | --- |
| **Goal** | One outcome, plus at least one metric someone could actually measure. "Better UX" is not a goal. |
| **Scope** | Both halves. The **out** list is the one that does work — it's what the scope gate refuses tickets against, and it's where "can you just also…" goes to be answered once. |
| **Deliverables** | Nouns that will exist: a service, an app, a pipeline, a document. Not activities. |
| **Use cases** | An actor and what they're trying to get done. If you can't name who does it, it isn't one. |
| **Functional** | One behaviour per entry — an entry with "and" in it is usually two. Each needs a `--verify`: a test command, a manual check, a metric. Without one, the release gate has nothing to check. |
| **Non-functional** | A measurable bar, not an adjective: `p95 < 300ms`, `WCAG 2.2 AA`, `99.9% monthly`, `no PII in logs`. An NFR with no `--budget` can't be gated and the plan will say so. |
| **Milestones** | Only if they mean something. An invented three-phase roadmap is noise. |
| **Risks** | What could sink this, and what's being assumed without having been checked. |

Don't pad. Six real requirements beat twenty generated ones, and every entry you invent is
something a ticket may later be gated against.

## Triaging gaps

Other skills — `atomic-report`, `repo-audit`, `scale`, `data-model`, `orchestration-health` —
file what they find as **gaps** against this plan. Open **required** gaps hold the percentage
down; optional ones never do. Each needs a human decision:

```sh
maestro plan gap-set G-2 --status accepted --resolved-as NFR-4   # you added it to the plan
maestro plan gap-set G-3 --status declined                       # deliberately not doing it
maestro plan gap-set G-4 --need optional                         # it was over-classified
```

Walk the required ones first. For each: show it, say which skill raised it and what it means
for this project, and propose the plan item it should become. **Accepting a gap means writing
the real item first** (`maestro plan add …`), then pointing `--resolved-as` at the id you got
back. A gap marked accepted with nothing to show for it is how the percentage starts lying.

Declining is a legitimate answer and should be an easy one — say so.

## Then stop

Report:

- the percentage before and after, and which sections you filled;
- every item you wrote, by id;
- gaps triaged, and how;
- anything you proposed that the user should double-check;
- what's still missing, and whether it matters yet.

If the board already has tickets, run `maestro plan coverage --board {{BOARD}}/data.json` and
say which plan items no ticket is working — and which tickets now trace to nothing, because
those just became ineligible.

**Never plan the work from here.** Turning a plan into epics and tickets is the `project-plan`
skill's job, and it needs a human's go-ahead first.
