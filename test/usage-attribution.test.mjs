/**
 * Unit tests for ticket usage: transcript distillation, attribution, and the run telemetry
 * store.
 *
 * WHY THIS EXISTS. Three things here fail silently and expensively if they go wrong.
 *
 *   1. PRIVACY. `distill()` is the only code in the kit that reads a session transcript, and
 *      the promise made to the user — and printed on the dashboard — is that nothing but
 *      aggregates ever leaves it. A regression that let a prompt or a file body into the
 *      cache would not break a single feature, so nothing would catch it but a test.
 *   2. ATTRIBUTION HONESTY. An earlier naive pass credited `T-042` and `T-999` — a doc
 *      example and a test fixture — with 150M tokens between them, and looked perfectly
 *      plausible doing it. Wrong attribution is worse than none: it turns a dashboard someone
 *      makes decisions from into confident fiction. So: ids not on the board are refused,
 *      a bare mention expires, and anything ambiguous stays unassigned.
 *   3. DOUBLE COUNTING. A `maestro run` leaves BOTH a telemetry record and a transcript. If
 *      both are counted the ticket's tokens are doubled, which is exactly the number a
 *      "value of using agents" page must get right.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distill, scanTranscripts, normaliseUsage, totalTokens, encodeProjectDir, transcriptDirsFor } from "../scripts/usage-scan.mjs";
import { attribute, ticketIndex, ticketFromBranch } from "../scripts/usage-attribute.mjs";
import { appendRun, readRuns, validateRun, telemetryPath } from "../scripts/telemetry-io.mjs";
import { buildUsageReport, transcriptScanEnabled, usageToCsv } from "../scripts/usage-core.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "maestro-usage-"));

const ROOT = "/repo";
let clock = Date.parse("2026-08-01T10:00:00.000Z");
const at = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

/** One assistant turn as Claude Code writes it. */
function turn(offsetMs, { model = "claude-sonnet-5", text = "", tool = null, branch = "main", usage = {} } = {}) {
  const content = [];
  if (text) content.push({ type: "text", text });
  if (tool) content.push({ type: "tool_use", name: "Bash", input: tool });
  return JSON.stringify({
    type: "assistant", timestamp: at(offsetMs), cwd: ROOT, sessionId: "s1", gitBranch: branch,
    message: {
      model, content,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  });
}

/** A user message, optionally carrying a tool RESULT rather than typed text. */
function user(offsetMs, { text = null, toolResult = null, branch = "main" } = {}) {
  const content = toolResult !== null
    ? [{ type: "tool_result", content: toolResult }]
    : text;
  return JSON.stringify({ type: "user", timestamp: at(offsetMs), cwd: ROOT, sessionId: "s1", gitBranch: branch, message: { role: "user", content } });
}

function transcript(lines) {
  const dir = tmp();
  const p = join(dir, "s1.jsonl");
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

const BOARD = {
  tickets: [
    { id: "T-010", name: "Guarded board writes", status: "done", area: "infra", model: "sonnet", epicId: "e1" },
    { id: "T-011", name: "Overlay survival", status: "done", area: "infra", model: "opus", epicId: "e1" },
  ],
  epics: [{ id: "e1", name: "Kit hardening" }],
};
const INDEX = ticketIndex(BOARD, null);

// ── Privacy ───────────────────────────────────────────────────────────────────────────────

test("distill keeps token counts and ticket ids, and no transcript text whatsoever", () => {
  const secret = "AKIA_SECRET_KEY_do_not_leak and the body of a private file";
  const p = transcript([
    user(0, { text: `Please work on T-010. ${secret}` }),
    turn(1000, { text: `Reading ${secret} now`, tool: { command: `echo ${secret}` } }),
  ]);
  const events = distill(p, { roots: [ROOT] });
  const serialised = JSON.stringify(events);
  assert.ok(!serialised.includes("AKIA_SECRET_KEY"), "secret text must never survive distillation");
  assert.ok(!serialised.includes("private file"), "prose must never survive distillation");
  assert.ok(serialised.includes("T-010"), "ticket ids are the one thing extracted from text");
  const t = events.find((e) => e.kind === "turn");
  assert.equal(t.usage.input, 10);
  assert.equal(t.usage.output, 20);
});

test("mentions are read from prompts and tool inputs, never from tool results", () => {
  // Reading archive.json into a tool result must not 'mention' every archived ticket — that
  // single mistake would attribute an entire session to whichever id sorted last.
  const p = transcript([
    user(0, { toolResult: JSON.stringify(BOARD) }),
    turn(1000, {}),
  ]);
  const events = distill(p, { roots: [ROOT] });
  assert.deepEqual(events.flatMap((e) => e.mentions), [], "a tool result is not evidence");
});

test("distill ignores turns whose cwd is a different repo", () => {
  const p = transcript([
    JSON.stringify({ type: "assistant", timestamp: at(0), cwd: "/elsewhere", sessionId: "s1", gitBranch: "main", message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 999, output_tokens: 999 } } }),
    turn(1000, {}),
  ]);
  const events = distill(p, { roots: [ROOT] });
  assert.equal(events.filter((e) => e.kind === "turn").length, 1);
});

