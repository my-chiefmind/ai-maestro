# Maestro cockpit

A small React/MUI/Vite console over a single Maestro board. It reads and edits
`board/data.json` in place (with a timestamped backup on every write) and shows the archive
read-only.

![what it shows] — stat cards (active / P0 / ready / blocked / human-gated / completed), an
epic sidebar, filterable ticket cards that surface each ticket's **model** and **agent plan**,
and a detail drawer to edit a ticket.

## Run it

```bash
cd cockpit
npm install

# dev (two processes: data service on :4600, Vite UI on :5273)
npm run dev
# → open http://localhost:5273
```

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

## What it does / doesn't do

- **Edits** live tickets in `data.json` — status, priority, model, agent plan, deps, epic,
  human gate, evidence — and adds/deletes tickets. Every write backs up the previous file
  under `board/.backups/`.
- **Read-only** for the archive and for `archive.json` (landing/archiving a ticket is the
  `land-and-archive` skill's job, not the console's).
- Single board by design. It's the operator's view of one project's board, not a portfolio.
