/**
 * Live-server tests for the cockpit's portfolio mode endpoints (T-003):
 * GET /api/portfolio/boards and GET /api/portfolio/today.
 *
 * Two servers: one started with --registry (portfolio mode on) and one started plainly
 * (default single-board mode), to pin AC2 — single-board mode is unchanged, and portfolio
 * mode is 404 rather than silently empty, when no registry was configured.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(KIT, "cockpit", "server", "index.mjs");

const SKIP = existsSync(join(KIT, "cockpit", "node_modules"))
  ? false
  : "cockpit deps not installed — run `npm run cockpit:install` to exercise these";
if (SKIP) console.error(`\n⚠ cockpit-portfolio tests SKIPPED: ${SKIP}\n`);

const WITH_PORT = 4705;
const WITHOUT_PORT = 4706;
const WITH_ORIGIN = `http://127.0.0.1:${WITH_PORT}`;
const WITHOUT_ORIGIN = `http://127.0.0.1:${WITHOUT_PORT}`;

let tmp, registryPath, withProc, withoutProc;

function startServer(port, extraArgs) {
  return spawn(process.execPath, [SERVER, ...extraArgs], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
}

async function waitUntilUp(origin) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${origin}/api/board/version`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`cockpit server at ${origin} did not start`);
}

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), "cockpit-portfolio-"));

  const projA = join(tmp, "proj-a");
  mkdirSync(join(projA, "board"), { recursive: true });
  writeFileSync(join(projA, "config.json"), "{}");
  writeFileSync(join(projA, "board", "data.json"), JSON.stringify({
    epics: [{ id: "e1", name: "Epic" }],
    tickets: [{ id: "T-1", status: "todo", depends_on: [] }],
  }));
  writeFileSync(join(projA, "board", "archive.json"), JSON.stringify({ epics: [], tickets: [] }));

  const projB = join(tmp, "proj-b"); // registered, never set up
  mkdirSync(projB, { recursive: true });

  registryPath = join(tmp, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    projects: [{ name: "proj-a", path: projA }, { name: "proj-b", path: projB }],
  }));

  withProc = startServer(WITH_PORT, ["--board", join(projA, "board"), "--registry", registryPath]);
  withoutProc = startServer(WITHOUT_PORT, ["--board", join(projA, "board")]);
  await Promise.all([waitUntilUp(WITH_ORIGIN), waitUntilUp(WITHOUT_ORIGIN)]);
});

after(() => {
  if (SKIP) return;
  withProc?.kill();
  withoutProc?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test("with --registry: /api/portfolio/boards reads every project in place", { skip: SKIP }, async () => {
  const r = await fetch(`${WITH_ORIGIN}/api/portfolio/boards`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.registry, registryPath);
  const a = body.boards.find((b) => b.name === "proj-a");
  const b = body.boards.find((b) => b.name === "proj-b");
  assert.equal(a.setUp, true);
  assert.equal(a.tickets.length, 1);
  assert.equal(b.setUp, false, "a registered-but-never-set-up project must not crash the read");
});

test("with --registry: /api/portfolio/today reports ready tickets per board", { skip: SKIP }, async () => {
  const r = await fetch(`${WITH_ORIGIN}/api/portfolio/today`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.week, /^\d{4}-W\d{2}$/);
  const a = body.projects.find((p) => p.name === "proj-a");
  assert.deepEqual(a.ready.map((t) => t.id), ["T-1"]);
});

test("without --registry: portfolio endpoints 404 with a clear reason, not an empty list", { skip: SKIP }, async () => {
  const r1 = await fetch(`${WITHOUT_ORIGIN}/api/portfolio/boards`);
  assert.equal(r1.status, 404);
  assert.match((await r1.json()).error, /not configured/);

  const r2 = await fetch(`${WITHOUT_ORIGIN}/api/portfolio/today`);
  assert.equal(r2.status, 404);
});

test("without --registry: single-board mode is completely unaffected (AC2)", { skip: SKIP }, async () => {
  const r = await fetch(`${WITHOUT_ORIGIN}/api/board`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tickets.length, 1);
});
