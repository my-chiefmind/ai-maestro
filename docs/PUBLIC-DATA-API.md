# Public plan, spec, and registry APIs

Integrations should import package exports rather than `scripts/*` paths. These synchronous
APIs are available from a packed `@mychiefmind/ai-maestro` installation.

```js
import { readPlan, getPlanVersion, applyPlan } from "@mychiefmind/ai-maestro/plan";
import { listSpecs, readSpec, getSpecVersion, writeSpec, ABSENT_SPEC_VERSION } from "@mychiefmind/ai-maestro/spec";
import { readRegistry } from "@mychiefmind/ai-maestro/registry";
import { listTicketEligibility } from "@mychiefmind/ai-maestro/board";
import {
  buildUsageReport, buildPortfolioUsage,
  USAGE_SLICE_SCHEMA, USAGE_SLICE_DIMENSIONS,
} from "@mychiefmind/ai-maestro/usage";

const boardPath = "/project/maestro/board/data.json";
const { plan, version } = readPlan({ boardPath });
const updated = applyPlan({ boardPath, operation: "addItem",
  params: { section: "functional", text: "Users can export data", verify: "npm test" },
  expectVersion: version });

const specVersion = getSpecVersion({ boardPath, id: "T-001" });
writeSpec({ boardPath, id: "T-001", content: "# Detail\n", expectVersion: specVersion });
const spec = readSpec({ boardPath, id: "T-001" });
const specs = listSpecs({ boardPath }); // [{ id: "T-001", version: "sha256:…" }]

const { projects } = readRegistry("/project/maestro-registry.json");
const eligibility = listTicketEligibility({ boardPath });
const usage = buildUsageReport({ boardPath });
```

`readPlan` returns an empty, normalized plan when `plan.json` does not exist. Versions are opaque
SHA-256 tokens; compare them only for equality. `applyPlan` holds the board directory lock,
loads the latest plan, applies a targeted operation, validates it, replaces `plan.json` atomically,
and regenerates `plan.md`. It returns `{ plan, result, version, changed, warnings }`. Omit
`expectVersion` for a concurrent additive operation such as `addItem`; supply it when an editor
must reject changes since its last read. `dryRun: true` validates without writing. Available
operations are `init`, `render`, `setGoal`, `addScope`, `addItem`, `editItem`, `removeItem`,
`addInitiative`, `editInitiative`, `removeInitiative`, `addGap`, and `setGap`. Each operation
accepts only its documented fields in `params`; unknown fields are rejected. See
`scripts/plan-operations.mjs` for each operation's exact parameter shape.

`readSpec` reads one direct `board/specs/<id>.md` child and returns `{ id, content, version }`.
Missing specs raise `SpecNotFoundError`; `getSpecVersion` returns `ABSENT_SPEC_VERSION` for them.
Every `writeSpec` requires `expectVersion`, including creation with the absent sentinel. Empty
string content is valid. A write returns `{ id, version }`. IDs, body types, and paths are
validated, and symlinked spec paths or specs directories are rejected.

`listSpecs({ boardPath })` takes one coherent snapshot under the shared board lock and returns
safe, direct, lowercase-`.md` regular files as sorted `{ id, version }` entries. It never
recurses or follows links. The same operations are available to shell callers:

```sh
maestro spec list --board maestro/board/data.json
maestro spec read T-001 --board maestro/board/data.json
maestro spec write T-001 --board maestro/board/data.json \
  --file spec.md --expect-version sha256:…
# Exact stdin, including an empty body, is supported with --file -.
```

CLI reads emit the exact stored content, without adding a newline. CLI writes always require
`--expect-version`; use `sha256:absent` only for creation. Add `--json` for stable one-line
machine output. Exit 2 is a retryable conflict/lock result; invalid input and missing specs exit 1.

Plan errors include `PlanInputError`, `PlanNotFoundError`, `PlanConflictError`, and
`PlanLockError`. Spec errors include `SpecInputError`, `SpecNotFoundError`,
`SpecConflictError`, and `SpecLockError`. Each has a stable `code` property. A stale version
is a conflict and should prompt a fresh read.

## Registry writes

`readRegistry` resolves projects and nested registries. The same export also edits one registry
file safely:

```js
import {
  readRegistryDocument, getRegistryVersion, addRegistryEntry, removeRegistryEntry,
  setRegistryStatus, ABSENT_REGISTRY_VERSION,
} from "@mychiefmind/ai-maestro/registry";

const registryPath = "/home/me/maestro-registry.json";
const { projects, version } = readRegistryDocument(registryPath); // direct entries, as written
const added = addRegistryEntry({ registryPath, entry: { name: "web", path: "~/src/web" }, expectVersion: version });
setRegistryStatus({ registryPath, name: "web", status: "parked", expectVersion: added.version });
removeRegistryEntry({ registryPath, name: "web" });
```

