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
  queries.
- **AuthZ/AuthN** — missing or wrong access checks; trusting client-supplied identity;
  privilege escalation via object references (IDOR).
- **Secrets** — credentials, tokens, or keys in code, logs, or committed config. Secrets
  belong in a secret store, injected at runtime, never in the repo or in history.
- **Sensitive data** — PII/credentials sent to third parties (including LLM providers) that
  shouldn't see them; overly broad logging.
- **Input validation** — trusting size, type, or shape of external input; unbounded
  allocations; unsafe deserialization.
- **Transport & config** — missing TLS, permissive CORS, disabled auth in a config a deploy
  might inherit, fail-open where it should fail-closed.
- **Dependencies** — known-vulnerable or unpinned dependencies pulled into the change.

## Report

For each finding: the **file:line**, a **concrete exploit scenario** (what an attacker sends
→ what they get), the **severity**, and a **specific fix**. Skip theoretical concerns with no
realistic path. If a change reaches production data or secrets, treat prod access as opt-in —
flag it, don't exercise it.

This pass gates the merge for security-sensitive tickets the same way QA and the release gate
do: unresolved high-severity findings block landing.
