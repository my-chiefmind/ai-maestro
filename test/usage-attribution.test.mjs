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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { distill, normaliseUsage, totalTokens, encodeProjectDir, transcriptDirsFor, ownsCwd, eventsForRoots } from "../scripts/usage-scan.mjs";
import { attribute, ticketIndex, ticketFromBranch } from "../scripts/usage-attribute.mjs";
import { appendRun, readRuns, validateRun, telemetryPath } from "../scripts/telemetry-io.mjs";
import { buildUsageReport, transcriptScanEnabled, usageToCsv } from "../scripts/usage-core.mjs";
import { buildPortfolioUsage, discoverProjects, projectsFromRegistry } from "../scripts/usage-portfolio.mjs";
import { renderUsageSnapshot } from "../scripts/usage-snapshot.mjs";
import { parseClaudeEnvelope, wantsJsonEnvelope } from "../scripts/run-stage.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "maestro-usage-"));
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
  const events = distill(p);
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
  const events = distill(p);
  assert.deepEqual(events.flatMap((e) => e.mentions), [], "a tool result is not evidence");
});

test("a turn from a different repo is not this board's, and ownership is decided outside distill", () => {
  // distill keeps every event with its cwd so ONE cached parse can serve any caller; the
  // caller filters. Baking the filter in would make the cache valid for only the first
  // question it was asked.
  const p = transcript([
    JSON.stringify({ type: "assistant", timestamp: at(0), cwd: "/elsewhere", sessionId: "s1", gitBranch: "main", message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 999, output_tokens: 999 } } }),
    turn(1000, {}),
  ]);
  const events = distill(p);
  assert.equal(events.filter((e) => e.kind === "turn").length, 2, "distill keeps both, tagged by cwd");
  assert.equal(eventsForRoots(events, [ROOT]).filter((e) => e.kind === "turn").length, 1);
});

test("a repo nested inside another belongs to the deeper one only, never to both", () => {
  // ~/source/lense-kit and ~/source/lense-kit/applicify-group/applicify are both real boards.
  // Plain prefix matching bills the inner repo's turns to BOTH — in a portfolio rollup that
  // double-counts the nested project and credits the parent with work it never did.
  const outer = "/src/kit";
  const inner = "/src/kit/group/app";
  assert.equal(ownsCwd(`${inner}/x`, [outer], [inner]), false, "the parent must not claim the child");
  assert.equal(ownsCwd(`${inner}/x`, [inner], [outer]), true, "the child claims itself");
  assert.equal(ownsCwd(`${outer}/x`, [outer], [inner]), true, "the parent keeps its own work");
  assert.equal(ownsCwd("/src/other/x", [outer], [inner]), false);
  // A sibling project can never suppress work that is genuinely ours.
  assert.equal(ownsCwd(`${outer}/x`, [outer], ["/src/sibling"]), true);
});

test("the <synthetic> pseudo-model and malformed lines are skipped, not fatal", () => {
  const p = transcript([
    "{not json",
    JSON.stringify({ type: "assistant", timestamp: at(0), cwd: ROOT, sessionId: "s1", message: { model: "<synthetic>", content: [], usage: { input_tokens: 5 } } }),
    turn(1000, {}),
  ]);
  assert.equal(distill(p).filter((e) => e.kind === "turn").length, 1);
});

// ── Attribution ladder ────────────────────────────────────────────────────────────────────

test("a branch naming the ticket attributes at high confidence", () => {
  const p = transcript([turn(0, { branch: "codex/t-010-guarded-writes" })]);
  const { turns } = attribute(distill(p), INDEX);
  assert.equal(turns[0].ticketId, "T-010");
  assert.equal(turns[0].confidence, "high");
  assert.equal(turns[0].evidence, "branch");
});

test("a board write attributes at high confidence and outlives the mention TTL", () => {
  const lines = [user(0, { text: "let's go" }), turn(100, { tool: { command: "node scripts/board-write.mjs set-status T-010 in-progress" } })];
  for (let i = 1; i <= 60; i++) lines.push(turn(100 + i * 60_000));
  const { turns } = attribute(distill(transcript(lines)), INDEX);
  const last = turns[turns.length - 1];
  assert.equal(last.ticketId, "T-010");
  assert.equal(last.confidence, "high");
  assert.equal(last.evidence, "board-write:set-status");
});

