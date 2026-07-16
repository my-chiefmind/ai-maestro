---
name: "delivery-hygiene"
description: "Keep the board small, clear, and close to the real delivery shape. Use when breaking work into tickets, deciding whether to split blockers/verification/docs, or cleaning up an oversized board without losing delivery clarity."
---

# Delivery Hygiene

Boards rot when every thought becomes a ticket. Use this when planning work or when a board
feels noisy.

## Core rules

- **One ticket per independently shippable outcome.** If two things always ship together,
  they're one ticket.
- **Split only when ownership, release boundary, or test surface genuinely differs** — not
  because a ticket "feels big."
- **Blocker tickets only** when they unlock *multiple* downstream tickets or need a separate
  owner. A prerequisite that only one ticket needs is just a first step of that ticket.
- **Verification stays in the parent's acceptance criteria** unless it's a standalone
  release gate.
- **Docs and cleanup ride with the parent** unless the artifact itself is the deliverable.
- **Migrations/refactors get an explicit fan-out budget** up front: prefer one plan ticket,
  one implementation ticket, one verification ticket, one cleanup ticket — not one per file.
- **Every ticket has acceptance criteria before implementation starts.** A ticket that can't
  state verifiable ACs isn't ready to be a ticket.

## Reviewing an oversized board

- Merge tickets that always move together.
- Collapse "write the test" / "write the doc" tickets back into their parent's ACs.
- Turn a chain of tiny sequential tickets into one ticket with steps.
- Move release/prod work into its own gated epic so it stops cluttering dev flow.

The board records what's **built, blocked, or done** — it is not a place to track evidence,
notes, or reminders. Those live in the ticket `desc` or `board/specs/<id>.md`.
