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

- **`--ignore-scripts`** — not passed *yet*, and the reason is weaker than it looks. Exactly
  one package in the pinned tree runs an install script: `fsevents`, which is dev-only,
  optional, macOS-only, and degrades to polling-based file watching if it isn't built.
  (esbuild ships platform binaries as optional dependencies, not via a postinstall.) So the
  cost of `--ignore-scripts` is slower file watching on macOS, not a broken build. It is a
  live candidate, tracked with the dependency-tree cleanup rather than asserted as
  unnecessary here.
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
| Cockpit data service (`cockpit/server/index.mjs`) | Binds `127.0.0.1:4600`. Listens only; never dials out. | While the board runs |
| Cockpit UI (`cockpit/src/`) | Same-origin relative paths only (`/api/board`, `/api/config`, `/api/roster`, `/api/docs`, `/api/spec/*`). No absolute URLs. | While the board is open |
| Vite dev server | Serves `localhost:5273`, proxies `/api` → `localhost:4600`. | Dev only |
| `npm ci` for the cockpit | Your configured npm registry. | First `npm run board` only |

There is **no telemetry, no analytics, and no crash reporting**, and no plan to add any.

The only host contacted in normal operation is your own npm registry, once, during the
explicit first-run cockpit install. Any model-provider traffic comes from your AI coding
tool (Claude Code and similar) under your own credentials and configuration — this kit
neither proxies nor observes it.

### The cockpit service has no authentication

That is deliberate — it is a single-developer tool on a single machine — but it means
anything able to reach it can read the board, rewrite it, and read any doc in the kit. Three
controls keep "able to reach it" honest:

- **Loopback bind.** `127.0.0.1` only. It previously bound `0.0.0.0`, putting the API on
  every interface; on a shared network that was reachable by anyone. `MAESTRO_HOST`
  overrides this for container port-forwarding and logs a warning when it is not loopback.
- **Host-header allowlist.** Requests must be addressed to `localhost`, `127.0.0.1`, or
  `::1`; anything else gets a 403. Binding loopback alone does not stop **DNS rebinding** —
  a hostile page can point a name it controls at `127.0.0.1` and then talk to the service
  as same-origin, which bypasses CORS entirely. Matching is on hostname, ignoring port, so
  Vite's dev proxy (which forwards the browser's `localhost:5273`) still works.
- **Docs renderer allowlist.** `/api/docs/render` serves only the curated set `/api/docs`
  advertises. It previously accepted any `.md` under the kit root, which included
  `board/specs/*.md` — files the same service writes on request via `PUT /api/spec/:id`.
  Since `marked` does not sanitise and the UI injects the result with
  `dangerouslySetInnerHTML`, "write a spec, then ask for it to be rendered" ran script in
  the cockpit's origin, and from there could rewrite the board that agents act on.

**Residual risk, stated plainly:** the renderer is still unsanitised. The allowlist stops it
reaching the content most easily made hostile, but the docs it does render — `agents/*.md`,
`skills/*/SKILL.md` — are authored by AI agents in normal use. A prompt-injected agent that
writes a `<script>` tag into an agent or skill file still gets script execution in the
cockpit origin. Closing that properly needs HTML sanitisation, which means a new runtime
dependency, and is tracked with the dependency-tree work rather than done quietly here.
Doc images are served with `default-src 'none'; sandbox` so an SVG cannot carry script.

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
