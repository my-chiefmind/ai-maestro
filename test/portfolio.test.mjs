/**
 * Unit tests for cockpit/server/portfolio.mjs — the registry-driven multi-board read-across
 * behind the cockpit's portfolio mode (T-003). Pure functions over a temp fixture tree; no
 * server needed for these (see test/cockpit-portfolio.test.mjs for the live endpoint tests).
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPortfolio, readPortfolioBoards, survey, isoWeek } from "../cockpit/server/portfolio.mjs";

function setUpProject(root, name, board) {
  const dir = join(root, name);
  mkdirSync(join(dir, "board"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
  writeFileSync(join(dir, "board", "data.json"), JSON.stringify(board.data ?? { epics: [], tickets: [] }));
  writeFileSync(join(dir, "board", "archive.json"), JSON.stringify(board.archive ?? { epics: [], tickets: [] }));
  return dir;
}

test("loadPortfolio returns null when no registry file exists — the single-board default", () => {
  assert.equal(loadPortfolio("/does/not/exist/registry.json"), null);
});

test("loadPortfolio resolves each entry's kit dir, null for a project that isn't set up", () => {
  const tmp = mkdtempSync(join(tmpdir(), "portfolio-"));
  try {
    const setUpDir = setUpProject(tmp, "set-up", {});
    const notSetUpDir = join(tmp, "not-set-up");
    mkdirSync(notSetUpDir, { recursive: true });

    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      projects: [{ name: "a", path: setUpDir }, { name: "b", path: notSetUpDir }],
    }));

    const portfolio = loadPortfolio(registryPath);
    assert.equal(portfolio.length, 2);
    assert.equal(portfolio[0].kitDir, setUpDir);
    assert.equal(portfolio[1].kitDir, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a malformed registry throws rather than reading as an empty portfolio", () => {
  const tmp = mkdtempSync(join(tmpdir(), "portfolio-"));
  try {
    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, "{ not json");
    assert.throws(() => loadPortfolio(registryPath), (e) => e.code === "EBADJSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readPortfolioBoards reads each project's board in place, flagging one that isn't set up", () => {
  const tmp = mkdtempSync(join(tmpdir(), "portfolio-"));
  try {
    const dirA = setUpProject(tmp, "a", {
      data: { epics: [{ id: "e1", name: "Epic" }], tickets: [{ id: "T-1", status: "todo" }] },
    });
    mkdirSync(join(tmp, "b"), { recursive: true });

    const boards = readPortfolioBoards([
      { name: "project-a", path: dirA, kitDir: dirA },
      { name: "project-b", path: join(tmp, "b"), kitDir: null },
    ]);
    assert.equal(boards[0].setUp, true);
    assert.equal(boards[0].tickets.length, 1);
    assert.equal(boards[0].boardDir, join(dirA, "board"));
    assert.equal(boards[1].setUp, false);
    assert.equal(boards[1].name, "project-b");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("survey reports ready tickets per board, matching eligibleTickets' rule", () => {
  const tmp = mkdtempSync(join(tmpdir(), "portfolio-"));
  try {
    const dirA = setUpProject(tmp, "a", {
      data: {
        epics: [],
        tickets: [
          { id: "T-1", status: "todo", depends_on: [] }, // ready
          { id: "T-2", status: "todo", depends_on: ["T-1"] }, // blocked — T-1 not done
          { id: "T-3", status: "done", depends_on: [] },
        ],
      },
    });
    const dirB = setUpProject(tmp, "b", {
      data: { epics: [], tickets: [{ id: "T-9", status: "backlog", depends_on: [] }] },
    });

    const result = survey(
      [{ name: "a", path: dirA, kitDir: dirA }, { name: "b", path: dirB, kitDir: dirB }],
      new Date(Date.UTC(2026, 0, 15)),
    );
    assert.match(result.week, /^2026-W\d{2}$/);
    const a = result.projects.find((p) => p.name === "a");
    assert.equal(a.total, 3);
    assert.deepEqual(a.ready.map((t) => t.id), ["T-1"]);
    assert.equal(a.byStatus.done, 1);

    const b = result.projects.find((p) => p.name === "b");
    assert.equal(b.ready.length, 0, "backlog ticket is not ready");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("survey handles a project that was never set up without crashing the rest", () => {
  const result = survey([{ name: "ghost", path: "/nowhere", kitDir: null }]);
  assert.equal(result.projects[0].setUp, false);
  assert.deepEqual(result.projects[0].ready, []);
});

test("isoWeek is stable and deterministic for a known date", () => {
  assert.equal(isoWeek(new Date(Date.UTC(2026, 0, 1))), isoWeek(new Date(Date.UTC(2026, 0, 1))));
  assert.equal(isoWeek(new Date(Date.UTC(2026, 5, 15))), "2026-W25");
});
