# Security

This document covers three things reviewers and scanners repeatedly ask about:
when this package executes code, what it trusts, and what it talks to over the network.

To report a vulnerability, email **info@mychiefmind.com**. Please don't open a public issue
for anything exploitable.

---

## 1. Install-time behaviour

**Installing this package executes nothing.**

`@mychiefmind/ai-maestro` declares no `preinstall`, `install`, `postinstall`, or `prepare`
script, and has **zero runtime dependencies**. `npm i @mychiefmind/ai-maestro` copies files
and stops. The single `prepublishOnly` hook runs the board validator on the maintainer's
machine at publish time and never on a consumer's.

This is enforced by tests, not just convention — see
`test/cockpit-install.test.mjs`, which fails if any install lifecycle hook is ever added to
this package or to the `package.json` that `maestro setup` vendors into a user's repo.

### The one thing that does shell out

The optional cockpit UI (`cockpit/`) is a React/Vite app with its own dependency tree. It is
not installed with the kit. Its dependencies are installed by `scripts/cockpit-install.mjs`,
which runs from the `preboard` hook — i.e. **only when a user explicitly starts the board**
(`npm run board`), and only on first run.

Properties of that path:

| Property | Guarantee |
| --- | --- |
| Trigger | Explicit `npm run board` only. Never on package install. |
| During `maestro setup` | Behind a y/n prompt; a non-interactive run without `--yes` never starts the board, so it never installs (`bin/cli.mjs`). |
| Reproducibility | `npm ci` against the committed `cockpit/package-lock.json`. Never `npm install`, which would re-resolve semver ranges. |
| Missing lockfile | **Hard failure.** It will not fall back to an unpinned install. |
| Invocation | `execFileSync` with an argument array. No shell on POSIX. |
| Injectable input | None. Every argument is a literal constant in the script. No board content, config value, filename, or environment variable reaches the command line. |
| Idempotence | No-ops if `cockpit/node_modules` exists. Only an explicit `npm run cockpit:install` (`--force`) reinstalls. |

`cockpit/package-lock.json` is committed and ships in the published tarball (npm strips a
*root* lockfile from tarballs but keeps nested ones — asserted by test, since the whole
design depends on it).

### Two flags we deliberately do not pass

- **`--ignore-scripts`** — the cockpit's toolchain (vite → esbuild) links a
  platform-specific binary in a postinstall script. The UI cannot build without lifecycle
  scripts, so disabling them would trade a working feature for no real gain: the lockfile
  already pins exactly which packages get to run those scripts.
- **`--no-audit`** — previously passed, now removed. `npm audit` is an advisory report; it
  never gated an install and suppressing it prevented nothing. It only hid information from
  the user, so it is gone. Expect audit output on first board start.

### Trust assumptions around vendored content

`maestro setup` copies kit content (`agents/`, `skills/`, `render/`, `board/`, `cockpit/`,
…) out of the installed package and into `<repo>/maestro/`. The trust model:

- **The vendored bytes are the bytes npm delivered.** Integrity of that delivery is npm's
  registry signatures plus the consumer's own lockfile — the standard chain for any package.
- **We do not ship a checksum manifest over our own vendored content, deliberately.** Such a
  manifest would travel in the same tarball as the content it verifies, so anyone able to
  modify `cockpit/` could modify the manifest in the same edit. It would add a fail-closed
  abort path that breaks legitimate users for zero attacker cost. To verify what you
  received, use the mechanism that isn't self-referential: `npm pack` the version you
  installed and compare against the published integrity hash in your lockfile.
- **Content vendored into your repo becomes yours.** After `setup` it is ordinary tracked
  source. Review it in the diff like any other dependency you commit.
- **Agent and skill markdown is instruction text for an AI coding tool.** Treat a board or
  a rendered `.claude/` directory from an untrusted source the way you'd treat any script:
  read it before running an agent against it.

---

## 2. Runtime network surface

**The kit makes no outbound network calls.** The enumerated surface:

| Component | Contacts | When |
| --- | --- | --- |
| `bin/cli.mjs`, `render/`, `scripts/` | Nothing. No HTTP client, no `fetch`, no sockets. | — |
| Cockpit data service (`cockpit/server/index.mjs`) | Binds `localhost:4600`. Listens only; never dials out. | While the board runs |
| Cockpit UI (`cockpit/src/`) | Same-origin relative paths only (`/api/board`, `/api/config`, `/api/roster`, `/api/docs`, `/api/spec/*`). No absolute URLs. | While the board is open |
| Vite dev server | Serves `localhost:5273`, proxies `/api` → `localhost:4600`. | Dev only |
| `npm ci` for the cockpit | Your configured npm registry. | First `npm run board` only |

There is **no telemetry, no analytics, and no crash reporting**, and no plan to add any.

The only host contacted in normal operation is your own npm registry, once, during the
explicit first-run cockpit install. Any model-provider traffic comes from your AI coding
tool (Claude Code and similar) under your own credentials and configuration — this kit
neither proxies nor observes it.

### On the "URL strings" scanner alert

Socket flags documentation filenames (`README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`,
`context.md`) and this project's own GitHub URLs. Audited and confirmed informational: the
GitHub URLs appear in CLI help text and docs as printed strings, never as fetch targets, and
the filenames are the kit's own artifacts. No code change was warranted, and none was made.

---

## 3. Dependency tree

The **published package has zero runtime dependencies**. Everything under `cockpit/` is a
development/UI dependency tree, installed only if you opt into the visual board, and it
carries the usual weight of the React/Vite ecosystem — including transitive advisories that
scanners will surface. That tree is a separate, ongoing cleanup and is not claimed to be
minimal here.

If you want the board without that tree, don't run `npm run board`. The core kit — CLI,
renderer, validator, agents, skills — is dependency-free and fully functional without it.

---

## 4. What this design does and doesn't claim

Heuristic supply-chain scanners flag *any* install-time package-manager execution, and the
`preboard` hook is still that pattern, however tightly constrained. The goal here is a
design that is defensible on the merits — explicit trigger, pinned and reproducible input,
no injectable arguments, loud failure — not a green badge. Expect the anomaly heuristic to
keep firing on the shape of the code.
