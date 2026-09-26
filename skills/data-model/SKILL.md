---
name: "data-model"
description: "Scan a repo's code for every data store — databases, ORM/schema models, migrations, local files, embedded DBs, object storage, caches — and render a colorful, self-contained data-model diagram as HTML in the board's reports folder. Use for /data-model or when asked to map, diagram, or document a project's data storage / data model."
---

# Data Model

A **read-only** discovery pass over one repository's code to find every place it persists data,
followed by a single colorful HTML report combining a visual diagram with a plain evidence table.
Same evidence discipline as `repo-audit`: every store on the diagram traces back to a real
`file:line`; nothing is inferred from a filename alone. Same output discipline as `scale`:
one self-contained HTML page, no script, no external resources.

## Scope (v1)

Current repo only — no registry, no multi-repo fan-out. If this project has a
`maestro-registry.json` and the user names a different repo, ask them to run this from that
repo's own working directory instead of trying to reach across repos.

## Before scanning

`git status --short` — note any uncommitted changes so the report can say whether it reflects
the working tree or a clean checkout. No git writes, no fetch needed (this is a static-code scan,
not a history scan).

## What counts as a data store

Look for concrete evidence of each, not just a mention in prose (a `README` claiming "we use
Postgres" is not evidence — a connection string, an ORM model, or a migration file is):

1. **Relational / SQL databases** — ORM or schema definitions (Prisma `schema.prisma`,
   TypeORM/Sequelize models, Django/SQLAlchemy models, ActiveRecord classes, Drizzle schema),
   raw `.sql` migration or DDL files, `docker-compose.yml` / IaC service blocks for
   postgres/mysql/mariadb/sqlserver, connection strings or `DATABASE_URL`-style env vars in
   config or `.env.example`.
2. **Document / NoSQL databases** — Mongoose/MongoDB schemas, DynamoDB table definitions,
   Firestore/Firebase usage, connection strings for mongo/dynamo/cosmos.
3. **Embedded / file-backed databases** — SQLite files or `sqlite3`/`better-sqlite3` usage,
   LevelDB/RocksDB.
4. **Caches & in-memory/queue stores with persistence** — Redis, Memcached — only if used for
   something beyond ephemeral request-scoped caching (note that distinction in the evidence).
5. **Object / blob storage** — S3/GCS/Azure Blob SDK calls or bucket config, upload directories
   served from disk.
6. **Local file-based storage** — application code that reads/writes JSON, CSV, YAML, or other
   files as its actual data store (not build artifacts, not fixtures, not logs).

For each store found, capture: **name** (table/collection/bucket/file), **type** (one of the
categories above), **evidence** (`file:line`, quoted just enough to justify the claim), and for
database entities, **fields and relationships** where the schema makes them explicit (foreign
keys, `references`, `belongsTo`/`hasMany`, join tables). Skip fields you can't see in code —
"fields not fully modeled in code" is a valid, honest note, not a gap to paper over.

## Building the model

Group entities by the store they live in. Draw relationships only where the code states them
(a foreign-key column, an ORM relation declaration, a join table) — never infer a relationship
from two tables merely sharing a plausible column name.

If the repo has multiple distinct stores (e.g. Postgres for core data, Redis for sessions, S3
for uploads), keep them visually separate in the diagram (grouped/clustered), not merged into
one flat entity list.

## Output

Write **one self-contained HTML file** — no external requests and no `<script>` of any kind. The
cockpit renders reports in a fully sandboxed iframe (`sandbox=""`, scripts blocked), so any JS
silently does nothing and any external font/CDN/image link silently fails to load. All CSS
inline in a `<style>` tag. Draw the diagram with plain HTML/CSS boxes and inline `<svg>` lines
computed at write time — no diagram library, since none can load.

Path: `{{BOARD}}/reports/data-model-<YYYY-MM-DD>.html`. Create `{{BOARD}}/reports/` if absent.
If a report for today's date already exists, overwrite it; older dates are kept as history —
don't delete them.

### Structure

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Data Model — <repo name> (<YYYY-MM-DD>)</title>
<style>/* system font stack; colorful, high-contrast; no external assets */</style>
</head>
<body>
  <!-- Header: repo name, scan date, one-line scope note (clean vs uncommitted changes) -->

  <!-- Summary bar: count of stores by type, as colored badges -->

  <!-- Diagram: entities/stores as color-coded cards grouped by store,
       relationship lines drawn with inline SVG. Legend mapping color -> store type. -->

  <!-- Evidence table: one row per store/entity — name, type, file:line, key fields,
       relationships. This is the ground truth if the diagram layout is ever ambiguous. -->

  <!-- "Not covered" section: store types deliberately not scanned for, or code paths
       skipped (e.g. generated/vendor directories) -->

  <!-- Footer: generated date -->
</body>
</html>
```

Color convention, used consistently across the legend, diagram, and evidence table:
relational = blue, document/NoSQL = green, embedded/file-backed DB = teal, cache = orange,
object/blob storage = purple, local file storage = gray. Keep the mapping stable across a
report; don't reuse a color for two store types.

## After writing

Return to the caller a short summary (≤10 lines): total stores found, one line per store type
with its count, any store type deliberately not found (say "none found" rather than omitting a
category you did check), and the report file path. Don't restate the full entity list in
chat — the file is the deliverable.

## File what's missing as a plan gap

A finding that the **project plan** doesn't cover belongs in the plan, not only in this report.
A report is read once; a gap sits against the plan, holds its completeness percentage down, and
has to be answered.

Check first — a project with no plan has nothing to file against:

```sh
maestro plan status --board {{BOARD}}/data.json
```

If a plan exists, file each uncovered finding once:

```sh
maestro plan gap-add --board {{BOARD}}/data.json --from "data-model" \
  --need required --text "<what the plan is missing, stated as a gap>"
```

- **`--need required`** — the plan is genuinely incomplete without it: an unstated requirement
  the project clearly depends on, a quality bar the work is already being judged against, a
  deliverable nobody wrote down. These lower the percentage until a human accepts or declines
  them.
- **`--need optional`** — worth considering. Never affects the percentage.

Rules that keep this from becoming noise:

- **State the gap, not the fix.** "No stated availability target for the API" — not "add
  a health check".
- **Only what the plan is missing.** A bug, a stale branch, or a failing test is a report
  finding and belongs in the report. It is not a plan gap.
- **Be sparing with `required`.** Classify as required only what you could defend to the owner.
  A wall of required gaps reads as noise and gets ignored wholesale.
- Re-runs are safe: a gap whose text already exists is skipped, not duplicated.

Name every gap you filed in your summary, with its id and `need`. Triage happens in
`/plan-update`, never here — you file, a human decides.

## Hard rules

- **Read-only, except the plan's gap inbox.** No edits to source, no git writes, no commits, and no board writes. `maestro plan gap-add` is the one exception: it files a question against the plan for a human to answer, and commits the project to nothing.
- **No inline `<script>`, no external resources.** The report must render correctly as a static
  document with zero network access and zero script execution — verify by re-reading the file
  for any `<script`, `http://`, or `https://` before finishing.
- **Evidence or "not covered."** Every store and every relationship on the diagram traces back
  to a `file:line` this skill actually read. Never infer a table, field, or relationship from a
  filename or a plausible-sounding name.
- **No secret values, ever.** A connection string is evidence of a store's existence — quote the
  host/scheme (e.g. `postgres://...`) but never a password, token, or full credentialed URL.
- **This repo only, for now.** New skill — don't add it to `docs/`, the starter roster, or any
  other kit-wide surface until the user has reviewed a generated report and asked for that.
