# my-app — project context

_Every agent reads this. Keep it accurate and short._

## What this is

One or two sentences: what the app does and who it's for.

## Stack & conventions

- **Backend:** e.g. Python / FastAPI. Tests: `make test-api`.
- **Frontend:** e.g. React + TypeScript. Tests: `npm test`. Lint: `npm run lint`.
- **Infra:** e.g. IaC in `infra/`. No click-ops.
- Match existing code style; don't introduce new patterns without a ticket.

## Test commands by area

| Area | Command |
| --- | --- |
| backend | `make test-api` |
| frontend | `npm test` |
| infra | `<synth/plan/dry-run command>` |

## Guardrails

- `main` is protected — branch + PR, don't push directly.
- Prod deploys are a **separate, human-gated track** — never block a dev ticket on them, and
  never reach prod hosts/DB/secrets without explicit go-ahead.
- Secrets come from `<local source>`, never committed.

## Known baseline

- The test suite has `<N>` accepted-failing tests from `<reason>`; anything above that is a
  regression.
