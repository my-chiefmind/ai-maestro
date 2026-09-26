---
name: "security-review"
description: "A focused security pass over a change before it lands. Use on tickets touching auth, user input, data access, secrets, external calls, or infra. Flags concrete vulnerabilities with a file:line and a fix — not generic advice."
---

# Security Review

Run this on changes with a security surface: authentication/authorization, anything handling
user input, data access, secret management, outbound network calls, file/path handling, or
infrastructure.

## Look for

- **Injection** — SQL/NoSQL/command/template injection from unsanitized input; unparameterized
  queries. If shell invocation is unavoidable, arguments are passed as an argv array — never an
  interpolated string.
- **AuthZ/AuthN** — missing or wrong access checks; trusting client-supplied identity;
  privilege escalation via object references (IDOR). Role/permission checks are server-side and
  fail closed; ownership checks use the authenticated principal, never a client-supplied id.
- **Secrets** — credentials, tokens, or keys in code, logs, or committed config. Secrets
  belong in a secret store, injected at runtime, never in the repo or in history. Don't just
  eyeball the diff: scan history with `git log -p -S <token>` on suspicious tokens and
  high-entropy string heuristics. A secret that was **ever committed** is always a blocking
  finding, and **rotation — not redaction — is the only remediation**: removing it from the
  tip does nothing, and a history scrub is a separate owner decision made after rotation.
- **SSRF / egress** — user-influenced URLs fetched without validating the destination host
  against an allowlist; cloud metadata endpoints (`169.254.169.254` and friends) and
  link-local ranges not blocked; redirects followed to unvalidated hosts.
- **Rate limiting** — sensitive or expensive endpoints (auth, password reset, LLM-calling,
  email-sending) without rate limiting or quota enforcement. Missing limits are a finding,
  not a nice-to-have.
- **Sensitive data** — PII/credentials sent to third parties (including LLM providers) that
  shouldn't see them; overly broad logging.
- **Input validation** — trusting size, type, or shape of external input; unbounded
  allocations; unsafe deserialization.
- **Transport & config** — missing TLS, permissive CORS, disabled auth in a config a deploy
  might inherit, fail-open where it should fail-closed.
- **Dependencies** — known-vulnerable or unpinned dependencies pulled into the change. Run the
  ecosystem's real audit tool (`npm audit`, `pip-audit`, …) and report **new** advisories;
  confirm the lockfile was updated alongside the dependency change.

## Report

For each finding: the **file:line**, a **concrete exploit scenario** (what an attacker sends
→ what they get), the **severity**, and a **specific fix**. Skip theoretical concerns with no
realistic path. If a change reaches production data or secrets, treat prod access as opt-in —
flag it, don't exercise it.

This pass gates the merge for security-sensitive tickets the same way QA and the release gate
do: unresolved high-severity findings block landing.