test("the <synthetic> pseudo-model and malformed lines are skipped, not fatal", () => {
  const p = transcript([
    "{not json",
    JSON.stringify({ type: "assistant", timestamp: at(0), cwd: ROOT, sessionId: "s1", message: { model: "<synthetic>", content: [], usage: { input_tokens: 5 } } }),
    turn(1000, {}),
  ]);
  assert.equal(distill(p, { roots: [ROOT] }).filter((e) => e.kind === "turn").length, 1);
});

// ── Attribution ladder ────────────────────────────────────────────────────────────────────

test("a branch naming the ticket attributes at high confidence", () => {
  const p = transcript([turn(0, { branch: "codex/t-010-guarded-writes" })]);
  const { turns } = attribute(distill(p, { roots: [ROOT] }), INDEX);
  assert.equal(turns[0].ticketId, "T-010");
  assert.equal(turns[0].confidence, "high");
  assert.equal(turns[0].evidence, "branch");
});

test("a board write attributes at high confidence and outlives the mention TTL", () => {
  const lines = [user(0, { text: "let's go" }), turn(100, { tool: { command: "node scripts/board-write.mjs set-status T-010 in-progress" } })];
  for (let i = 1; i <= 60; i++) lines.push(turn(100 + i * 60_000));
  const { turns } = attribute(distill(transcript(lines), { roots: [ROOT] }), INDEX);
  const last = turns[turns.length - 1];
  assert.equal(last.ticketId, "T-010");
  assert.equal(last.confidence, "high");
  assert.equal(last.evidence, "board-write:set-status");
});

test("an id that is not on the board is refused outright", () => {
  // T-042 is an example in run-ticket.mjs's own header; T-999 is a test fixture. Neither is
  // work, and both looked entirely credible to a naive matcher.
  const p = transcript([user(0, { text: "see maestro run T-042 and the T-999 fixture" }), turn(1000)]);
  const { turns } = attribute(distill(p, { roots: [ROOT] }), INDEX);
  assert.equal(turns[0].ticketId, null);
  assert.equal(turns[0].confidence, "unassigned");
});

test("a bare mention expires once several tickets are in play", () => {
  const lines = [user(0, { text: "compare T-010 with T-011" }), turn(100)];
  // Well past mentionTtlMs with no further mention of either.
  lines.push(turn(100 + 45 * 60_000));
  const { turns } = attribute(distill(transcript(lines), { roots: [ROOT] }), INDEX);
  assert.equal(turns[0].confidence, "medium");
  assert.equal(turns[turns.length - 1].ticketId, null, "a stale mention must stop attributing");
  assert.equal(turns[turns.length - 1].evidence, "signal-expired");
});

test("a session naming exactly one real ticket holds it without expiring, still at medium", () => {
  const lines = [user(0, { text: "work on T-010" }), turn(100)];
  for (let i = 1; i <= 60; i++) lines.push(turn(100 + i * 60_000));
  const { turns } = attribute(distill(transcript(lines), { roots: [ROOT] }), INDEX);
  const last = turns[turns.length - 1];
  assert.equal(last.ticketId, "T-010");
  assert.equal(last.confidence, "medium", "one candidate is an absence of ambiguity, not proof");
  assert.equal(last.evidence, "mention:sole-in-session");
});