test("an id that is not on the board is refused outright", () => {
  // T-042 is an example in run-ticket.mjs's own header; T-999 is a test fixture. Neither is
  // work, and both looked entirely credible to a naive matcher.
  const p = transcript([user(0, { text: "see maestro run T-042 and the T-999 fixture" }), turn(1000)]);
  const { turns } = attribute(distill(p), INDEX);
  assert.equal(turns[0].ticketId, null);
  assert.equal(turns[0].confidence, "unassigned");
});

test("a bare mention expires once several tickets are in play", () => {
  const lines = [user(0, { text: "compare T-010 with T-011" }), turn(100)];
  // Well past mentionTtlMs with no further mention of either.
  lines.push(turn(100 + 45 * 60_000));
  const { turns } = attribute(distill(transcript(lines)), INDEX);
  assert.equal(turns[0].confidence, "medium");
  assert.equal(turns[turns.length - 1].ticketId, null, "a stale mention must stop attributing");
  assert.equal(turns[turns.length - 1].evidence, "signal-expired");
});

test("a session naming exactly one real ticket holds it without expiring, still at medium", () => {
  const lines = [user(0, { text: "work on T-010" }), turn(100)];
  for (let i = 1; i <= 60; i++) lines.push(turn(100 + i * 60_000));
  const { turns } = attribute(distill(transcript(lines)), INDEX);
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
  const { turns } = attribute(distill(transcript(lines)), INDEX);
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

// ── Board-defined id prefixes ─────────────────────────────────────────────────────────────

test("a board's own id prefix is honoured, not a hardcoded T-", () => {
  // lense-kit numbers its tickets kit-096 and applicify used tl-226. Hardcoding `T-\d+`
  // reported 0% of one board's 142 real tickets as unattributable, which reads as "no work
  // happened here" rather than "this reader only knows one prefix".
  const board = { tickets: [{ id: "kit-096", name: "Shared CDK", status: "done" }], epics: [] };
  const index = ticketIndex(board, null);
  const p = transcript([user(0, { text: "picking up kit-096 now" }), turn(1000)]);
  const { turns } = attribute(distill(p), index);
  assert.equal(turns[0].ticketId, "kit-096");
  assert.equal(turns[0].confidence, "medium");
});

test("a branch resolves to the board's own spelling of the id", () => {
  const index = ticketIndex({ tickets: [{ id: "T-029" }, { id: "kit-096" }], epics: [] }, null);
  assert.equal(ticketFromBranch("codex/t-029-docs", index), "T-029", "the board spells it T-029");
  assert.equal(ticketFromBranch("feature/KIT-096-fix", index), "kit-096");
  assert.equal(ticketFromBranch("feature/kit-777-nope", index), null, "a branch cannot invent a ticket");
  assert.equal(ticketFromBranch("main", index), null);
});

test("ticket-shaped noise is matched then refused, so a loose pattern stays safe", () => {
  const index = ticketIndex({ tickets: [{ id: "T-010" }], epics: [] }, null);
  const p = transcript([user(0, { text: "encoding is UTF-8 per ISO-8601, unrelated to PROJ-42" }), turn(1000)]);
  const { turns } = attribute(distill(p), index);
  assert.equal(turns[0].ticketId, null, "only ids the board defines may attribute");
});

// ── Portfolio rollup ──────────────────────────────────────────────────────────────────────

/**
 * A project laid out the way `maestro setup` produces: the kit vendored at <project>/maestro,
 * with the config.json beside the board. Both matter — discovery keys off board/data.json,
 * while the registry's findKitDir() keys off config.json, and a fixture with only one of them
 * passes one path and silently fails the other.
 */
function vendoredProject(root, name, board) {
  const dir = join(root, name);
  const kitDir = join(dir, "maestro");
  const boardDir = join(kitDir, "board");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(kitDir, "config.json"), JSON.stringify({ project: { name } }), "utf8");
  writeFileSync(join(boardDir, "data.json"), JSON.stringify(board), "utf8");
  writeFileSync(join(boardDir, "archive.json"), JSON.stringify({ epics: [], tickets: [] }), "utf8");
  return { dir, kitDir, boardDir };
}

test("discovery does not register <project>/maestro as a project of its own", () => {
  // It holds board/data.json, so it looks exactly like a project — a first pass produced 21
  // separate entries all named "maestro", each sharing its parent's board and roots.
  const root = tmp();
  vendoredProject(root, "alpha", BOARD);
  const found = discoverProjects(root, { depth: 3 });
  assert.deepEqual(found.map((p) => p.name), ["alpha"]);
  assert.ok(found[0].kitDir.endsWith(join("alpha", "maestro")));
});

test("discovery keeps looking inside a project, so a nested board is not missed", () => {
  const root = tmp();
  vendoredProject(root, "outer", BOARD);
  vendoredProject(join(root, "outer"), "inner", BOARD);
  const names = discoverProjects(root, { depth: 4 }).map((p) => p.name).sort();
  assert.deepEqual(names, ["inner", "outer"]);
});

test("a board of nothing but starter samples is flagged, never dropped", () => {
  // "This project exists and no work has been booked to it" is a real answer. Hiding it would
  // repeat the mistake the unattributed panel exists to avoid: silence reading as zero.
  const root = tmp();
  vendoredProject(root, "fresh", { epics: [], tickets: [{ id: "T-1", status: "todo", sample: true }] });
  const [p] = discoverProjects(root, { depth: 3 });
  assert.equal(p.name, "fresh");
  assert.equal(p.template, true);
});

test("a repo nested in another is counted once, on the deeper project only", () => {
  const root = tmp();
  const outer = vendoredProject(root, "outer", { epics: [], tickets: [{ id: "T-010", name: "outer work", status: "done" }] });
  const inner = vendoredProject(join(root, "outer"), "inner", { epics: [], tickets: [{ id: "T-011", name: "inner work", status: "done" }] });

  // One session in each repo, 100 output tokens apiece.
  const projectsDir = tmp();
  const mk = (cwd, id, session) => {
    const d = join(projectsDir, encodeProjectDir(cwd));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${session}.jsonl`), [
      JSON.stringify({ type: "user", timestamp: at(0), cwd, sessionId: session, gitBranch: "main", message: { role: "user", content: `work on ${id}` } }),
      JSON.stringify({ type: "assistant", timestamp: at(1000), cwd, sessionId: session, gitBranch: "main", message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 0, output_tokens: 100 } } }),
    ].join("\n") + "\n", "utf8");
  };
  mk(outer.dir, "T-010", "s-outer");
  mk(inner.dir, "T-011", "s-inner");

  const report = buildPortfolioUsage({
    projects: discoverProjects(root, { depth: 4 }).map((p) => ({ name: p.name, path: p.path, kitDir: p.kitDir })),
    projectsDir, cacheFile: join(tmp(), "cache.json"), useCache: false,
    config: { usage: { scanTranscripts: true } },
  });

  const byName = Object.fromEntries(report.projects.map((p) => [p.name, p]));
  assert.equal(byName.inner.totals.tokens.total, 100, "the nested repo keeps its own tokens");
  assert.equal(byName.outer.totals.tokens.total, 100, "and the parent is not credited with them");
  assert.equal(report.totals.tokens.total, 200, "200, not 300 — the inner repo is counted once");
  assert.deepEqual(report.tickets.map((t) => `${t.project}/${t.id}`).sort(), ["inner/T-011", "outer/T-010"]);
  assert.ok(report.breakdown.project.length === 2, "the portfolio adds a project dimension");
});

test("two projects sharing a name are kept apart, not collapsed onto one", () => {
  // Roots keyed by name silently merge them; every duplicate then inherits the last one's
  // roots, excludes its own work, and reports a confident zero.
  const root = tmp();
  const a = vendoredProject(join(root, "groupA"), "app", { epics: [], tickets: [{ id: "T-010", status: "done" }] });
  const b = vendoredProject(join(root, "groupB"), "app", { epics: [], tickets: [{ id: "T-011", status: "done" }] });
  const projectsDir = tmp();
  for (const [dir, id, session] of [[a.dir, "T-010", "sa"], [b.dir, "T-011", "sb"]]) {
    const d = join(projectsDir, encodeProjectDir(dir));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${session}.jsonl`), [
      JSON.stringify({ type: "user", timestamp: at(0), cwd: dir, sessionId: session, gitBranch: "main", message: { role: "user", content: `do ${id}` } }),
      JSON.stringify({ type: "assistant", timestamp: at(1000), cwd: dir, sessionId: session, gitBranch: "main", message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 0, output_tokens: 50 } } }),
    ].join("\n") + "\n", "utf8");
  }
  const report = buildPortfolioUsage({
    projects: discoverProjects(root, { depth: 4 }).map((p) => ({ name: p.name, path: p.path, kitDir: p.kitDir })),
    projectsDir, cacheFile: join(tmp(), "cache.json"), useCache: false,
    config: { usage: { scanTranscripts: true } },
  });
  assert.equal(report.projects.length, 2);
  for (const p of report.projects) assert.equal(p.totals.tokens.total, 50, `${p.path} must keep its own work`);
  assert.equal(report.totals.tokens.total, 100);
});

