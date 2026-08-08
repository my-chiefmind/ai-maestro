/**
 * Tests for the board validator's agent-roster resolution.
 *
 * WHY THESE EXIST: the validator answers "may this ticket's agent_plan
 * reference this agent?", and it used to answer it from the KIT's `agents/`
 * directory — "what agents does the kit ship?" — which is a different question
 * from "what agents does this project run?". `config.json` already records the
 * latter as `roster`, and the cockpit already reads it
 * (cockpit/server/index.mjs). So the CLI and the UI could disagree about
 * whether the same board was valid, in both directions:
 *
 *   - a plan routed to an agent the project DROPPED passed validation, then
 *     had nowhere to run;
 *   - a project whose roster the kit doesn't ship failed on a good board.
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

const FULL_ROSTER = [
  "orchestrator",
  "principal-engineer",
  "backend-developer",
  "frontend-developer",
  "devops",
  "technical-writer",
  "qa",
  "principal-delivery",
];

/** A project dir laid out the way `maestro setup` leaves one: config.json
 *  beside a board/ directory. */
function project({ roster, plan }) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-test-"));
  mkdirSync(join(dir, "board"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ project: "t", roster, skills: [], model: {} }, null, 2),
  );
  writeFileSync(
    join(dir, "board", "data.json"),
    JSON.stringify(
      {
        epics: [{ id: "E-1", name: "Epic" }],
        tickets: [
          {
            id: "T-1",
            epicId: "E-1",
            name: "ticket",
            desc: "d",
            area: "general",
            status: "todo",
            priority: "P2",
            depends_on: [],
            agent_plan: plan,
            model: "sonnet",
          },
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

/** Returns { ok, out }. The validator exits non-zero on an invalid board, so a
 *  throw IS the failure signal — capture it rather than letting it escape. */
function validate(dir, extraArgs = []) {
  const args = [VALIDATOR, join(dir, "board", "data.json"), ...extraArgs];
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { encoding: "utf8" }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("a plan routed to an agent the project dropped is rejected", () => {
  const dir = project({
    roster: FULL_ROSTER.filter((r) => r !== "devops"),
    plan: ["devops", "qa", "pd", "merge"],
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "board with an off-roster agent must be invalid");
    assert.match(out, /unknown agent "devops"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The starter ships a `docs` area and a model floor for it, so a docs ticket is something
// users will file on day one. Until technical-writer existed there was no agent behind that
// code and every such ticket failed validation — the example board never exercised the area,
// so nothing caught it.
test("the docs area has an agent behind it", () => {
  const dir = project({ roster: FULL_ROSTER, plan: ["docs", "qa", "merge"] });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `a docs ticket must be runnable, got:\n${out}`);
    assert.match(out, /Board valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same plan passes once that agent is back on the roster", () => {
  const dir = project({ roster: FULL_ROSTER, plan: ["devops", "qa", "pd", "merge"] });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `expected a valid board, got:\n${out}`);
    assert.match(out, /Board valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent the KIT ships but the project did not adopt is still rejected", () => {
  // The regression this guards: reading the kit's agents/ directory accepts
  // this, because the kit DOES ship a frontend-developer — but this project
  // never put it on its roster. Note the code is `frontend`, not `fe`: the
  // alias map in board-core.mjs is frontend-developer -> frontend. Using a
  // code the kit cannot produce either way would make this test vacuous
  // (it would fail for both the old and the new resolver).
  const dir = project({
    roster: ["orchestrator", "principal-engineer", "qa", "principal-delivery"],
    plan: ["frontend", "qa", "pd", "merge"],
  });
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, false, "an un-adopted kit agent must not validate");
    assert.match(out, /unknown agent "frontend"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--agents overrides the roster, for boards that live elsewhere", () => {
  const dir = project({
    roster: FULL_ROSTER.filter((r) => r !== "devops"),
    plan: ["devops", "qa", "pd", "merge"],
  });
  const agents = mkdtempSync(join(tmpdir(), "maestro-agents-"));
  for (const name of ["devops", "qa", "principal-delivery", "orchestrator"]) {
    writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\n---\n`);
  }
  try {
    const { ok, out } = validate(dir, ["--agents", agents]);
    assert.equal(ok, true, `explicit --agents must win, got:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test("a board with no config beside it falls back to the kit's agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-noconfig-"));
  mkdirSync(join(dir, "board"), { recursive: true });
  writeFileSync(
    join(dir, "board", "data.json"),
    JSON.stringify(
      {
        epics: [{ id: "E-1", name: "Epic" }],
        tickets: [
          {
            id: "T-1",
            epicId: "E-1",
            name: "t",
            desc: "d",
            area: "general",
            status: "todo",
            priority: "P2",
            depends_on: [],
            agent_plan: ["devops", "qa", "pd", "merge"],
            model: "sonnet",
          },
        ],
      },
      null,
      2,
    ),
  );
  try {
    const { ok, out } = validate(dir);
    assert.equal(ok, true, `fallback path must still validate, got:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