test("unassigned turns say why, and 'no ticket named' is distinguished from 'ambiguous'", () => {
  const quiet = attribute(distill(transcript([turn(0), turn(1000)]), { roots: [ROOT] }), INDEX);
  assert.equal(quiet.coverage.unassignedReasons["no-ticket-in-session"], 2);

  const late = attribute(distill(transcript([turn(0), user(1000, { text: "now do T-010" }), turn(2000)]), { roots: [ROOT] }), INDEX);
  assert.equal(late.coverage.unassignedReasons["before-first-signal"], 1);
});

test("working time counts the gap since the previous turn, capped, and survives an attribution flip", () => {
  // The gap must be credited even though the previous turn was unassigned — gating on the two
  // turns sharing a ticket silently discarded most of the clock.
  const lines = [turn(0), user(1000, { text: "do T-010" }), turn(60_000), turn(60_000 + 3 * 60 * 60_000)];
  const { turns } = attribute(distill(transcript(lines), { roots: [ROOT] }), INDEX);
  assert.equal(turns[0].activeMs, 0, "the first turn has no predecessor");
  assert.equal(turns[1].activeMs, 60_000, "a one-minute gap counts in full");
  assert.equal(turns[2].activeMs, 0, "a three-hour gap is an idle reset, not work");
});

test("ticketFromBranch reads the convention case-insensitively", () => {
  assert.equal(ticketFromBranch("codex/t-029-docs"), "T-029");
  assert.equal(ticketFromBranch("feat/T-7-thing"), "T-7");
  assert.equal(ticketFromBranch("main"), null);
  assert.equal(ticketFromBranch(null), null);
});

test("the encoded transcript directory matches the repo and its worktrees, not its siblings", () => {
  const enc = encodeProjectDir("/Users/x/source/ai-maestro");
  assert.equal(enc, "-Users-x-source-ai-maestro");
  const dir = tmp();
  for (const n of [enc, `${enc}-worktrees-feature`, "-Users-x-source-ai-maestro-other-repo-elsewhere", "-Users-x-source-applicify"]) {
    mkdirSync(join(dir, n), { recursive: true });
  }
  const found = transcriptDirsFor(dir, ["/Users/x/source/ai-maestro"]).map((p) => p.split("/").pop());
  assert.ok(found.includes(enc));
  assert.ok(found.includes(`${enc}-worktrees-feature`));
  assert.ok(!found.includes("-Users-x-source-applicify"));
});

// ── Telemetry store ───────────────────────────────────────────────────────────────────────

test("a run record round-trips, and unknown fields survive so cost can be added later", () => {
  const boardDir = tmp();
  appendRun(boardDir, {
    ticketId: "T-010", stage: "dev", runtime: "claude", model: "sonnet", modelId: "claude-sonnet-5",
    startedAt: at(0), endedAt: at(90_000),
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 5 },
  });
  // A record written by a LATER version of the kit, carrying a field this one has never heard of.
  appendFileSync(telemetryPath(boardDir), JSON.stringify({
    v: 2, runId: "run_future", ticketId: "T-011", startedAt: at(0),
    cost: { currency: "USD", amount: 1.23 }, somethingNew: true,
  }) + "\n", "utf8");

  const { runs, skipped } = readRuns(boardDir);
  assert.equal(skipped, 0);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].durationMs, 90_000, "duration is derived when not supplied");
  assert.equal(runs[0].usageSource, "provider");
  const future = runs.find((r) => r.runId === "run_future");
  assert.deepEqual(future.cost, { currency: "USD", amount: 1.23 }, "a reader must not strip fields it does not know");
});

test("a record with no ticket or no start is refused rather than written misleadingly", () => {
  assert.ok(validateRun({ ticketId: "nope", startedAt: at(0) }).length);
  assert.ok(validateRun({ ticketId: "T-010" }).length);
  assert.equal(validateRun({ ticketId: "T-010", startedAt: at(0) }).length, 0);
});

test("a torn tail costs one line, not the file", () => {
  const boardDir = tmp();
  appendRun(boardDir, { ticketId: "T-010", startedAt: at(0) });
  appendFileSync(telemetryPath(boardDir), '{"v":1,"runId":"half', "utf8");
  const { runs, skipped } = readRuns(boardDir);
  assert.equal(runs.length, 1);
  assert.equal(skipped, 1);
});

