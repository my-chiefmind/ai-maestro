/**
 * Tests for the roster/skills reconciliation `maestro update` does after refreshing a kit.
 *
 * WHY THIS EXISTS: `config.roster` / `config.skills` select which KIT agents and skills a
 * project takes, and `update` never edits a project's config. So a roster stays frozen at
 * whatever the starter shipped the day the project was set up, and everything added to the kit
 * afterwards is simply absent — not rendered, not mentioned, no error.
 *
 * It stayed invisible for a second reason: until 0.1.27 those filters were a no-op in the
 * vendored layout, so a list could drift for releases with no effect at all. When the fix made
 * the filters real, the accumulated drift surfaced at once as deletions — a real project lost 8
 * agents/skills in one update and the command said nothing about why.
 *
 * The renderer warned in only one direction ("config names something that doesn't exist"). The
 * direction that loses you things — "the kit ships it, your config doesn't name it" — had no
 * check at all.
 *
 * Adoption is never silent: `roster` is also how a project deliberately drops an agent, so a
 * command that quietly re-adds it makes the list untrustworthy in the other direction.
 *
 * Run: npm test
 */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, pkgDir, cliPath, projDir, kitDir;

// --offline throughout: `update` otherwise asks npm whether this CLI is stale, and a suite that
// reached the network would break the day the next version ships.
const update = (extra = []) => {
  const r = spawnSync(process.execPath, [cliPath, "update", "--kit", "maestro", "--force", "--offline", ...extra], {
    cwd: projDir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const readConfig = () => JSON.parse(readFileSync(join(kitDir, "config.json"), "utf8"));
const writeConfig = (c) => writeFileSync(join(kitDir, "config.json"), JSON.stringify(c, null, 2));
const rendered = (kind) =>
  existsSync(join(projDir, ".claude", kind)) ? readdirSync(join(projDir, ".claude", kind)) : [];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-reconcile-"));
  pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  cliPath = join(pkgDir, "bin", "cli.mjs");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  projDir = join(tmp, `p${Math.random().toString(36).slice(2, 9)}`);
  mkdirSync(projDir, { recursive: true });
  kitDir = join(projDir, "maestro");
  execFileSync(process.execPath, [cliPath, "setup", "--yes", "--no-board", "--name", "proj"], {
    cwd: projDir, stdio: "pipe", env: { ...process.env, NO_COLOR: "1" },
  });
});

/** Drop entries from the project's config, the way a stale roster looks. */
function dropFromConfig({ agents = [], skills = [] }) {
  const c = readConfig();
  c.roster = c.roster.filter((a) => !agents.includes(a));
  c.skills = c.skills.filter((s) => !skills.includes(s));
  writeConfig(c);
}

test("update lists what the kit ships that the config doesn't name", () => {
  dropFromConfig({ agents: ["technical-writer"], skills: ["project-plan", "gc"] });

  const { code, out } = update(["--no-adopt"]);
  assert.equal(code, 0);
  assert.match(out, /ships 3 item\(s\) your config\.json doesn't list/);
  assert.match(out, /agents: technical-writer/);
  assert.match(out, /skills: .*project-plan/);
  assert.match(out, /skills: .*gc/);
});

test("reporting alone never edits the config or renders the missing items", () => {
  dropFromConfig({ agents: ["technical-writer"], skills: ["project-plan"] });
  const before = readConfig();

  update(["--no-adopt"]);

  assert.deepEqual(readConfig(), before, "a project may have dropped an agent on purpose");
  assert.ok(!rendered("agents").includes("technical-writer.md"));
  assert.ok(!rendered("skills").includes("project-plan"));
});

test("--adopt-new adds them to the config and they render", () => {
  dropFromConfig({ agents: ["technical-writer"], skills: ["project-plan", "gc"] });

  const { code, out } = update(["--adopt-new"]);
  assert.equal(code, 0);
  assert.match(out, /added 3 entry\(ies\)/);

  const c = readConfig();
  assert.ok(c.roster.includes("technical-writer"));
  assert.ok(c.skills.includes("project-plan") && c.skills.includes("gc"));
  assert.ok(rendered("agents").includes("technical-writer.md"), "and the render must follow");
  assert.ok(rendered("skills").includes("project-plan"));
});

test("a config that already lists everything says nothing", () => {
  const { out } = update(["--no-adopt"]);
  assert.doesNotMatch(out, /doesn't list/, "no nagging when there is nothing to report");
});

test("the deleted-agent case: the file comes back only once the config names it again", () => {
  // The scenario that motivated this: the agent disappears because the roster excludes it, and
  // an update alone will not bring it back — which is correct, but must be VISIBLE.
  dropFromConfig({ agents: ["devops"] });

  update(["--no-adopt"]);
  assert.ok(!rendered("agents").includes("devops.md"), "excluded by the roster, so not rendered");

  const restored = update(["--adopt-new"]);
  assert.match(restored.out, /added 1 entry/);
  assert.ok(rendered("agents").includes("devops.md"), "back once the roster names it again");
});

test("items added by THIS release are marked, and distinguished from long-unlisted ones", () => {
  // The vendor lock records what the previous version shipped, so "new in this release" is
  // knowable — and is the difference between "the kit grew" and "you dropped this ages ago".
  mkdirSync(join(pkgDir, "skills", "brand-new-skill"), { recursive: true });
  writeFileSync(join(pkgDir, "skills", "brand-new-skill", "SKILL.md"),
    "---\nname: brand-new-skill\ndescription: shipped by the next release\n---\n# New\n");
  try {
    dropFromConfig({ skills: ["gc"] }); // long-standing, deliberately dropped
    const { out } = update(["--no-adopt"]);

    assert.match(out, /brand-new-skill \(new\)/, "added by this release");
    assert.doesNotMatch(out, /gc \(new\)/, "gc has been in the kit all along");
    assert.match(out, /\(new\) = added by this release/);
  } finally {
    rmSync(join(pkgDir, "skills", "brand-new-skill"), { recursive: true, force: true });
  }
});

test("a project with no roster/skills keys takes everything, so nothing can be missing", () => {
  const c = readConfig();
  delete c.roster;
  delete c.skills;
  writeConfig(c);

  const { out } = update(["--no-adopt"]);
  assert.doesNotMatch(out, /doesn't list/);
  assert.ok(rendered("agents").length > 0, "and it still renders the full kit");
});

test("--yes stays non-interactive: it reports but does not adopt", () => {
  // --yes means "don't ask me", and the safe answer to "may I edit your config?" is no.
  dropFromConfig({ skills: ["project-plan"] });
  const before = readConfig();

  const { out } = update(["--yes"]);
  assert.match(out, /doesn't list/);
  assert.deepEqual(readConfig(), before);
});