test("a project that cannot be read is reported as a failed row, never dropped", () => {
  // A portfolio that silently omits a board reads as "that project did no work".
  const report = buildPortfolioUsage({
    projects: [{ name: "ghost", path: "/nowhere/ghost", kitDir: null }],
    config: null, env: {},
  });
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].ok, false);
  assert.match(report.projects[0].error, /not set up/);
});

// ── End-to-end privacy: what the API and the artifact may contain ─────────────────────────

test("no transcript content survives into the report, the CSV, or the shared snapshot", () => {
  // distill() is unit-tested above, but the claim printed on the page is about everything
  // DOWNSTREAM of it — the /api/usage body, the exports, the HTML someone may share, and the
  // on-disk cache. Each is asserted here against a transcript stuffed with content that must
  // not travel: a credential, prose, a shell command, and a file body from an edit.
  const boardDir = boardFixture();
  const projectsDir = tmp();
  const cacheFile = join(tmp(), "cache.json");
  const sessionDir = join(projectsDir, encodeProjectDir(ROOT));
  mkdirSync(sessionDir, { recursive: true });

  const SECRETS = {
    credential: "sk-ant-NEVER-LEAK-THIS-TOKEN",
    prose: "the acquisition closes on Thursday",
    command: "psql postgres://admin:hunter2@prod.internal/customers",
    fileBody: "export const PRIVATE_SALT = 'zzzz-do-not-ship';",
    toolResult: "row 1: patient Jane Doe, dob 1970-01-01",
  };

  writeFileSync(join(sessionDir, "leaky.jsonl"), [
    JSON.stringify({ type: "user", timestamp: at(0), cwd: ROOT, sessionId: "leaky", gitBranch: "main",
      message: { role: "user", content: `Work T-010. ${SECRETS.credential} — ${SECRETS.prose}` } }),
    JSON.stringify({ type: "assistant", timestamp: at(1000), cwd: ROOT, sessionId: "leaky", gitBranch: "main",
      message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } },
        content: [
          { type: "text", text: SECRETS.prose },
          { type: "tool_use", name: "Bash", input: { command: SECRETS.command } },
          { type: "tool_use", name: "Write", input: { file_path: "/repo/x.ts", content: SECRETS.fileBody } },
        ] } }),
    JSON.stringify({ type: "user", timestamp: at(2000), cwd: ROOT, sessionId: "leaky", gitBranch: "main",
      message: { role: "user", content: [{ type: "tool_result", content: SECRETS.toolResult }] } }),
  ].join("\n") + "\n", "utf8");

  const report = buildUsageReport({
    boardDir, roots: [ROOT], projectsDir, cacheFile,
    config: { usage: { scanTranscripts: true } }, useCache: true,
  });

  // The reading worked — otherwise this test would pass by finding nothing at all.
  const t010 = report.tickets.find((t) => t.id === "T-010");
  assert.ok(t010, "the ticket was attributed, so there was real content to leak");
  assert.equal(t010.metrics.tokens.total, 30);
  assert.equal(t010.metrics.tokens.thinking, 5, "reasoning is captured");

  const surfaces = {
    "the /api/usage body": JSON.stringify(report),
    "the CSV export": usageToCsv(report),
    "the shared HTML snapshot": renderUsageSnapshot(report),
    "the on-disk cache": readFileSync(cacheFile, "utf8"),
  };
  for (const [what, text] of Object.entries(surfaces)) {
    for (const [kind, secret] of Object.entries(SECRETS)) {
      assert.ok(!text.includes(secret), `${what} must not contain the ${kind}`);
    }
    // Not just the exact strings: none of the distinctive words from any of them.
    for (const word of ["hunter2", "acquisition", "PRIVATE_SALT", "Jane", "prod.internal"]) {
      assert.ok(!text.includes(word), `${what} must not contain "${word}"`);
    }
  }
});