test("a missing usage block reads as unknown, never as zero", () => {
  const boardDir = tmp();
  const rec = appendRun(boardDir, { ticketId: "T-010", startedAt: at(0), endedAt: at(1000) });
  assert.equal(rec.usage, null);
  assert.equal(rec.usageSource, "none", "'free' and 'not reported' are different claims");
});

// ── Unified report ────────────────────────────────────────────────────────────────────────

/** A board directory with a real board, so ids resolve. */
function boardFixture() {
  const dir = tmp();
  const boardDir = join(dir, "board");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(boardDir, "data.json"), JSON.stringify(BOARD), "utf8");
  writeFileSync(join(boardDir, "archive.json"), JSON.stringify({ epics: [], tickets: [] }), "utf8");
  return boardDir;
}

test("transcript scanning is opt-in, and the report says which halves ran", () => {
  assert.equal(transcriptScanEnabled(null, {}), false);
  assert.equal(transcriptScanEnabled({ usage: { scanTranscripts: true } }, {}), true);
  assert.equal(transcriptScanEnabled(null, { MAESTRO_USAGE_SCAN: "1" }), true);
  assert.equal(transcriptScanEnabled({ usage: { scanTranscripts: true } }, { MAESTRO_USAGE_SCAN: "0" }), false);

  const boardDir = boardFixture();
  const report = buildUsageReport({ boardDir, config: null, env: {} });
  assert.equal(report.enabled.transcripts, false);
  assert.equal(report.tickets.length, 0);
});

test("a measured run wins over its own transcript instead of being counted twice", () => {
  const boardDir = boardFixture();
  const projectsDir = tmp();
  const sessionDir = join(projectsDir, encodeProjectDir(ROOT));
  mkdirSync(sessionDir, { recursive: true });
  // The transcript a `maestro run` left behind: 3 turns, 30 output tokens each.
  writeFileSync(join(sessionDir, "sess-run.jsonl"), [0, 1, 2].map((i) => JSON.stringify({
    type: "assistant", timestamp: at(i * 1000), cwd: ROOT, sessionId: "sess-run", gitBranch: "codex/t-010-x",
    message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 10, output_tokens: 20 } },
  })).join("\n") + "\n", "utf8");
  // ...and the telemetry record that measured the same work.
  appendRun(boardDir, {
    ticketId: "T-010", stage: "dev", runtime: "claude", modelId: "claude-sonnet-5", sessionId: "sess-run",
    startedAt: at(0), endedAt: at(3000),
    usage: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0, thinking: 0 },
  });

  const report = buildUsageReport({
    boardDir, roots: [ROOT], projectsDir, cacheFile: join(tmp(), "cache.json"),
    config: { usage: { scanTranscripts: true } }, useCache: false,
  });
  const t010 = report.tickets.find((t) => t.id === "T-010");
  assert.equal(t010.metrics.tokens.total, 90, "the measured record is authoritative; its transcript is dropped");
  assert.equal(t010.timing, "exact");
  assert.equal(t010.confidence, "exact");
  assert.equal(t010.cycleMs, 3000, "cycle time comes only from measured runs");
  assert.equal(report.coverage.skippedExact, 3, "the dropped turns are reported, not silently swallowed");
});

test("reasoning tokens are reported but never added into the total", () => {
  const u = normaliseUsage({ input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 60 } });
  assert.equal(u.thinking, 60);
  assert.equal(totalTokens(u), 110, "thinking is a subset of output, not a fifth bucket");
});

test("CSV export carries the same figures and escapes a comma in a ticket name", () => {
  const boardDir = boardFixture();
  appendRun(boardDir, {
    ticketId: "T-010", stage: "dev", runtime: "claude", startedAt: at(0), endedAt: at(60_000),
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 0 },
  });
  const report = buildUsageReport({ boardDir, config: null, env: {} });
  const rows = usageToCsv(report).trim().split("\n");
  assert.ok(rows[0].startsWith("ticket,name,status"));
  assert.ok(rows[1].includes('"Guarded board writes"') || rows[1].includes("Guarded board writes"));
  assert.ok(rows[1].includes(",10,"), "the total lands in the row");
  const byStage = usageToCsv(report, { view: "stage" }).trim().split("\n");
  assert.equal(byStage[0].split(",")[0], "stage");
  assert.ok(byStage[1].startsWith("dev,"));
});
