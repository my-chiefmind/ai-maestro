/**
 * Regression tests for T-011: a project's OWN agents and skills must survive `maestro update`,
 * and config.roster / config.skills must actually filter what renders.
 *
 * WHY THIS EXISTS: under `setup` the kit is vendored INTO the project, so the project dir and
 * the kit dir are the same directory. Two defects fell out of that conflation, both verified
 * against 0.1.22 before this was written:
 *
 *   1. `update` removed and re-copied every VENDORED folder wholesale — including agents/ and
 *      skills/ — so an agent a project had added was deleted, silently, on every update. The
 *      docs pointed people at exactly that folder. Only board/ had ever been protected (T-001).
 *   2. render/sync.mjs read <project>/agents as a "project overlay". In the vendored layout
 *      that IS the kit's agents/, so every kit agent was re-added after the roster filter had
 *      already excluded it — config.roster and config.skills did nothing at all.
 *
 * The fix moves a project's own files to <project>/custom/, which is not a VENDORED entry, and
 * ignores the legacy in-kit paths when project and kit are the same directory. `update` also
 * migrates anything it finds in the old location rather than deleting it, since every existing
 * 0.1.22 install has its customisations there.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, pkgDir, projDir, kitDir;
const cli = (args, opts = {}) =>
  execFileSync(process.execPath, [join(pkgDir, "bin", "cli.mjs"), ...args], {
    cwd: projDir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...opts,
  });
const sync = () =>
  execFileSync(process.execPath, [join(kitDir, "render", "sync.mjs"), "--project", kitDir], {
    cwd: projDir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

const AGENT = (name) => `---\nname: ${name}\ndescription: a project-owned agent\n---\n\n# ${name}\n`;
const SKILL = (name) => `---\nname: ${name}\ndescription: a project-owned skill\n---\n\n# ${name}\n`;

const writeAgent = (dir, name) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), AGENT(name));
};
const writeSkill = (dir, name) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), SKILL(name));
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-overlay-"));
  pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  kitDir = join(projDir, "maestro");
  cli(["setup", "--yes", "--no-board"]);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("a project's own agent and skill in custom/ survive update and still render", () => {
  writeAgent(join(kitDir, "custom", "agents"), "house-style");
  writeSkill(join(kitDir, "custom", "skills"), "house-checks");
  sync();
  assert.ok(existsSync(join(projDir, ".claude", "agents", "house-style.md")), "custom agent should render");
  assert.ok(existsSync(join(projDir, ".claude", "skills", "house-checks", "SKILL.md")), "custom skill should render");

  cli(["update", "--kit", "maestro", "--force"]);

  // The bug this pins: before the fix, both of these were gone after update.
  assert.ok(existsSync(join(kitDir, "custom", "agents", "house-style.md")), "custom agent source must survive update");
  assert.ok(existsSync(join(kitDir, "custom", "skills", "house-checks", "SKILL.md")), "custom skill source must survive update");
  assert.ok(existsSync(join(projDir, ".claude", "agents", "house-style.md")), "custom agent must still render after update");
  assert.ok(existsSync(join(projDir, ".claude", "skills", "house-checks", "SKILL.md")), "custom skill must still render after update");
});

test("update migrates a pre-custom/ agent out of the kit folder instead of deleting it", () => {
  // Exactly what an install predating custom/ looks like: the project's own agent sitting in
  // the kit's own agents/ folder, because that is where the docs used to say to put it.
  writeAgent(join(kitDir, "agents"), "legacy-owned");
  const out = cli(["update", "--kit", "maestro", "--force"]);

  assert.ok(existsSync(join(kitDir, "custom", "agents", "legacy-owned.md")), "must be moved to custom/, not deleted");
  assert.ok(!existsSync(join(kitDir, "agents", "legacy-owned.md")), "must no longer sit among kit files");
  assert.match(out, /legacy-owned/, "the move must be reported, not silent");
  assert.equal(
    readFileSync(join(kitDir, "custom", "agents", "legacy-owned.md"), "utf8"),
    AGENT("legacy-owned"),
    "content must be carried over verbatim"
  );
});

test("update rescues a hand-edited kit agent as an override rather than overwriting the edit", () => {
  const qa = join(kitDir, "agents", "qa.md");
  const edited = readFileSync(qa, "utf8") + "\n## A rule this project added\n";
  writeFileSync(qa, edited);

  cli(["update", "--kit", "maestro", "--force"]);

  const rescued = join(kitDir, "custom", "agents", "qa.md");
  assert.ok(existsSync(rescued), "a forked kit agent must be preserved");
  assert.match(readFileSync(rescued, "utf8"), /A rule this project added/);
  // The kit's own copy is restored to the shipped version...
  assert.doesNotMatch(readFileSync(qa, "utf8"), /A rule this project added/);
  // ...but custom/ overrides it, so the project's edit is what actually renders.
  assert.match(readFileSync(join(projDir, ".claude", "agents", "qa.md"), "utf8"), /A rule this project added/);
});

test("update is idempotent — a second run rescues nothing further", () => {
  const out = cli(["update", "--kit", "maestro", "--force"]);
  assert.doesNotMatch(out, /moved \d+ file/, "nothing left in the kit folders to move");
});

test("config.roster and config.skills filter the rendered set in the vendored layout", () => {
  const cfgPath = join(kitDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const restore = { roster: cfg.roster, skills: cfg.skills };
  cfg.roster = ["qa"];
  cfg.skills = ["gc"];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  rmSync(join(projDir, ".claude"), { recursive: true, force: true });
  try {
    sync();
    // What SHOULD render: the one rostered kit agent, plus every project-owned agent (which is
    // deliberately not roster-filtered). Earlier tests in this file leave files in custom/, so
    // the expectation is computed rather than hardcoded.
    const custom = (kind) => {
      const dir = join(kitDir, "custom", kind);
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    assert.deepEqual(
      readdirSync(join(projDir, ".claude", "agents")).sort(),
      [...new Set(["qa.md", ...custom("agents")])].sort(),
      "a roster of one must render one KIT agent plus the project's own — not all nine"
    );
    assert.deepEqual(
      readdirSync(join(projDir, ".claude", "skills")).sort(),
      [...new Set(["gc", ...custom("skills")])].sort(),
      "a skills list of one must render one KIT skill plus the project's own"
    );
  } finally {
    Object.assign(cfg, restore);
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    sync();
  }
});

test("the kit's own agents/ is not read as a project overlay when project and kit are one dir", () => {
  // The precise mechanism of defect 2: were the kit's own folder still treated as an overlay,
  // this file would render despite the roster excluding it.
  const cfgPath = join(kitDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const restore = cfg.roster;
  cfg.roster = ["qa"];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  writeFileSync(join(kitDir, "agents", "not-in-roster.md"), AGENT("not-in-roster"));
  rmSync(join(projDir, ".claude"), { recursive: true, force: true });
  try {
    sync();
    assert.ok(
      !existsSync(join(projDir, ".claude", "agents", "not-in-roster.md")),
      "a file inside the kit's own agents/ must not bypass the roster"
    );
  } finally {
    rmSync(join(kitDir, "agents", "not-in-roster.md"), { force: true });
    cfg.roster = restore;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    sync();
  }
});
