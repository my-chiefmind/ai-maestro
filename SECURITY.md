# Security

This document covers three things reviewers and scanners repeatedly ask about:
when this package executes code, what it trusts, and what it talks to over the network.

> To report a vulnerability, email **info@mychiefmind.com**. Please don't open a public issue
> for anything exploitable.

### At a glance

| Question | Answer | Detail |
| --- | --- | --- |
| Does installing run code? | ✅ **No** — no install lifecycle hooks, enforced by test | [§1](#1-install-time-behaviour) |
| Runtime dependencies? | ✅ **Zero** in the published package | [§3](#3-dependency-tree) |
| Outbound network calls? | Explicit commands can contact registries/remotes; no telemetry, analytics, or crash reporting | [§2](#2-runtime-network-surface) |
| Does the kit run a server? | ✅ **No** — the visual board is the separate `@mychiefmind/ai-maestro-web-ui` package, fetched only on explicit `npm run board` | [§2](#the-visual-board-is-a-separate-package) |

### Contents

| § | Section |
| :--: | --- |
| **1** | [Install-time behaviour](#1-install-time-behaviour) |
| **2** | [Runtime network surface](#2-runtime-network-surface) |
| **3** | [Dependency tree](#3-dependency-tree) |
| **4** | [What this design does and doesn't claim](#4-what-this-design-does-and-doesnt-claim) |
| **5** | [Executable project configuration](#5-executable-project-configuration) |

---

## 1. Install-time behaviour

> **Installing this package executes nothing.**

`@mychiefmind/ai-maestro` declares no `preinstall`, `install`, `postinstall`, or `prepare`
script, and has **zero runtime dependencies**. `npm i @mychiefmind/ai-maestro` copies files
and stops. The single `prepublishOnly` hook runs the board validator on the maintainer's
machine at publish time and never on a consumer's.

This is enforced by tests, not just convention — see
`test/package-hooks.test.mjs`, which fails if any install lifecycle hook is ever added to
this package or to the `package.json` that `maestro setup` vendors into a user's repo.

The kit no longer vendors a UI with its own dependency tree. `npm run board` runs
`npx --yes @mychiefmind/ai-maestro-web-ui`, which fetches that separate package from your npm
registry — only when a user explicitly starts the board, never during install. During
`maestro setup` it is behind a y/n prompt, and a run without a TTY never starts it.

### Trust assumptions around vendored content

`maestro setup` copies kit content (`agents/`, `skills/`, `render/`, `board/`, `scripts/`,
…) out of the installed package and into `<repo>/maestro/`. The trust model:

- **The vendored bytes are the bytes npm delivered.** Integrity of that delivery is npm's
  registry signatures plus the consumer's own lockfile — the standard chain for any package.
- **We do not ship a checksum manifest over our own vendored content, deliberately.** Such a
  manifest would travel in the same tarball as the content it verifies, so anyone able to
  modify `scripts/` could modify the manifest in the same edit. It would add a fail-closed
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

The kit has no telemetry, analytics, or crash reporting. Explicit operations can invoke
network-capable tools:

| Component | Contacts | When |
| --- | --- | --- |
| CLI update checks and `maestro drift` | Configured npm registry through `npm view` | When checking versions; drift supports `--offline` |
| CLI updates and ticket workflows | Configured Git remotes and code-host APIs through Git and the host CLI | When updating, pushing, or managing pull requests |
| `npm run board` | Configured npm registry through `npx` | When starting the separate dashboard |
| Plan enforcement and configured test commands | Whatever the project command accesses | When explicitly executing those checks |
| Usage snapshot HTML | Google Fonts | When opening a generated snapshot in a browser |

Model-provider traffic comes from the configured AI coding tool under the user's
credentials. The kit does not proxy that traffic.

### The visual board is a separate package

The kit ships no server. The visual board is `@mychiefmind/ai-maestro-web-ui`, published and
versioned separately; it binds loopback only (`127.0.0.1`, port 3021 or the next free one), and
its security model is documented in that package. It depends only on this kit's public exports
(`./board`, `./plan`, `./spec`, `./registry`, `./usage`) and writes through the same locked,
validated write path as the CLI.

### On the "URL strings" scanner alert

The 0.6.17 report lists localhost dashboard URLs, the repository URL, and Google Fonts
URLs. Localhost and repository links appear in help text. Generated usage snapshot HTML
loads Google Fonts when opened; this is a browser request, not telemetry from the CLI.
URL presence alone does not demonstrate malicious behavior.

---

## 3. Dependency tree

| Scope | Dependencies | Installed |
| --- | --- | --- |
| Published package — CLI, renderer, validator, agents, skills | **Zero runtime dependencies** | Always |
| `@mychiefmind/ai-maestro-web-ui` — the optional visual board | Its own package and dependency tree | Only when you opt in with `npm run board` |

The **published package has zero runtime dependencies**. The visual board's dependency tree
belongs to the separate web dashboard package and is fetched only if you run `npm run board`.
The core kit — CLI, renderer, validator, agents, skills — is dependency-free and fully
functional without it.

---

## 4. What this design does and doesn't claim

The kit has no install-time execution and no `preboard` hook. The one place it asks a package
manager to fetch code is `npm run board`, an explicit user action that runs a separately
published package via `npx`. The goal is a design that is defensible on the merits — explicit
trigger, no injectable arguments, no hidden install step — not a green badge.


## 5. Executable project configuration

`maestro plan check` intentionally executes each selected plan item's `enforce` command
with the user's shell and permissions, like a project test script. Plans, test commands,
workflow configuration, agent instructions, and run records must come from trusted sources.
Review changes to them before running agents or checks, especially in pull requests from
untrusted contributors. Do not run those checks with secrets or privileged CI credentials.

Use `maestro plan check --dry-run` (optionally with `--traces` and `--json`) to inspect
commands and their working directory without executing them. A preview is not a sandbox
or an approval bound to later file contents; review the actual revision that will execute.

The orchestrator does not copy local `.env` files into worktrees. Missing test credentials
must be handled through the project's documented configuration or reported as a blocker.
Writer instructions require staging intended files and reviewing the staged diff instead
of blanket staging. Workflow command data is quoted for POSIX shells; configured command
strings remain executable code. Shell quoting does not prevent an agent from following
malicious natural-language instructions, and these prompts are not a security sandbox.
