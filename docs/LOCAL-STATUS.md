# Local shared ticket status

By default a ticket's status lives in `board/data.json`, so every status change and every archive
move is a git change. Each one needs its own commit and PR, a review, a resync with main and a
merge. On a busy board that admin can take as much time as the delivery work itself.

Local status is an opt-in mode that splits the board in two:

| Lives in git (`data.json`, `archive.json`) | Lives in the machine-local store |
| --- | --- |
| Ticket definitions: `name`, `desc`, `acceptanceCriteria`, `touches`, `gates`, `testCmd`, `epicId`, `depends_on`, `agent_plan`, … | `status`, `currentAgent`, `nextAgent`, `evidence`, `done_at` / `doneAt`, `claim`, `lane`, and whether the ticket is archived |
| Changed by a PR, as before | Changed instantly, never committed per change |

There is **one store per machine and board, shared by every git worktree** of the repository.
A status change made in one lane's worktree is visible in every other worktree and in the
primary checkout right away, with no commit. Once a day, `maestro status sync` writes the
store's view back into the board files, so it can go to main in a single PR.

## Turning it on

Add this to the project's `config.json` (the file next to the `board/` directory):

```json
{
  "localStatus": { "enabled": true }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | — | `true` turns the mode on; `false` or a missing key leaves the board exactly as before. |
| `fields` | `[]` | Extra ticket fields to treat as progress, added to the built-in list. One example is a gate that flips during delivery. `id` is never allowed. |
| `namespace` | `delivery.namespace`, else `maestro` | The ref namespace for the store. |

The board has to be inside a git repository; the store lives in the git common dir. When the
mode is off, none of the code below runs and versions, files and output are all unchanged.

## What every reader sees

Every reader returns `data.json` with the shared status laid over it:

- `readBoard`, `getTicketEligibility`, `listTicketEligibility`, `claimTicket` and the new
  `readTicket` from `@mychiefmind/ai-maestro/board`
- `maestro ticket …`, including the new `maestro ticket read --json`
- `maestro validate`, `maestro lanes`, `maestro run`, and the orchestrator's board read

A ticket the store has never seen reads exactly as the files have it, so turning the mode on
changes nothing until the first write. A ticket the store marks archived leaves the active list
and joins the archive, with its epic copied alongside as `maestro ticket archive` does. That
already counts as "done" for its dependents.

## Writes

All writes go through the same operations as before: `setTicketStatus`, `claimTicket`,
`archiveTicket`, `dropTicket`, `unarchiveTicket`, `editTicket`, `maestro ticket set-status`,
`block`, and the rest. A write is split by what it changed:

- A change to a progress field, or an archive or restore, becomes a store entry. `data.json`
  and `archive.json` are not touched, and `git status` stays clean.
- A change to a definition is written to the board files, as before. This includes new tickets
  and epics, edits, and imports, which ship in a PR anyway.

Concurrency uses two guards, the same pair the board itself uses:

1. **Lock.** Every writer takes `<git-common-dir>/maestro/status/<boardKey>.lock`, one lock for
   all worktrees. The per-checkout board lock is taken first, always in that order, so two
   writers cannot deadlock.
2. **Compare-and-swap.** The store is a commit at
   `refs/maestro/<namespace>/status/<boardKey>`, installed with
   `git update-ref <ref> <new> <old>`. A writer working from a stale copy fails with
   `BoardConflictError` (exit code 2, retryable) instead of losing someone else's update.

Board versions (`version`, `archiveVersion`) also cover the store's generation. As a result,
`expectVersion` and the claim snapshot refuse to act when another worktree has changed a status
in the meantime.

## The change log

Every store write is a new commit whose parent is the previous one, so the log is append-only.
Each commit message holds a JSON entry with the time, the operation, the worktree and branch,
and each ticket's before and after location and status.

```sh
maestro status log --limit 20          # newest first
maestro status log --json
```

## Daily sync

```sh
git switch -c chore/board-sync origin/main     # or a fresh worktree off main
maestro status sync --dry-run                  # what would change
maestro status sync                            # writes data.json / archive.json
git commit -am "board: daily status sync" && gh pr create --fill
```

`sync` writes the logical board (files plus store) into the files of the checkout it runs in. It
also moves every ticket whose status is `done` into the archive. It records `done_at` from the
store, and when no `evidence` was recorded it writes "Done; archived by maestro status sync on
<date>." Tickets it archives are marked archived in the store too, so other worktrees see the
move before the PR merges.

- When the files already match, sync writes nothing and reports `changed: false`. Running it
  twice is safe.
- The result is validated before anything is written. An invalid board is refused, as it would
  be for any write.
- Each sync that writes saves a store backup first.
- Store entries are kept after a sync. They then match the files, so overlaying them changes
  nothing.

## Backup and restore

```sh
maestro status export                    # → <git-common-dir>/maestro/status/backups/<boardKey>/<time>.json (newest 30 kept)
maestro status export --out status.json  # anywhere you like
maestro status import status.json        # merge: restores the tickets the export names
maestro status import status.json --replace   # install the export exactly
maestro status where                     # ref, lock, backup directory, field list
```

An import is a logged store commit like any other write. Because the store is a git ref, it
also survives `git gc`, and `git bundle create status.bundle <ref>` can copy it to another
machine.

## Inspecting one ticket

```sh
maestro status show T-012 --json   # { ticket, location: "board"|"archive", source: "local-status"|"files", version, … }
maestro status list                # every ticket whose status is held locally
```

## API

All of these are exported from `@mychiefmind/ai-maestro/board`:

| Function | Returns |
| --- | --- |
| `readTicket({ boardPath, id })` | `{ ticket, location, source, version, archiveVersion, localStatus }`: one ticket as every reader sees it, from the active board or the archive. Throws `BoardNotFoundError`. |
| `overlayLocalStatus({ boardPath, data, archive })` | `{ data, archive, localStatus }`: lays the store over board contents you read elsewhere, such as `git show <sha>:board/data.json`. Returns them unchanged when the mode is off. |
| `readLocalStatus({ boardPath })` | `{ enabled, ref, oid, board, fields, tickets }`: the raw store. |
| `syncLocalStatus({ boardPath, dryRun?, archiveDone? })` | `{ changed, files, archived, updated, version, localStatus, backup? }` |
| `exportLocalStatus({ boardPath, out? })` / `importLocalStatus({ boardPath, file \| document, mode?, dryRun? })` | Backup and restore. |
| `localStatusLog({ boardPath, limit? })` | `{ entries }`, newest first. |
| `DEFAULT_STATUS_FIELDS` | The built-in list of progress fields. |

`readBoard` also returns `localStatus: { ref, oid }` when the mode is on.

### Example: a merge gate reading status and gates

A merge script checks the ticket's definition at the reviewed commit and its live status from
the store:

```js
import { execFileSync } from "node:child_process";
import { overlayLocalStatus } from "@mychiefmind/ai-maestro/board";

const boardPath = "maestro/board/data.json";
const show = (path) => JSON.parse(execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" }));
const { data, archive } = overlayLocalStatus({
  boardPath, data: show("maestro/board/data.json"), archive: show("maestro/board/archive.json"),
});
const ticket = [...data.tickets, ...archive.tickets].find((t) => t.id === id);
// ticket.status comes from the store when it holds this ticket, otherwise from the commit.
// ticket.gates comes from the commit, unless "gates" is listed in localStatus.fields.
```

If the checkout's current files are enough, `readTicket({ boardPath, id }).ticket` is simpler.

## Limits

- The store belongs to one machine. Two machines working on the same board each have their own
  store, and the daily sync PRs are where they meet. On one machine, the store wins over a hand
  edit of a progress field in `data.json` for any ticket the store holds. Use
  `maestro status import` or a normal write to correct it.
- Guarded delivery attestations (`ticket.delivery`) stay in git. They are checked against
  commits.
