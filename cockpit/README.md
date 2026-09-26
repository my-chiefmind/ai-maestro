# AI Maestro cockpit

A small React/MUI/Vite console over a single AI Maestro board. It reads and edits
`board/data.json` in place (with a timestamped backup on every write) and shows the archive
read-only.

It shows stat cards (active / P0 / ready / blocked / human-gated / completed), an epic sidebar,
filterable ticket cards that surface each ticket's **model** and **agent plan**, a detail
drawer to edit a ticket, and a **Roster** tab listing the project's agents and skills.

The editors are **driven by the project's `config.json`**: area, model, and agent-plan are
pickers (not free text), ticket IDs are generated, epics are created/renamed/deleted in a
dialog, and long-form ticket detail is saved to `board/specs/<id>.md`. Every write is
**validated server-side** with the same rules as the CLI, and guarded by an optimistic
**version check** so a stale tab can't overwrite changes an agent made on disk — the console
reloads instead. It also polls in the background and auto-refreshes when the board changes.

## Run it

From the kit root, `npm run dev` installs these deps (if missing) and starts everything.
Or run it directly from here:

```bash
cd cockpit
npm ci          # installs exactly what package-lock.json pins

# dev (two processes: data service on :4600, Vite UI on :5273)
npm run dev
# → open the URL it prints (5273 unless that's taken)
```

Both ports are starting points, not fixed: `server/dev.mjs` picks the first free port at or
after each one before either process starts, so several projects can keep boards open at
once. It has to happen there rather than in each process — Vite needs the data service's
port for its `/api` proxy, and would otherwise bake in a target before the service chose.
`PORT=…` / `MAESTRO_UI_PORT=…` move where that search starts; they are preferences, so a busy
one still advances. `node server/index.mjs --port N` is the strict form — bind N or fail —
and is what `dev.mjs` hands the service, since Vite's proxy target is already fixed to N by
the time it starts.

The dev server proxies `/api` to the data service. By default the service serves the board at
`../board` (the kit's example board). Point it elsewhere:

```bash
MAESTRO_BOARD_DIR=/path/to/your-repo/maestro/board npm run server
# or
node server/index.mjs --board /path/to/your-repo/maestro/board
```

## Production

```bash
npm run build        # → dist/
npm start            # the data service also serves dist/ (single origin)
```

## Portfolio mode

Opt-in: point the service at a project registry (the same file `maestro drift` and
`sync --all` read) and every board in it becomes reachable from the one console — a
project picker appears in the header, plus a **Today** tab (ready-to-run tickets across
every board, per ISO week).

```bash
node server/index.mjs --registry ~/maestro-registry.json
# or MAESTRO_REGISTRY=~/maestro-registry.json npm run server
```

The registry is the allowlist: every read **and write** resolves through a registry
entry's path — the UI only ever names a project, never a path. Without `--registry` /
`MAESTRO_REGISTRY`, nothing changes: single-board mode is the untouched default.

## Run it as a service

For an always-on board (a launchd/systemd unit, optionally fronted by a reverse proxy),
pin the port — `--port` binds exactly that port or exits 1, so the unit's restart policy
sees a real failure instead of the service quietly drifting off the port your proxy
points at:

```bash
npm run build   # once: the service serves dist/ itself, one origin, no Vite needed
node server/index.mjs --port 4650 --registry ~/maestro-registry.json
```

launchd sketch (`~/Library/LaunchAgents/com.example.maestro-cockpit.plist`): run the
command above with `KeepAlive` on; logs go wherever you point `StandardOutPath`. The
service still binds loopback only and still rejects non-localhost `Host` headers — if
you front it with a proxy under your own hostname, the proxy must rewrite `Host` to
`localhost`. And if you use a `*.localhost` name with mkcert, list the exact hostname in
the SAN — `*.localhost` is a public-suffix wildcard and covers nothing.

## What it does / doesn't do

- **Edits** live tickets and epics in `data.json` — status, priority, model, agent plan, deps,
  epic, human gate, evidence — and adds/deletes tickets. Every write backs up the previous file
  under `board/.backups/` (kept to the last 20).
- **Validates before saving** and **won't clobber** concurrent on-disk changes (409 → reload).
- **Read-only** for the archive and for `archive.json` (landing/archiving a ticket is the
  `land-and-archive` skill's job, not the console's).
- One board at a time by default; with a registry (`--registry`), every listed project's
  board, docs, and reports are reachable from the same console — scoped per request,
  path-checked per project root, never beyond the registry.