| Function | Returns |
| --- | --- |
| `readRegistryDocument(registryPath)` | `{ projects, version }` — the file's own entries, nested registries not resolved |
| `getRegistryVersion(registryPath)` | version string; `ABSENT_REGISTRY_VERSION` (`"sha256:absent"`) when missing |
| `addRegistryEntry({ registryPath, entry, expectVersion?, lockTimeoutMs? })` | `{ version, changed: true }` |
| `removeRegistryEntry({ registryPath, name, expectVersion?, lockTimeoutMs? })` | `{ version, changed: true }` |
| `setRegistryStatus({ registryPath, name, status, expectVersion?, lockTimeoutMs? })` | `{ version, changed }` |

Entries keep the registry schema (`name`, `path`, `registry`, `status`, `kind`, `note`; `status`
is `active` or `parked`, absent means `active`). `name` addresses a direct project entry by its
`name`, or by its `path` when unnamed. `add` rejects a name already used in this file or in a
registry it includes, and creates `{ "projects": [...] }` when the file is absent. When the file has no entries
(missing or empty `projects`), `add` rewrites the whole document as canonical 2-space JSON,
since there is no entry layout to preserve. Nested files
are edited by passing their own path.

Each write takes a lock beside the file (`.<file>.lock`), compares `expectVersion` when given,
validates the result, and replaces the file through an fsync'd temp file and rename. Edits are
surgical: only the target entry's text changes, so formatting and unrelated entries keep their
bytes. Parking appends `"status": "parked"` to the entry; activating removes the `status` member,
so park followed by unpark is byte-identical. Setting the status an entry already has returns
`changed: false` and does not touch the file.

Errors have a stable `code`: `RegistryValidationError` (`EREGISTRYINVALID`, with `errors[]`; bad
input, unknown option or entry key, duplicate name, or an already-invalid file),
`RegistryConflictError` (`EREGISTRYCONFLICT`, with `expected`/`actual`), `RegistryLockError`
(`EREGISTRYLOCKED`, with `holder`/`timeoutMs`, no paths), and `RegistryNotFoundError`
(`EREGISTRYNOTFOUND`; missing file for read/remove/status, or unknown name).

No registry error `message` contains a filesystem path; where relevant the path is
available as the error's `path` property for logging.

## Dispatch eligibility

`listTicketEligibility` is the canonical read-only dispatch decision for companion UIs. It
evaluates status, human gates, dependencies, plan scope, and initiative ownership from one
locked board/archive/plan snapshot. Do not reproduce those rules in a dashboard. See
`docs/BOARD-API.md` for the verdict and reason-code contract.

## Joint usage slices

Both usage report functions return `usageSlices`, the supported input for dashboards that need
several filters at once. Its contract is versioned independently from the older report shape:

```js
usage.usageSlices = {
  schema: 1,
  dimensions: ["projectKey", "ticketId", "scope", "provider", "model", "runtime", "provenance", "date"],
  rows: [{
    projectKey: "project_…", ticketId: "T-001", scope: "ticket",
    provider: "openai", model: "gpt-6-sol", runtime: "codex",
    provenance: "orchestration", date: "2026-09-25", project: "example",
    metrics: {
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, thinking: 1, total: 6 },
      turns: 0, runs: 1, applicationCalls: 0, usageRuns: 1, unavailableUsageRuns: 0,
      estimatedActiveMs: 0, exactMs: 1000, spanMs: 1000,
      firstTs: 1790294400000, lastTs: 1790294401000,
    },
  }],
};
```

`USAGE_SLICE_SCHEMA` is `1`. `USAGE_SLICE_DIMENSIONS` is frozen and contains exactly the eight
dimension names shown above. A row is aggregated from observations that share the complete tuple
on one UTC date; consumers must not reconstruct intersections from the legacy independent
breakdowns. Rows sort deterministically by project key, scope, nullable ticket, date, provider,
model, runtime, then provenance. `project` is display-only and is not part of identity.

`scope` is `ticket`, `project-only` for application counters intentionally recorded without a
ticket, or `unassigned` for reconstructed work that could not be justified against a ticket.
Missing categorical data is the literal `unknown`. A measured run whose provider counters were
unavailable remains a zero-token row with `runs: 1`, `usageRuns: 0`, and
`unavailableUsageRuns: 1`; zero never means the provider proved the run was free. `ticketId` is
nullable only for the two non-ticket scopes.

The opaque `projectKey` is stable for a resolved local project path, while the path itself is
never returned. Portfolio merging keys on it as well as the other dimensions, so two projects
may both have `T-001` without being collapsed. Rows expose no filesystem paths, run/event/session
ids, evidence strings, transcript text, prompts, or responses. Additive token, counter, and time
fields reconcile exactly to `report.totals`; `thinking` is reported but excluded from `total`
because it is already a subset of output.
