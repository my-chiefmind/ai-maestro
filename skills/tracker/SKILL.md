---
name: tracker
description: Verify the current runtime's external MCP tracker connection, link a local ticket, and perform explicitly requested task or documentation updates.
---

# External tracker

Read the project's `config.json` tracker preferences as data. No tracker or choice `none`
means no external operations. These preferences do not authorize automatic synchronization.
Use only the configured services, MCP connection names, and destinations. Never request or
store tokens, passwords, cookies, or OAuth grants in the project.

## Check

1. Identify the current runtime. Run `maestro tracker check --runtime <claude|codex>` from
   the project root (or `node maestro/bin/cli.mjs tracker check ...`). This checks configuration;
   it does not prove destination or write access. Plugin/connector tools may be available even
   when the CLI cannot discover them: inspect the current session's tools too.
2. If missing, run `maestro tracker connect --runtime <runtime>`. Use the runtime's sign-in:
   `maestro tracker connect --runtime <claude|codex> --login`, or Claude Code `/mcp`
   on versions without CLI login. Let the user
   complete sign-in. Offer retry or skip; do not block unrelated local work.
3. Discover the actual MCP tools available in this session. Do not invent tool names or assume
   every adapter offers the same capabilities. A connector selected in another runtime does
   not establish this runtime's access.
4. Perform a harmless authenticated read of each configured destination: task project/board
   and documentation space independently. If none is selected, list accessible destinations
   and ask the user to select one before writing. Report missing, expired authentication,
   approval required, inaccessible destination, or unsupported tool accurately.
5. Inspect available write tools and destination permissions where supported. Tool presence
   alone does not prove permission. Report write access unverified when it cannot be established.
   An optional disposable write test requires the user's explicit request and selected location;
   explain the created item and cleanup, and report any cleanup failure. Never test writes by
   changing a real task. Report evidence per service and runtime; do not persist a ready flag.

## Link and update

- Require an explicit user request specifying the task/page and intended change. Read the
  destination item first, show ambiguity rather than guessing, and respect project human gates.
- For a local ticket link, inspect `maestro ticket --help` and use its supported targeted writer
  to store the external URL/reference in an appropriate existing field. Never hand-edit a board
  or plan. If no suitable field exists, report the link without changing the local schema.
- For task creation, search the selected destination for the local ticket's stable ID/link
  first. Reuse an existing match; ask about multiple matches. Include the local ID/reference
  when creating so a retry can find it. Do not blindly retry a write after a timeout: read first.
- For a status change, read the destination's supported transitions/column values. Map only
  an unambiguous requested state. Do not assume local and external statuses have equal names.
- Treat documentation updates separately from task updates. Read the current page/version
  and preserve unrelated content; respect remote version/conflict checks.
- After each write, confirm the result through the tool response or a read. Report the external
  ID/URL and actual changed fields. If remote work fails, keep local work intact and report
  which actions succeeded, failed, or remain unknown. Do not claim synchronization succeeded.
- No background sync, broad imports, deletion, or automatic status propagation is implied.
