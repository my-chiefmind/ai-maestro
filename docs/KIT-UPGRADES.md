# Kit upgrades and opt-in delivery rules

This page covers what 0.6.20 added for projects that vendor the kit and adapt it: how `update`
keeps your edits to kit files, and four opt-in features: ticket readiness rules, the board merge
driver, and two process checks. The merge lock and `"unlimited"` lanes are in [Swarm](./SWARM.md).

## Updating a vendored kit

`setup` vendors the kit into `<repo>/maestro/`. Update it from the repo root:

```sh
npx @mychiefmind/ai-maestro@latest update
```

The vendored CLI works too: `node maestro/bin/cli.mjs update` (or `npm run update` from
`maestro/`) finds the kit it belongs to and updates it from the registry. `--from <dir>` updates
from a local kit checkout or an extracted package instead, and `--kit <dir>` names the kit to
update when it is not `./maestro`.

### Your edits to kit files are merged

Kit scripts, the renderer, docs and starters are refreshed one file at a time with a 3-way merge:

| On disk | Result |
| --- | --- |
| Unedited since the last update | Replaced by the new release |
| Edited by you, release changed other lines | Both changes kept (`kept your edits to N kit file(s)`) |
| Edited by you, release changed the same lines | Conflict markers; the update stops (see below) |
| A file of your own in a kit folder | Left alone |
| Edited by you, dropped by the release | Moved to `custom/rescued/` |

What counts as "edited" comes from the vendor lock, `maestro/.maestro-vendor.lock`, which records
a hash for every vendored file. The merge base (the kit file as the last update wrote it) is
looked up in this order:

1. `maestro/.maestro-vendor-base/files/`, which holds a pristine kit copy of every file you have
   edited, written by each update. Commit it with the rest of `maestro/`.
2. `--base <dir>`, a copy of the previous kit release.
3. Your git history: a committed version of the file with the recorded hash.
4. The previous release from npm (`npm pack`), unless `--offline`.

A lock written by 0.6.19 or earlier has no file hashes, so the first update to 0.6.20 compares
against the previous release itself, from `--base` or npm. With neither, an edit cannot be told
from an older kit version: the file on disk is copied to `custom/rescued/` and reported, then
replaced. It is never dropped silently.

### Resolving a conflict

A conflicting file holds your version between `<<<<<<< local` and `=======`, and the release's up
to `>>>>>>> kit v<new>`. The update stops before re-rendering and leaves
`maestro/.maestro-update-pending`. Edit each listed file, then run the same update again: it
finishes the render and the board check. A file that still holds markers stops it again.

When the release now does what your patch did, take the release's version:
`cp maestro/.maestro-vendor-base/files/<path> maestro/<path>`, then re-run the update.

### kitSource

A vendored kit renders from itself: `setup` writes `"kitSource": { "mode": "self", "path": "." }`.
A `kitSource.path` that names no kit (for example `../node_modules/@mychiefmind/ai-maestro` from an
old npm-installed setup) used to break `sync` and the usage hook. `sync` now falls back to the kit
it runs from, with a warning, and `update` rewrites the setting to `"."`.

## Ticket readiness: gates and inputs (opt-in)

```json
"ticketReadiness": { "enabled": true }
```

With this on, every live ticket carries two fields:

- `gates`: booleans `merge`, `dev-deploy`, `paid-run`, `needs-owner-input`.
- `inputs`: everything the ticket needs before it can finish, as
  `{ "id", "name", "from": "owner|operator|agent|repo|external", "location", "status": "available|missing" }`.
  Use `[]` when there are none.

The validator (`gatesAndInputsIssues` in `scripts/board-core.mjs`) requires both on every live
ticket. `needs-owner-input` must be true exactly while an input from the owner is missing, and
such a ticket may not be `todo` or `in-progress`: keep it in `backlog` or `blocked`.

`maestro ticket add` and `maestro ticket import` also apply a creation checklist
(`ticketCreationIssues`): a ticket is not saved until it has gates, inputs, `touches`,
`acceptanceCriteria` and `testCmd`, and every gap is reported at once. Set
`"creationChecklist": false` to require only gates and inputs. `maestro ticket block` files its
blocker with `needs-owner-input` set and a missing owner decision as its input.

Turning this on for an existing board makes it invalid until every ticket has the fields, and an
edit of one ticket is refused while another is still invalid. Add them in one write:

```sh
maestro ticket edit-many --changes-file edits.json   # { "T-1": { "gates": {...}, "inputs": [] }, ... }
```

## `--touches`

`maestro ticket add` and `edit` take `--touches` as a JSON array (`'["src/api/**","src/b.mjs"]'`) or a
comma-separated list (`src/api/**,src/b.mjs`). A value that starts like JSON but does not parse to a
list of non-empty strings is refused, rather than split on commas into quoted fragments. The
board API refuses the same values. The validator warns about malformed `touches` already on a
board.

## Board merge driver (opt-in)

Nearly every PR edits `board/data.json`, and a line merge conflicts whenever two lanes add or close
tickets next to each other. The merge driver merges the board as data: epics and tickets by `id`,
everything else by key. Two branches that change different tickets, or different fields of one
ticket, merge cleanly. A value both sides changed differently is a real conflict: the driver falls
back to git's line merge with markers and names the place.

```sh
maestro merge-driver install     # git config in this clone + .gitattributes lines; commit .gitattributes
maestro merge-driver status      # exit 1 when not fully registered
maestro merge-driver uninstall
```

Git never stores a driver command in the repository, so every clone runs `install` once (a
`make`/`npm` setup target is a good place). Run it with the vendored CLI
(`node maestro/bin/cli.mjs merge-driver install`), so the registered command points at a kit
inside the repository.

## Process checks (opt-in)

```sh
maestro check process-ratio   [--days 30] [--ref origin/main] [--check] [--json]
maestro check evidence-budget [--base origin/main]... [--json]
```

`process-ratio` reports how much of the recent work on a branch was process (evidence under
`board/reports/`, other board files, docs) rather than code or tests, by added lines and by
commits that touch no code or tests. Merge commits and generated files are skipped. It only
reports, unless `--check`, which exits 1 when a target is missed.

`evidence-budget` compares the working tree with the merge base of `origin/main` (then `main`) and
fails when the branch commits raw evidence under `board/reports/`: a new file there must be
Markdown or HTML, one file may add at most 200 lines, and the branch at most 400. Deletions always
pass. `EVIDENCE_BUDGET_WAIVER="<approval reference>"` reports `WAIVED` and exits 0.

Both read their targets from `config.json`; every key is optional:

```json
"checks": {
  "processRatio": {
    "days": 30, "ref": "origin/main", "lineTargetPct": 10, "commitTargetPct": 15,
    "process": ["evidence", "board", "docs"],
    "generated": ["apps/site/manifest/**"],
    "docs": ["docs/**"]
  },
  "evidenceBudget": {
    "reportsDir": "maestro/board/reports", "allowedSuffixes": [".md", ".html"],
    "maxFileLines": 200, "maxTotalLines": 400, "bases": ["origin/main", "main"],
    "waiverEnv": "EVIDENCE_BUDGET_WAIVER"
  }
}
```

`generated` is added to the built-in list of lockfiles. Paths are relative to the repository
root; the board's location defaults to the folder holding `config.json`.