test("a temporary registry file drives the rollup, so no permanent one has to exist", () => {
  // Creating a registry changes the scope of mutating commands (`update --all`, `drift`), so
  // that is the owner's call to make explicitly — never a side effect of asking for a report.
  const root = tmp();
  vendoredProject(root, "alpha", BOARD);
  const registryPath = join(tmp(), "maestro-registry.json");
  writeFileSync(registryPath, JSON.stringify({ projects: [{ name: "alpha", path: join(root, "alpha") }] }), "utf8");

  const projects = projectsFromRegistry(registryPath);
  assert.equal(projects.length, 1);
  assert.ok(projects[0].kitDir?.endsWith(join("alpha", "maestro")));

  const report = buildPortfolioUsage({ projects, config: null, env: {} });
  assert.equal(report.kind, "portfolio");
  assert.equal(report.projects[0].name, "alpha");
});

// ── The runtime envelope, against a real one ──────────────────────────────────────────────

test("both usage spellings are read — the envelope's snake_case and modelUsage's camelCase", () => {
  // The fixture reproduces a real envelope's field NAMES with invented values. Reading only
  // snake_case wrote a telemetry record stamped usageSource "provider" with every counter at
  // zero — worse than no record, because it claims the stage was free. Every number below is
  // distinct, so a mismapped field fails loudly rather than coincidentally matching.
  const envelope = JSON.parse(readFileSync(join(FIXTURES, "claude-json-envelope.json"), "utf8"));

  const top = normaliseUsage(envelope.usage);
  assert.equal(top.input, 11);
  assert.equal(top.output, 22);
  assert.equal(top.cacheRead, 3300);
  assert.equal(top.cacheWrite, 440);
  assert.equal(top.thinking, 7, "only the top-level block reports reasoning");

  const perModel = normaliseUsage(Object.values(envelope.modelUsage)[0]);
  assert.equal(perModel.input, 55, "modelUsage spells it inputTokens");
  assert.equal(perModel.output, 66, "...and outputTokens");
  assert.equal(perModel.cacheRead, 7700, "...and cacheReadInputTokens");
  assert.equal(perModel.cacheWrite, 880, "...and cacheCreationInputTokens");
  assert.equal(perModel.thinking, 0, "modelUsage carries no reasoning count at all");
});

