/**
 * `maestro setup` must never seed a starter board over work that is already there (2026-08-28).
 *
 * THE INCIDENT. Setup decides "is this a first-time run?" from `config.json`, then acts on
 * `board/`. Those are two different files, and on a kit checkout that has a real board and no
 * root `config.json` they disagree. `setup` therefore read as fresh and replaced `data.json`,
 * `archive.json`, `plan.json` and `plan.md` with the starter sample — silently, with no prompt,
 * and with no backup. `archive.json` had no backup path at all, so the only record of completed
 * work was gone. That is the same class of failure as archived T-001 ("maestro update destroys
 * user content in board/"), reached through a different door.
 *
 * These tests are written against the reproduction, not the fix: the first one FAILS against
 * the code as it was, because it asserts the board survives.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(KIT, "bin", "cli.mjs");

/**
 * A throwaway copy of the kit with its own board — the shape that made the incident possible:
 * a kit checkout carrying real board content and NO root config.json.
 */
function kitWithBoard({ data, archive, plan } = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-guard-"));
  const kit = join(root, "kit");
  mkdirSync(join(kit, "board"), { recursive: true });
  // Only what setup reads: the starter it seeds from, and the CLI's own resolution.
  cpSync(join(KIT, "starters"), join(kit, "starters"), { recursive: true });
  cpSync(join(KIT, "bin"), join(kit, "bin"), { recursive: true });
  cpSync(join(KIT, "scripts"), join(kit, "scripts"), { recursive: true });
  cpSync(join(KIT, "render"), join(kit, "render"), { recursive: true });
  cpSync(join(KIT, "agents"), join(kit, "agents"), { recursive: true });
  cpSync(join(KIT, "skills"), join(kit, "skills"), { recursive: true });
  cpSync(join(KIT, "package.json"), join(kit, "package.json"));
  if (data) writeFileSync(join(kit, "board", "data.json"), JSON.stringify(data, null, 2) + "\n");
  if (archive) writeFileSync(join(kit, "board", "archive.json"), JSON.stringify(archive, null, 2) + "\n");
  if (plan) writeFileSync(join(kit, "board", "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return { root, kit };
}

const REAL_TICKET = { id: "T-042", name: "Real work", status: "todo", depends_on: [], area: "backend" };
const run = (kit) => execFileP(process.execPath, [join(kit, "bin", "cli.mjs"), "setup", "--yes"], { cwd: kit }).catch((e) => e);

test("setup refuses to seed over a live board, and writes nothing", async () => {
  const { root, kit } = kitWithBoard({
    data: { epics: [{ id: "e1", name: "Kit integrity" }], tickets: [REAL_TICKET] },
    archive: { epics: [], tickets: [{ id: "T-001", name: "Landed", status: "done", evidence: "shipped" }] },
  });
  try {
    const before = readFileSync(join(kit, "board", "data.json"), "utf8");
    const beforeArchive = readFileSync(join(kit, "board", "archive.json"), "utf8");

    const e = await run(kit);
    assert.equal(e.code, 2, "a refusal, not a silent success");
    assert.match(`${e.stderr}`, /Refusing to seed a starter board over work that is already here/);
    // The message must name what it protected — a refusal the user cannot act on is a wall.
    assert.match(`${e.stderr}`, /T-042/);
    assert.match(`${e.stderr}`, /archive\.json — 1 completed ticket\(s\): T-001/);

    assert.equal(readFileSync(join(kit, "board", "data.json"), "utf8"), before, "data.json byte-identical");
    assert.equal(readFileSync(join(kit, "board", "archive.json"), "utf8"), beforeArchive, "archive.json byte-identical");
    // It must refuse BEFORE scaffolding anything: a guard that fires after writing config.json
    // has still changed the user's repo.
    assert.equal(existsSync(join(kit, "config.json")), false, "no config.json was written");
    assert.equal(existsSync(join(kit, "context.md")), false, "no context.md was written");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an archive alone is enough to refuse — it is the irreplaceable file", async () => {
  // data.json can be rebuilt from a plan and a memory. Nothing regenerates the record of what
  // was already finished.
  const { root, kit } = kitWithBoard({
    data: { epics: [], tickets: [] },
    archive: { epics: [], tickets: [{ id: "T-007", name: "Landed long ago", status: "done" }] },
  });
  try {
    const e = await run(kit);
    assert.equal(e.code, 2);
    assert.match(`${e.stderr}`, /archive\.json — 1 completed ticket\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a plan with real content is enough to refuse", async () => {
  const { root, kit } = kitWithBoard({
    data: { epics: [], tickets: [] },
    archive: { epics: [], tickets: [] },
    plan: { planVersion: 1, sections: { goal: { text: "Ship the thing.", metrics: [] }, scope: { in: [], out: [] }, functional: [{ id: "FR-1", text: "a requirement" }] } },
  });
  try {
    const e = await run(kit);
    assert.equal(e.code, 2);
    assert.match(`${e.stderr}`, /plan\.json — a project plan with 1 item\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an empty board, or one holding only starter samples, still seeds normally", async () => {
  // The guard must not break the flow it protects. A sample-flagged board is exactly what a
  // starter wrote, so replacing it destroys nothing.
  const { root, kit } = kitWithBoard({
    data: { epics: [{ id: "e1", name: "Sample epic", sample: true }], tickets: [{ id: "T-001", name: "Sample", status: "backlog", sample: true }] },
    archive: { epics: [], tickets: [] },
  });
  try {
    const r = await run(kit);
    assert.equal(r.code ?? 0, 0, `setup should succeed on a sample board: ${r.stderr ?? ""}`);
    assert.ok(existsSync(join(kit, "config.json")), "a normal first-time setup still completes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("any board file that is replaced is copied into board/.backups first", async () => {
  // Belt and braces behind the refusal: if the emptiness test ever grows a hole, the data is
  // still recoverable. archive.json had no backup path at all before this.
  const { root, kit } = kitWithBoard({
    data: { epics: [], tickets: [] },
    archive: { epics: [], tickets: [] },
  });
  try {
    const r = await run(kit);
    assert.equal(r.code ?? 0, 0, `${r.stderr ?? ""}`);
    const backups = existsSync(join(kit, "board", ".backups")) ? readdirSync(join(kit, "board", ".backups")) : [];
    assert.ok(backups.some((f) => f.startsWith("data.")), `expected a data.json backup, got: ${backups.join(", ") || "(none)"}`);
    assert.ok(backups.some((f) => f.startsWith("archive.")), `expected an archive.json backup, got: ${backups.join(", ") || "(none)"}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
