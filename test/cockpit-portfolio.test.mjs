/**
 * Live-server tests for the cockpit's portfolio mode (T-003):
 * - GET /api/portfolio/boards and GET /api/portfolio/today (read-across)
 * - ?project=<name> scoping on the board/spec/docs/reports endpoints, including the write
 *   path: a portfolio PUT lands on the named project's board with that board's validation,
 *   backups, and optimistic concurrency — and never on the default board.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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

let tmp, registryPath, withProc, withoutProc, projA, projC;

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

  projA = join(tmp, "proj-a");
  mkdirSync(join(projA, "board"), { recursive: true });
  writeFileSync(join(projA, "config.json"), "{}");
  writeFileSync(join(projA, "board", "data.json"), JSON.stringify({
    epics: [{ id: "e1", name: "Epic" }],
    tickets: [{ id: "T-1", status: "todo", depends_on: [] }],
  }));
  writeFileSync(join(projA, "board", "archive.json"), JSON.stringify({ epics: [], tickets: [] }));

  const projB = join(tmp, "proj-b"); // registered, never set up
  mkdirSync(projB, { recursive: true });

  // A second set-up project, distinct from the server's own default board, to prove
  // ?project= scoping addresses the named board and only the named board.
  projC = join(tmp, "proj-c");
  mkdirSync(join(projC, "board", "reports"), { recursive: true });
  writeFileSync(join(projC, "config.json"), "{}");
  writeFileSync(join(projC, "board", "data.json"), JSON.stringify({
    epics: [{ id: "e1", name: "C Epic" }],
    tickets: [{ id: "C-1", status: "todo", depends_on: [] }],
  }));
  writeFileSync(join(projC, "board", "archive.json"), JSON.stringify({ epics: [], tickets: [] }));
  writeFileSync(join(projC, "README.md"), "# Proj C guide\n\nHello from C.\n");
  writeFileSync(join(projC, "board", "reports", "weekly.md"), "# Weekly\n\n**bold** report.\n");
  writeFileSync(join(projC, "board", "reports", "audit.html"), "<!doctype html><script>alert(1)</script><p>audit</p>");
  writeFileSync(join(projC, "secret.md"), "# not listed, must not render\n");

  registryPath = join(tmp, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    projects: [
      { name: "proj-a", path: projA },
      { name: "proj-b", path: projB },
      { name: "proj-c", path: projC },
    ],
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

// ── ?project= scoping: reads ───────────────────────────────────────────────────────────

test("GET /api/board?project= reads the named project's board, not the default", { skip: SKIP }, async () => {
  const r = await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.project, "proj-c");
  assert.deepEqual(body.tickets.map((t) => t.id), ["C-1"]);
});

test("an unknown or not-set-up ?project= name 404s; without a registry it 404s as unconfigured", { skip: SKIP }, async () => {
  const r1 = await fetch(`${WITH_ORIGIN}/api/board?project=nope`);
  assert.equal(r1.status, 404);
  assert.match((await r1.json()).error, /No project named "nope"/);

  const r2 = await fetch(`${WITH_ORIGIN}/api/board?project=proj-b`);
  assert.equal(r2.status, 404);
  assert.match((await r2.json()).error, /never set up/);

  const r3 = await fetch(`${WITHOUT_ORIGIN}/api/board?project=proj-c`);
  assert.equal(r3.status, 404);
  assert.match((await r3.json()).error, /not configured/);
});

test("/api/portfolio/boards carries a per-board version usable for optimistic concurrency", { skip: SKIP }, async () => {
  const boards = (await (await fetch(`${WITH_ORIGIN}/api/portfolio/boards`)).json()).boards;
  const c = boards.find((b) => b.name === "proj-c");
  assert.match(c.version, /^sha256:[0-9a-f]+$/, "the shared board-io version token, not a server-local format");
  const single = await (await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`)).json();
  assert.equal(c.version, single.version, "listing and single-board endpoint must agree on the version");
});

// ── ?project= scoping: the write path (T-003's write half) ─────────────────────────────

test("PUT /api/board?project= writes the named board with backup, and never the default", { skip: SKIP }, async () => {
  const before = await (await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`)).json();
  const defaultBefore = readFileSync(join(projA, "board", "data.json"), "utf8");

  const r = await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      epics: before.epics,
      tickets: [...before.tickets, { id: "C-2", status: "todo", depends_on: [] }],
      version: before.version,
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => null)));

  const onDisk = JSON.parse(readFileSync(join(projC, "board", "data.json"), "utf8"));
  assert.deepEqual(onDisk.tickets.map((t) => t.id), ["C-1", "C-2"], "the write must land on proj-c's board");
  assert.equal(readFileSync(join(projA, "board", "data.json"), "utf8"), defaultBefore,
    "the default board must be untouched by a portfolio write");
  const backups = readdirSync(join(projC, "board", ".backups")).filter((f) => f.endsWith(".json"));
  assert.ok(backups.length >= 1, "the backup must land in proj-c's board/.backups");
});

test("a stale portfolio PUT 409s with the named board's current state", { skip: SKIP }, async () => {
  const current = await (await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`)).json();
  const r = await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epics: current.epics, tickets: current.tickets, version: "stale-0" }),
  });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.current.project, "proj-c");
  assert.equal(body.current.version, current.version);
});

test("an invalid portfolio PUT 400s and leaves the named board unchanged", { skip: SKIP }, async () => {
  const current = await (await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`)).json();
  const onDiskBefore = readFileSync(join(projC, "board", "data.json"), "utf8");
  const r = await fetch(`${WITH_ORIGIN}/api/board?project=proj-c`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      epics: current.epics,
      tickets: [{ id: "C-1", status: "todo", depends_on: ["missing-ticket"] }],
      version: current.version,
    }),
  });
  assert.equal(r.status, 400);
  assert.equal(readFileSync(join(projC, "board", "data.json"), "utf8"), onDiskBefore);
});

test("PUT /api/spec/:id?project= writes the named project's specs dir", { skip: SKIP }, async () => {
  const r = await fetch(`${WITH_ORIGIN}/api/spec/C-1?project=proj-c`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "# C-1 spec" }),
  });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(projC, "board", "specs", "C-1.md"), "utf8"), "# C-1 spec");
  assert.ok(!existsSync(join(projA, "board", "specs", "C-1.md")), "must not write the default project's specs");

  const back = await (await fetch(`${WITH_ORIGIN}/api/spec/C-1?project=proj-c`)).json();
  assert.equal(back.content, "# C-1 spec");
});

// ── ?project= scoping: docs (§4) and reports (§5) ─────────────────────────────────────

test("docs are per-scope: proj-c lists and renders its own README, and only listed files", { skip: SKIP }, async () => {
  const sections = (await (await fetch(`${WITH_ORIGIN}/api/docs?project=proj-c`)).json()).sections;
  const paths = sections.flatMap((s) => s.files.map((f) => f.path));
  assert.ok(paths.includes("README.md"), `proj-c's README must be listed, got: ${paths}`);

  const rendered = await (await fetch(`${WITH_ORIGIN}/api/docs/render?path=README.md&project=proj-c`)).json();
  assert.match(rendered.html, /Hello from C/);

  // Unlisted file in the same root: refused. Path traversal: refused.
  const r1 = await fetch(`${WITH_ORIGIN}/api/docs/render?path=secret.md&project=proj-c`);
  assert.equal(r1.status, 404);
  const r2 = await fetch(`${WITH_ORIGIN}/api/docs/render?path=${encodeURIComponent("../proj-a/config.json")}&project=proj-c`);
  assert.equal(r2.status, 404);
});

test("reports (§5): listed per scope, md renders neutered, html served under a sandbox CSP", { skip: SKIP }, async () => {
  const reports = (await (await fetch(`${WITH_ORIGIN}/api/reports?project=proj-c`)).json()).reports;
  assert.deepEqual(reports.map((r) => r.name).sort(), ["audit.html", "weekly.md"]);

  const md = await (await fetch(`${WITH_ORIGIN}/api/reports/render?name=weekly.md&project=proj-c`)).json();
  assert.match(md.html, /<strong>bold<\/strong>/);

  const html = await fetch(`${WITH_ORIGIN}/api/reports/render?name=audit.html&project=proj-c`);
  assert.equal(html.status, 200);
  const csp = html.headers.get("content-security-policy");
  assert.ok(csp && /sandbox/.test(csp) && /default-src 'none'/.test(csp),
    `generated HTML must be sandboxed, got CSP: ${csp}`);

  // Traversal-shaped names never reach the filesystem; the default scope has no reports dir.
  const r1 = await fetch(`${WITH_ORIGIN}/api/reports/render?name=${encodeURIComponent("../data.json")}&project=proj-c`);
  assert.equal(r1.status, 400);
  const empty = (await (await fetch(`${WITH_ORIGIN}/api/reports`)).json()).reports;
  assert.deepEqual(empty, [], "a board with no reports/ dir lists cleanly as empty");
});
