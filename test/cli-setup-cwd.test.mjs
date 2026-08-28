/**
 * Tests for the setup cwd guard (kit-075 §2d).
 *
 * WHY THIS EXISTS: the non-packaged ("clone ai-maestro into your repo as maestro/, run
 * maestro/bin/cli.mjs setup") flow resolves the project root as dirname(KIT_ROOT) — the
 * physical location of the cli.mjs file — with no relationship to process.cwd(). Running it
 * from an unrelated directory used to silently scaffold context.md/board/.claude into whatever
 * that happened to be, with a cheerful "✅ ready" for a project nobody asked for. This was
 * reproduced live against this repo's own parent directory while working T-004 and fully
 * cleaned up by hand — these tests pin the fix so it can't happen again.
 *
 * A real KIT_ROOT clone is simulated with a copy under a fresh temp dir (never this repo
 * itself), so a failing test can't scaffold into anything that matters.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

function cloneKit(tmp) {
  const kitClone = join(tmp, "project", "maestro");
  // Mirror what `git clone` actually produces. This repo's own board data — data.json,
  // archive.json, plan.json, plan.md, specs/, reports/ — is gitignored (see .gitignore), so a
  // real clone never carries it. Copying it from the working tree made the fixture unlike any
  // real checkout AND handed setup a live board to seed over, which is the destructive act
  // itself: the tests passed only because it was a throwaway copy being destroyed.
  const LOCAL_ONLY = ["data.json", "archive.json", "plan.json", "plan.md", "parked.json", "specs", "reports"];
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src))
    && !(basename(dirname(src)) === "board" && LOCAL_ONLY.includes(basename(src)));
  for (const entry of CLONE_ENTRIES) {
    cpSync(join(KIT, entry), join(kitClone, entry), { recursive: true, filter });
  }
  return kitClone;
}

const cli = (kitClone, args, cwd) =>
  execFileSync(process.execPath, [join(kitClone, "bin", "cli.mjs"), ...args], {
    cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
  });

test("refuses setup from a cwd unrelated to the kit clone, scaffolding nothing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "maestro-cwd-guard-"));
  try {
    const kitClone = cloneKit(tmp);
    const elsewhere = join(tmp, "somewhere-else");
    mkdirSync(elsewhere, { recursive: true });

    assert.throws(
      () => cli(kitClone, ["setup", "--yes", "--no-board"], elsewhere),
      /Refusing to guess which project this is for/,
    );
    // Nothing scaffolded into elsewhere/, and nothing into the clone's own parent either —
    // the exact incident this guards against.
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.ok(!existsSync(join(tmp, "project", "config.json")), "must not have set up the clone's parent either");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("still works from inside the maestro/ clone itself", () => {
  const tmp = mkdtempSync(join(tmpdir(), "maestro-cwd-guard-"));
  try {
    const kitClone = cloneKit(tmp);
    cli(kitClone, ["setup", "--yes", "--no-board"], kitClone);
    assert.ok(existsSync(join(kitClone, "config.json")));
    assert.ok(existsSync(join(join(tmp, "project"), "CLAUDE.md")), "renders up to the project root, dirname(kit)");
    assert.ok(existsSync(join(join(tmp, "project"), "AGENTS.md")), "renders Codex guidance to the project root");
    assert.ok(existsSync(join(join(tmp, "project"), ".agents", "skills", "orchestrator", "SKILL.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("still works from the project root above the clone", () => {
  const tmp = mkdtempSync(join(tmpdir(), "maestro-cwd-guard-"));
  try {
    const kitClone = cloneKit(tmp);
    const projectRoot = dirname(kitClone);
    cli(kitClone, ["setup", "--yes", "--no-board"], projectRoot);
    assert.ok(existsSync(join(kitClone, "config.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
