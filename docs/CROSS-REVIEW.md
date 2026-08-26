# Cross-review: independent dev and reviewer roles

By default, a ticket runs its whole `agent_plan` pipeline (implement → qa → pd → merge)
inside one interactive session, on one runtime. Cross-review is an opt-in alternative for a
ticket where you want the **implementation** and the **review** done by independently chosen
agents — a different model, a different runtime (Claude vs Codex), or both — with a real
GitHub pull request as the handoff between them.

## Setting it up

Four optional ticket fields are set from the cockpit's ticket drawer (Dev / Reviewer pickers)
or through the guarded writer:

```sh
maestro ticket set-routing T-042 \
  --dev-runtime claude --dev-model claude-sonnet-4-5 \
  --reviewer-runtime codex --reviewer-model gpt-5.4
```

Use `--clear` to remove all four ticket overrides. Never edit `board/data.json` directly.

| Field | Values | Meaning |
| --- | --- | --- |
| `dev_runtime` | Runtime adapter id | The adapter that implements the ticket. The bundled runner supports `claude` and `codex`. |
| `dev_model` | Model id or portable tier | The dev role's model selection. |
| `reviewer_runtime` | Runtime adapter id | The adapter that reviews the dev role's PR. |
| `reviewer_model` | Model id or portable tier | The reviewer role's model selection. |

All four are independent of the plain `model` field (which keeps meaning "the tier for the
classic single-pipeline `agent_plan`") and independent of each other — the reviewer can be the
same runtime as the dev role with a different model, or a different runtime entirely.

A project can set defaults instead of repeating this per ticket, in `config.json`:

```json
"crossReview": {
  "dev":      { "runtime": "claude", "model": "sonnet" },
  "reviewer": { "runtime": "codex",  "model": "opus" }
}
```

A ticket's own fields override the config default for that role; a ticket with neither its
own fields nor a project default is not cross-review-enabled — it just runs the classic way.

Claude model values are passed to `claude --model`. For Codex, the portable tiers map to
reasoning effort (`haiku`→low, `sonnet`→medium, `opus`→high); any other value is passed as the
literal model id via `codex exec -m`. See [MODEL-ROUTING.md](./MODEL-ROUTING.md).

### Test command

`maestro run` refuses to create or merge a PR for a ticket with no test command — either the
ticket's own `testCmd`, or an area default at `config.orchestrator.testCmd.<area>`. Set it from
the cockpit drawer's "Test command" field, or:

```sh
maestro ticket set-testcmd T-042 --cmd "npm test"
```

Use `--clear` to remove a ticket-level override (an area default may still apply).

## Running the pipeline

`maestro run <ticket-id>` is a **triggered, one-shot pipeline** — not a background daemon, and
not a shortcut around the rest of the kit's safety rules. One invocation:

1. **Eligibility.** Refuses a ticket that isn't `todo`, is human-gated, has an unmet
   dependency, or is out of the plan's scope — the same gate `eligibleTickets()` applies
   everywhere else. The first board write is version-guarded, so two concurrent `maestro run`
   calls on the same ticket can't both win.
2. **Isolated dev stage.** Creates a dedicated `git worktree` at `../.maestro-wt/<id>` on a
   deterministic branch (`feat/<id>-<slug>`) — the same convention the `worktree-cleanup`
   skill uses — and runs the dev role there, never in your primary checkout. The dev role only
   implements, tests, and commits. The runner verifies a clean committed handoff, runs the
   configured test command, pushes the deterministic branch, creates the PR, then finds it via
   `gh pr list --head <branch>` rather than trusting whatever URL the agent claims.
3. **Reviewer stage.** Runs the reviewer role (its own `reviewer_runtime`/`reviewer_model`,
   using a distinct GitHub identity — see below) against the same worktree, instructed to
   take one real action itself: `gh pr review --approve`, `--comment`, or `--request-changes`.
   The verdict this script acts on is read back from **GitHub's own review history**
   (`gh pr view --json reviews`) afterward, not the agent's self-report — an "approve" GitHub
   didn't actually record is a hard failure, not a silent success. Any reviewer mutation of
   the worktree also rejects the verdict.
4. **Acts on the verified verdict:**
   - **request-changes** → files a blocker ticket with the reviewer's notes (`maestro ticket
     block`), same as any other failed gate. The worktree is left in place for the next pass.
   - **comment** → the ticket stays `review`; the comment is on the PR for a human to read.
   - **approve** → with `--auto-merge`, re-runs local verification, waits for reported PR
     checks, squash-merges, confirms GitHub recorded the merge commit, archives the ticket with
     evidence, and cleans up the worktree/branch. Without `--auto-merge` (the
     default), the PR is left approved and unmerged, and the command prints exactly what to
     run to finish landing it by hand.

Set `MAESTRO_REVIEWER_GH_TOKEN` to the reviewer account's token. The runner resolves both GitHub
logins and refuses the handoff if they are the same; GitHub does not permit a pull-request
author to provide an independent approval. The token is environment-only so it does not appear
in command history or process arguments, and every non-dry run requires it.

Merging is never automatic unless you pass `--auto-merge` — a hard-to-reverse, shared-branch
action stays confirm-first by default, independent of whatever the reviewer decided. Every
board mutation goes through the same locked, validated write path as the CLI and cockpit use
elsewhere (`scripts/board-write.mjs`), so a run that fails partway leaves the ticket in a state
you can inspect. Because the PR is found by branch name rather than kept only in memory,
`--resume` on an already `in-progress`/`review` ticket picks up its existing PR instead of
re-running (and potentially duplicating) the dev stage.

Run `maestro run --help` for the full flag list, including `--dry-run` (resolves eligibility,
roles, branch, and worktree path; touches nothing), and `--claude-flag`/`--codex-flag`
(forwarded verbatim to the dev/reviewer CLI). **Headless dispatch needs your
own permission/sandbox bypass flags** — every environment's policy differs, so `maestro run`
never chooses one for you. Only enable unattended runs in an environment you trust to run
network-capable agents that write code, push branches, and open/review pull requests without a
human approving each tool call.

Try `--dry-run` on a real ticket before ever running it with `--auto-merge` against a real
repository, and read a run's console output — it names the exact worktree, branch, and PR at
every step, and tells you exactly what to run by hand if anything needs a closer look.
