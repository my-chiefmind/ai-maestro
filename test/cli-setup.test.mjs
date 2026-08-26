/**
 * Integration tests for `maestro setup`'s initial board seeding.
 *
 * WHY THIS EXISTS: `setup` vendors the whole kit — including this repo's own board/ — into
 * <repo>/maestro/ before anything else runs. Once board/data.json held ai-maestro's own real
 * maintenance tickets instead of placeholder content (see board/archive.json's T-001 entry),
 * that wholesale copy became a live leak: every fresh `setup` seeded a brand-new project with
 * ai-maestro's own roadmap. These tests pin the fix — the initial board comes from the
 * orchestrated-project starter, never from whatever vendoring happened to leave at kit/board/.
 *
 * The npm install is simulated by copying the kit under a node_modules/ path, exactly what
 * flips IS_PACKAGED in bin/cli.mjs (same technique as test/cli-update.test.mjs).
 *
 * Run: npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp;
after(() => rmSync(tmp, { recursive: true, force: true }));

function packagedCli() {
  tmp = mkdtempSync(join(tmpdir(), "maestro-setup-"));
  const pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) {
    cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });
  }
  const projDir = join(tmp, "proj");
  mkdirSync(projDir);
  const run = (args) =>
    execFileSync(process.execPath, [join(pkgDir, "bin", "cli.mjs"), ...args], {
      cwd: projDir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  return { projDir, run };
}

test("a fresh setup seeds the starter's board, not this kit's own", () => {
  const { projDir, run } = packagedCli();
  run(["setup", "--yes", "--no-board"]);

  const dataPath = join(projDir, "maestro", "board", "data.json");
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  assert.deepEqual(
    data.tickets.map((t) => t.id),
    ["T-001"],
    "should get the starter's single placeholder ticket, not ai-maestro's own T-00x tickets",
  );
  assert.equal(data.tickets[0].name, "First ticket — replace me");
  assert.deepEqual(data.epics.map((e) => e.id), ["e1"]);
  assert.equal(data.epics[0].name, "Foundation", "should get the starter's epic, not ai-maestro's own epics");

  assert.ok(existsSync(join(projDir, "AGENTS.md")), "setup must generate Codex project guidance");
  assert.ok(existsSync(join(projDir, ".agents", "skills", "orchestrator", "SKILL.md")), "setup must generate Codex skills");
  assert.ok(existsSync(join(projDir, ".codex", "agents", "orchestrator.toml")), "setup must generate Codex subagents");
  const prTitleWorkflow = join(projDir, ".github", "workflows", "maestro-pr-title.yml");
  assert.ok(existsSync(prTitleWorkflow), "setup must install the PR title gate");
  assert.doesNotMatch(readFileSync(prTitleWorkflow, "utf8"), /maestro\/scripts\//, "the gate must work with the capsule-style init too");
  assert.ok(existsSync(join(projDir, ".github", "PULL_REQUEST_TEMPLATE.md")), "setup must install the PR template");

  const archive = JSON.parse(readFileSync(join(projDir, "maestro", "board", "archive.json"), "utf8"));
  assert.deepEqual(archive.tickets, []);

  assert.ok(!existsSync(join(projDir, "maestro", "board", "specs")), "the kit's own board/specs/ must not be seeded");
});

test("a --force re-run never touches the project's own board", () => {
  const { projDir, run } = packagedCli();
  run(["setup", "--yes", "--no-board"]);

  const dataPath = join(projDir, "maestro", "board", "data.json");
  const liveBoard = JSON.stringify({ epics: [], tickets: [{ id: "T-999", status: "todo" }] }) + "\n";
  writeFileSync(dataPath, liveBoard);

  run(["setup", "--yes", "--no-board", "--force"]);
  assert.equal(readFileSync(dataPath, "utf8"), liveBoard, "the project's live board must survive a --force re-run");
});

test("setup preserves existing GitHub PR conventions", () => {
  const { projDir, run } = packagedCli();
  const github = join(projDir, ".github");
  const workflows = join(github, "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(github, "PULL_REQUEST_TEMPLATE.md"), "# Team template\n");
  writeFileSync(join(workflows, "maestro-pr-title.yml"), "# Team workflow\n");

  run(["setup", "--yes", "--no-board"]);

  assert.equal(readFileSync(join(github, "PULL_REQUEST_TEMPLATE.md"), "utf8"), "# Team template\n");
  assert.equal(readFileSync(join(workflows, "maestro-pr-title.yml"), "utf8"), "# Team workflow\n");
});

test("setup creates the custom/ folder the docs tell people to use", () => {
  // README and docs/AGENTS.md name custom/agents/ as where your own agents go, but nothing
  // created it — it only appeared when `update` or the renderer rescued a file into it. A
  // documented path that isn't there on a fresh install reads as "not really how this works",
  // and sends people back to hand-editing .claude/, which the renderer overwrites.
  const { projDir, run } = packagedCli();
  run(["setup", "--yes", "--no-board"]);

  const custom = join(projDir, "maestro", "custom");
  assert.ok(existsSync(join(custom, "agents")), "custom/agents/ must exist");
  assert.ok(existsSync(join(custom, "skills")), "custom/skills/ must exist");
  assert.match(readFileSync(join(custom, "README.md"), "utf8"), /custom\/agents\/<name>\.overlay\.md/);

  // An agent dropped in renders without any config.json change, which is what the README promises.
  writeFileSync(join(custom, "agents", "house.md"), "---\nname: house\ndescription: ours\n---\n# House\n");
  run(["sync", "--project", join(projDir, "maestro")]);
  assert.ok(existsSync(join(projDir, ".claude", "agents", "house.md")));
  assert.ok(existsSync(join(projDir, ".codex", "agents", "house.toml")));

  // A --force re-run must not overwrite an edited README or eat the agent.
  const edited = "# mine\n";
  writeFileSync(join(custom, "README.md"), edited);
  run(["setup", "--yes", "--no-board", "--force"]);
  assert.equal(readFileSync(join(custom, "README.md"), "utf8"), edited);
  assert.ok(existsSync(join(custom, "agents", "house.md")));
});
