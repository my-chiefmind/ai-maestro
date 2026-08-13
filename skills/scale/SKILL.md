---
name: "scale"
description: "Plain-English project status report for non-technical readers (roughly a 12-13-year-old reading level) — a colorful, visual single-page HTML written to the board's reports folder. Covers what the project is, what's done, what's in progress, what's missing, what's next, and any risks, with green/yellow/red status and no jargon. Use for /scale or when a PM or other non-technical stakeholder needs to understand a repo's health without reading code or the board directly."
---

# Scale

A **read-only**, plain-English status report for people who don't read code or the board
format — a project manager, a stakeholder, anyone who needs the health of a repo in five
minutes, not fifteen. It is the same underlying evidence as `atomic-report` and `repo-audit`
(board + git), rewritten for a reader with no technical background, and rendered as a single
colorful HTML page instead of bullets or tables.

Don't reuse this for a technical audience — point them at `dev-report` (full correlation) or
`atomic-report` (terse bullets) instead. Scale trades precision for accessibility on purpose:
it's allowed to round, group, and simplify in ways those two must not.

## Before reporting

Same discipline as `atomic-report`: `git fetch --all --prune` first. If it fails (no remote,
offline), still produce the report but note in the "What's next" section that the git history
might be stale.

## Gather the evidence

All of this is read-only — no board writes, no git writes, no commits.

1. **What this project is** — the opening paragraph of `README.md` (or `CLAUDE.md` if no
   README), rewritten in one or two plain sentences. Don't quote it verbatim if it's technical;
   translate it.
2. **What's done** — `{{BOARD}}/archive.json`: tickets with `status: "done"`. Group by
   `epicId` (translate each epic's `name`/`desc` into a plain-English theme, e.g. "Kit
   integrity" → "Making sure updates don't break people's work"). Count done vs total tickets
   across `data.json` + `archive.json` for the progress indicator. Tickets archived as
   `archived`, `duplicate`, or `wont-do` are NOT done — mention them separately, plainly, as
   "decided not to do" or "put on hold," never folded into the done count.
3. **What's being worked on now** — `{{BOARD}}/data.json`: tickets with `status: "in-progress"`
   or `"review"`. One plain-English sentence each: what it is, not its internal ticket name
   verbatim if that name is jargon-heavy.
4. **What's missing / gaps** — if a recent `{{BOARD}}/reports/repo-audit-*.md` exists (same
   repo, most recent date), pull its Gaps table and Security findings, rewritten in plain
   English with severity translated to green/yellow/red. If no audit report exists, say so
   plainly ("nobody has done a deep-dive check yet") rather than inventing gaps.
5. **What's left to do** — `data.json` tickets with `status: "backlog"` or `"todo"`. Group and
   count rather than listing all of them if there are many (cap the itemized list at ~8, then
   "+N more").
6. **Risks & blockers** — tickets with `status: "blocked"` (state the blocker in plain
   English), tickets with a `human_gate` set (translate as "waiting on a person to say go"),
   and any uncommitted or stale git state worth flagging (`git status --short`, worktrees older
   than a few days). A failed or missing release gate counts here too.
7. **What's next** — same eligibility logic as `atomic-report` §3: backlog/todo tickets whose
   `depends_on` are all done, in board order, capped at 5. If nothing is eligible, say what's
   blocking the whole queue.

## Plain-English rules

- Target reading level: roughly age 12-13. Short sentences. Common words.
- If a technical term is unavoidable (ticket, merge, repository, deploy, backlog...), define it
  in parentheses the first time it appears, briefly and concretely — not a dictionary
  definition. E.g. "merged (the change is now part of the real project)".
- No ticket IDs, epic IDs, file paths, commit SHAs, or command output in the visible prose.
  They can live in an HTML `title` attribute or a small monospace tag for the curious, but the
  sentence itself must read clean without them.
- Never invent progress, completion, or risk that the evidence doesn't support. "Not checked
  yet" is always a valid, honest answer.

## Output

Write **one self-contained HTML file**, no external requests and no `<script>` of any kind —
the cockpit renders reports in a fully sandboxed iframe (`sandbox=""`, scripts blocked), so any
JS silently does nothing and any external font/CDN/image link silently fails to load. All CSS
must be inline in a `<style>` tag; no external stylesheets, fonts, or images.

Path: `{{BOARD}}/reports/scale-<YYYY-MM-DD>.html`. Create `{{BOARD}}/reports/` if absent. If a
report for today's date already exists, overwrite it; older dates are kept as history — don't
delete them.

### Structure

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Project Status — <plain project name> (<YYYY-MM-DD>)</title>
<style>/* system font stack; light, colorful, high-contrast; card grid; no external assets */</style>
</head>
<body>
  <!-- Header: project name in plain English, one-line "what it is", report date -->

  <!-- Overall status card: one big green/yellow/red badge + one sentence verdict -->

  <!-- Progress: done vs total, as a percentage and a visual bar -->

  <!-- "What's done" section: status cards or a simple list, grouped by theme -->

  <!-- "What's happening now" section -->

  <!-- "What's missing" section, green/yellow/red per item where severity is known -->

  <!-- "What's left to do" section: simple list/table, capped and summarized -->

  <!-- "Risks & blockers" section: red/yellow cards, one per real risk -->

  <!-- "What's next?" section: a short numbered list of the next concrete steps -->

  <!-- Footer: generated date, and "this is a simplified summary — ask the team for detail" -->
</body>
</html>
```

Use color consistently: green = done/healthy/on track, yellow = in progress/needs attention,
red = blocked/at risk/missing. Don't use red for anything that isn't an actual risk or
blocker — reserve it, or it stops meaning anything.

Keep the whole page skimmable in under 5 minutes: prefer cards and short lists over paragraphs;
no section should run longer than a few sentences plus its list/cards.

## After writing

Return to the caller a short summary (≤10 lines): overall status color + one-sentence verdict,
the done/total count, the top risk if any, and the report file path. Don't restate the whole
report in chat — the file is the deliverable.

## Hard rules

- **Read-only, always.** No board writes, no git writes, no commits, no edits to source files.
- **No inline `<script>`, no external resources.** The report must render correctly as a static
  document with zero network access and zero script execution — verify by re-reading the file
  for any `<script`, `http://`, or `https://` before finishing.
- **Evidence or "not checked yet."** Every claim traces back to a file this skill actually read.
  Never guess at completion percentage, risk, or root cause.
- **No secret values, ever**, even if one appears in a commit message, ticket, or audit report
  being summarized.
- **This repo only, for now.** Scale is new — don't add it to `docs/`, the starter roster, or
  any other kit-wide surface until the user has reviewed a generated report and asked for that.
