/**
 * Tests for the board validator's archive awareness and terminal-state rules.
 *
 * WHY THESE EXIST: landed tickets move from data.json to archive.json by design,
 * so dependencies legitimately point into the archive — and the runtime treats an
 * ABSENT dependency as satisfied, meaning a typo'd dep id silently UNBLOCKS a
 * ticket instead of holding it. The validator therefore resolves deps against
 * both files and hard-errors on ids found in neither. The archive also carries
 * three archive-only terminal states (archived / duplicate / wont-do) for
 * tickets that left the board without being completed; a live ticket carrying
 * one is an error, because folding a declined or duplicate ticket into `done`
 * records work as finished that never was.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = join(KIT, "scripts", "validate-board.mjs");

const ROSTER = [
  "orchestrator",
  "principal-engineer",
  "backend-developer",
  "qa",
  "principal-delivery",
];

/** A ticket with sane defaults, so tests only spell out what they're about. */
function ticket(overrides) {
  return {
    id: "T-1",
    epicId: "E-1",
    name: "ticket",
    desc: "d",
    area: "general",
    status: "todo",
    priority: "P2",
    depends_on: [],
    agent_plan: ["backend", "qa", "merge"],
    model: "sonnet",
    ...overrides,
  };
}

/** A project dir the way `maestro setup` leaves one, plus an optional archive.json. */
function project({ tickets, archive }) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-archive-test-"));
  mkdirSync(join(dir, "board"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ project: "t", roster: ROSTER, skills: [], model: {} }, null, 2),
  );
  writeFileSync(
    join(dir, "board", "data.json"),
    JSON.stringify({ epics: [{ id: "E-1", name: "Epic" }], tickets }, null, 2),
  );
  if (archive) {
    writeFileSync(join(dir, "board", "archive.json"), JSON.stringify(archive, null, 2));
  }
  return dir;
}

/** Returns { ok, out }. The validator exits non-zero on an invalid board, so a
 *  throw IS the failure signal — capture it rather than letting it escape. */
function validate(dir) {
  const args = [VALIDATOR, join(dir, "board", "data.json")];
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { encoding: "utf8" }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("a dependency that resolved into the archive passes", () => {
  const dir = project({
    tickets: [ticket({ id: "T-2", depends_on: ["T-1"] })],
    archive: {
      epics: [],
      tickets: [ticket({ id: "T-1", status: "done" })],
    },
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `a dep on an archived ticket must be valid, got:\n${out}`);
    assert.match(out, /Board valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dependency id found in neither data.json nor archive.json is a hard error", () => {
  // The runtime treats an absent dep as satisfied — so without this error a typo
  // silently unblocks the ticket. This must block, not warn.
  const dir = project({
    tickets: [ticket({ id: "T-2", depends_on: ["T-999"] })],
    archive: { epics: [], tickets: [ticket({ id: "T-1", status: "done" })] },
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "an unresolvable dep must make the board invalid");
    assert.match(out, /T-2: depends_on "T-999" which does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an archive-only status on a live ticket is an error", () => {
  const dir = project({ tickets: [ticket({ id: "T-1", status: "wont-do" })] });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "a live wont-do ticket must be invalid");
    assert.match(out, /T-1: status "wont-do" is archive-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same archive-only statuses pass inside archive.json", () => {
  const dir = project({
    tickets: [ticket({ id: "T-4" })],
    archive: {
      epics: [],
      tickets: [
        ticket({ id: "T-1", status: "archived" }),
        ticket({ id: "T-2", status: "duplicate" }),
        ticket({ id: "T-3", status: "wont-do" }),
      ],
    },
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `archive-only statuses must be legal in the archive, got:\n${out}`);
    assert.match(out, /Board valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket id present in both data.json and archive.json is an error", () => {
  const dir = project({
    tickets: [ticket({ id: "T-1" })],
    archive: { epics: [], tickets: [ticket({ id: "T-1", status: "done" })] },
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "a live/archive id collision must be invalid");
    assert.match(out, /T-1: also present in archive\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a duplicated id inside archive.json is an error", () => {
  const dir = project({
    tickets: [ticket({ id: "T-2" })],
    archive: {
      epics: [],
      tickets: [ticket({ id: "T-1", status: "done" }), ticket({ id: "T-1", status: "done" })],
    },
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "a duplicate id inside the archive must be invalid");
    assert.match(out, /archive: duplicate ticket id "T-1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown failureKind warns but does not block", () => {
  const dir = project({
    tickets: [ticket({ id: "T-1", status: "blocked", failureKind: "merge-exploded" })],
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `an unknown failureKind must stay a warning, got:\n${out}`);
    assert.match(out, /T-1: unknown failureKind "merge-exploded"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a known failureKind is accepted silently", () => {
  const dir = project({
    tickets: [ticket({ id: "T-1", status: "blocked", failureKind: "merge-conflict" })],
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `a known failureKind must be clean, got:\n${out}`);
    assert.doesNotMatch(out, /failureKind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a human-gated ticket sitting in todo warns", () => {
  // The gate makes it ineligible, so `todo` looks runnable but never runs.
  const dir = project({
    tickets: [ticket({ id: "T-1", human_gate: "owner sign-off" })],
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `a gated todo ticket is a warning, not an error, got:\n${out}`);
    assert.match(out, /T-1: human-gated ticket is "todo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
