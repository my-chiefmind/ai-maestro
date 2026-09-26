# Board API

`@mychiefmind/ai-maestro/board` is the supported JavaScript API for board integrations. It is
the same implementation used by `maestro ticket`; consumers do not import private `scripts/`
files, and those paths are blocked by the package export map.

```js
import {
  readBoard, setTicketStatus, getTicketEligibility, listTicketEligibility, claimTicket,
} from "@mychiefmind/ai-maestro/board";

const boardPath = "/project/maestro/board/data.json";
const snapshot = readBoard({ boardPath });
const eligibility = getTicketEligibility({ boardPath, id: "T-012" });
setTicketStatus({ boardPath, id: "T-012", status: "review", expectVersion: snapshot.version });
```

All reads and writes take the board-directory lock. A write reloads `data.json`, `archive.json`,
`plan.json`, `config.json`, and the effective agent roster while holding that lock, applies one
targeted operation, validates the result, and atomically replaces only its owned board files.
There is deliberately no whole-board PUT operation.

The write operations are `createTicket`, `editTicket`, `setTicketStatus`, `setTicketEpic`,
`createEpic`, `editEpic`, `archiveTicket`, and `dropTicket`. Every write accepts
`expectVersion` for compare-and-swap and `dryRun`. `readBoard` returns the board, archive, plan,
config, content versions, and validator errors/warnings. An explicit `agentsDir` overrides the
roster; otherwise `config.json` is authoritative, with the shipped agents as fallback.

`editTicket` accepts `changes` for: `name`, `desc`, `epicId`, `area`, `priority`, `swag`,
`depends_on`, `agent_plan`, `model`, `execution_mode`, `traces_to`, `scope_exception`,
`human_gate`, `testCmd`, `touches`, `wave`, `currentAgent`, `nextAgent`, and the cross-review
routing fields `dev_runtime`, `dev_model`, `reviewer_runtime`, `reviewer_model`. Routing values
follow `ticket set-routing`: a non-empty string (trimmed) sets the field; `null`, `""` or a
whitespace-only string removes it so the ticket inherits `config.crossReview` (the CLI's
`set-routing` rejects blank values; use `--clear` there). A non-string value throws `BoardInputError` with
`field` naming the key (e.g. `{ code: "EBOARDINPUT", field: "dev_runtime", value: 42 }`). Setting
any field to `null` removes it; unknown keys throw `BoardInputError` with `fields`.

| Class | Code | Structured details |
| --- | --- | --- |
| `BoardInputError` | `EBOARDINPUT` | invalid fields or values |
| `BoardNotFoundError` | `EBOARDNOTFOUND` | `id`, `kind`, optional `archived` |
| `BoardDuplicateError` | `EBOARDDUPLICATE` | `id`, `kind` |
| `BoardValidationError` | `EBOARDVALIDATION` | `errors`, `warnings`, `path` |
| `BoardConflictError` | `EBOARDCONFLICT` | `expected`, `actual`, `path` |
| `BoardLockError` | `EBOARDLOCK` | `path`, `holder`, `timeoutMs` |

The `./board` export follows package semver. Removing or changing an operation, error code, or
documented result field requires a major version. Private files under `scripts/` carry no
compatibility guarantee.

## Canonical eligibility

`getTicketEligibility({ boardPath, id })` and `listTicketEligibility({ boardPath })` answer
exactly what Maestro dispatch will allow. The list preserves active-board order and returns
`{ verdicts, version, archiveVersion, planVersion }` from one locked snapshot; the one-ticket
form replaces `verdicts` with `verdict`. A verdict is:

```js
{
  ticketId: "T-012",
  state: "blocked",        // "eligible" | "blocked"
  eligible: false,
  reasons: [{
    code: "dependency-unsatisfied",
    details: { dependencyId: "T-011" },
    message: "T-012 is waiting for T-011."
  }]
}
```

Branch on `code` and `details`; `message` is display text. Stable codes are exported in the
frozen `ELIGIBILITY_REASON_CODES` object: `status`, `human-gate`, `dependency-missing`,
`dependency-unsatisfied`, `malformed-reference`, `plan-scope`, `initiative-unassigned`,
`initiative-unknown`, and `initiative-cross`. Results contain board-defined ids but no file
paths or ticket/spec content. A missing ticket raises `BoardNotFoundError`; lock timeout raises
the existing path-free `BoardLockError` shape for this API.

The `details` contract is exact; absent keys are not emitted:

| code | exact `details` shape |
| --- | --- |
| `status` | `{ expected: "todo" }` |
| `human-gate` | `{}` |
| `dependency-missing` | `{ dependencyId }` |
| `dependency-unsatisfied` | `{ dependencyId }` |
| `malformed-reference` | `{ field }` or `{ field, index }`; a safe missing epic may also include `epicId` |
| `plan-scope` | `{ state }`, where state distinguishes `untraced`, `out`, and `unknown` |
| `initiative-unassigned` | `{ state: "unassigned-epic" }` |
| `initiative-unknown` | `{ state: "unknown-initiative", initiativeId? }` |
| `initiative-cross` | `{ state: "cross-initiative", initiativeId?, itemIds }` |

Malformed identifiers are never repeated in `ticketId`, `details`, or `message`. Only the safe
field name and optional array index identify them.

Shell integrations use the same implementation without writing the board:

```sh
maestro ticket eligibility --board maestro/board/data.json --json
maestro ticket eligibility T-012 --board maestro/board/data.json --json
```

Dispatchers must claim rather than following a read with `set-status`:

```js
const snapshot = listTicketEligibility({ boardPath });
const claim = claimTicket({
  boardPath, id: "T-012",
  expectVersion: snapshot.version,
  expectArchiveVersion: snapshot.archiveVersion,
  expectPlanVersion: snapshot.planVersion,
});
```

`claimTicket` reloads board, archive, and plan under the shared board lock, evaluates the
canonical verdict, and changes only an eligible ticket to `in-progress`. Its result contains
`result.claimed`, `result.verdict`, and `result.conflicts`. Snapshot versions are all-or-none;
any changed input refuses the claim. The CLI equivalent is `maestro ticket claim T-012` with
the three `--expect-*version` flags. `setTicketStatus` remains available for ordinary lifecycle
transitions but is not a dispatch claim.