test("the fixture carries no captured content — only the shape the parser reads", () => {
  // A fixture is a file that gets committed and read by anyone. This one came from a real run,
  // so it is asserted to be free of everything that run could have carried.
  const raw = readFileSync(join(FIXTURES, "claude-json-envelope.json"), "utf8");
  const j = JSON.parse(raw);
  for (const banned of ["result", "uuid", "total_cost_usd", "permission_denials", "cwd"]) {
    assert.ok(!(banned in j), `the fixture must not carry ${banned}`);
  }
  assert.ok(!("costUSD" in Object.values(j.modelUsage)[0]), "no per-model cost either");
  assert.equal(j.session_id, "00000000-0000-0000-0000-000000000000", "the session id is synthetic");
  assert.ok(!/saeedpourali|\/Users\/|sk-|ghp_|@/.test(raw), "no path, username, handle or credential shape");
});

test("the envelope yields the session id that keeps a measured run from being double-counted", () => {
  const envelope = readFileSync(join(FIXTURES, "claude-json-envelope.json"), "utf8");
  const parsed = parseClaudeEnvelope(envelope);
  assert.equal(parsed.sessionId, "00000000-0000-0000-0000-000000000000");
  assert.ok(parsed.usage && parsed.usage.output === 22);
  assert.ok(parsed.modelUsage && Object.keys(parsed.modelUsage).length === 1);
});

test("a runtime whose envelope shape changed costs the telemetry, never the run", () => {
  for (const junk of ["", "not json", "[]", '{"usage":null}']) {
    const parsed = parseClaudeEnvelope(junk);
    assert.equal(parsed.usage, null);
    assert.equal(parsed.sessionId, null);
  }
});

test("a caller's own --output-format is respected, and usage is then simply not claimed", () => {
  assert.equal(wantsJsonEnvelope([]), true);
  assert.equal(wantsJsonEnvelope(["--permission-mode", "bypassPermissions"]), true);
  assert.equal(wantsJsonEnvelope(["--output-format", "stream-json"]), false);
  assert.equal(wantsJsonEnvelope(["--output-format=text"]), false);
});
