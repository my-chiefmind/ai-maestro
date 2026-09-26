---
name: "dev-setup"
description: "Bootstrap a repo for local development from a clean checkout. Use when starting on a new machine or a fresh clone: install the right toolchain versions, dependencies, env config, and confirm the app builds and tests run before any work begins."
---

# Dev Setup

Get a repo from `git clone` to "builds + tests green" reproducibly, so no one debugs their
environment mid-ticket.

## Steps

1. **Read the project's `context.md`** for the toolchain, versions, and commands. Don't guess
   the package manager or test runner — the project declares them.
2. **Pin the toolchain.** Use the version manager the repo specifies (`.nvmrc`,
   `.tool-versions`, `.python-version`, etc.). Mismatched runtimes cause phantom failures.
3. **Install dependencies** with the project's lockfile-respecting command
   (`npm ci`, `uv sync`, `pnpm i --frozen-lockfile`, …). Don't run an installer that rewrites
   the lockfile — that churn is not your change.
4. **Configure env.** Copy `.env.example` → `.env` (or the documented path) and fill in local
   values. Secrets come from the documented local source, never from a prod path.
5. **Build.** Run the build once; fix setup issues, not code.
6. **Verify the baseline.** Run the test suite. Note the known-good baseline (some suites have
   a small set of accepted-failing tests) so later you can tell a regression from noise.

## Guardrails

- If a setup step's docs mention a **prod** path (a prod DB, prod secrets), that's not
  permission to use it — set up against local/dev only.
- Don't commit machine-generated churn (rebuilt lockfile entries, editor files). Restore it
  with `git checkout` before you start real work.

Done when: the app builds and the test suite runs to its known baseline from a clean checkout.
