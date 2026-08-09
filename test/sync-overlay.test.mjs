/**
 * Tests for T-012: extending a kit agent/skill instead of forking it.
 *
 * WHY THIS EXISTS: before this, the only way to customise a kit agent was to copy the whole
 * file and edit it. The copy then stops receiving every later kit improvement, and the two
 * drift apart permanently — the umbrella this kit was extracted from reached 133-182 diff
 * lines per agent that way, which is why T-004 exists at all.
 *
 * So `custom/agents/<name>.overlay.md` and `custom/skills/<name>/OVERLAY.md` APPEND to the
 * kit's file under a `## Project overlay` heading. The kit half keeps updating; the project
 * half is never touched. Overriding and extending the same name is contradictory and is an
 * error rather than a silent precedence rule.
 *
 * Run: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

let tmp, projDir;
const customAgents = () => join(projDir, "custom", "agents");
const customSkills = () => join(projDir, "custom", "skills");

/** Render, returning the exit code and output rather than throwing — several cases expect failure. */
function sync() {
  const r = spawnSync(process.execPath, [join(KIT, "render", "sync.mjs"), "--project", projDir, "--kit", KIT], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const rendered = (rel) => readFileSync(join(projDir, ".claude", ...rel), "utf8");

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-overlay-render-"));
  projDir = join(tmp, "proj");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  cpSync(join(KIT, "starters", "orchestrated-project"), projDir, { recursive: true, filter });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(projDir, "custom"), { recursive: true, force: true });
  rmSync(join(projDir, ".claude"), { recursive: true, force: true });
  rmSync(join(projDir, ".maestro.lock"), { force: true });
});

test("an agent overlay is appended to the kit agent, not substituted for it", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.overlay.md"), "Never approve a diff that touches `infra/prod/**`.\n");

  const { code, out } = sync();
  assert.equal(code, 0, out);

  const text = rendered(["agents", "qa.md"]);
  const kitText = readFileSync(join(KIT, "agents", "qa.md"), "utf8");
  assert.match(text, /## Project overlay/);
  assert.match(text, /Never approve a diff that touches/);
  // The kit's own content is still there, in full, ahead of the overlay.
  assert.ok(
    text.indexOf(kitText.trim().slice(0, 200)) === 0 || text.startsWith(kitText.trimEnd().slice(0, 100)),
    "the kit agent's content must lead the file"
  );
  assert.ok(text.indexOf("## Project overlay") > kitText.length - 50, "the overlay must come after the kit content");
});

test("a skill overlay is appended to the kit SKILL.md", () => {
  mkdirSync(join(customSkills(), "gc"), { recursive: true });
  writeFileSync(join(customSkills(), "gc", "OVERLAY.md"), "Also confirm the release tag matches VERSION.\n");

  const { code, out } = sync();
  assert.equal(code, 0, out);

  const text = rendered(["skills", "gc", "SKILL.md"]);
  assert.match(text, /## Project overlay/);
  assert.match(text, /release tag matches VERSION/);
  assert.match(text, /name: "gc"/, "the kit skill's frontmatter must survive");
});

test("an overlay goes through the same {{KEY}} templating as kit content", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.overlay.md"), "Board lives at {{BOARD}} in {{PROJECT_NAME}}.\n");

  assert.equal(sync().code, 0);
  const text = rendered(["agents", "qa.md"]);
  assert.doesNotMatch(text, /\{\{BOARD\}\}/, "placeholders must be substituted in overlay content too");
  assert.match(text, /Board lives at board in my-app\./);
});

test("overriding AND extending the same name is a hard error, not a silent winner", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.md"), "---\nname: qa\ndescription: ours\n---\n# Ours\n");
  writeFileSync(join(customAgents(), "qa.overlay.md"), "and also this\n");

  const { code, out } = sync();
  assert.equal(code, 2, "must fail rather than pick one");
  assert.match(out, /BOTH a full override and an \.overlay\.md/);
});

test("an overlay for something this project doesn't render warns instead of vanishing", () => {
  const cfgPath = join(projDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const restore = cfg.roster;
  cfg.roster = ["qa"];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "devops.overlay.md"), "something\n");
  try {
    const { code, out } = sync();
    assert.equal(code, 0, "a stray overlay is a warning, not a failure");
    assert.match(out, /overlay for "devops" has nothing to extend/);
    assert.ok(!existsSync(join(projDir, ".claude", "agents", "devops.md")));
  } finally {
    cfg.roster = restore;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
});

test("sync reports which agents/skills are overridden vs extended", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.overlay.md"), "extended\n");
  writeFileSync(join(customAgents(), "house.md"), "---\nname: house\ndescription: ours\n---\n# House\n");

  const { out } = sync();
  assert.match(out, /your customisations:/);
  // `house` is a name the kit doesn't ship, so it ADDS an agent; it replaces nothing. Reporting
  // it as "overridden" was the T-018 bug — it hid the one case that actually costs you kit
  // updates behind names that cost you nothing.
  assert.match(out, /1 added \(house\)/);
  assert.match(out, /extended \(qa\)/);
  assert.doesNotMatch(out, /house.*replac/i);
});

test("an overlay file is never itself rendered as an agent", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.overlay.md"), "extended\n");
  assert.equal(sync().code, 0);
  assert.ok(
    !existsSync(join(projDir, ".claude", "agents", "qa.overlay.md")),
    "`<name>.overlay.md` extends an agent; it is not an agent called `<name>.overlay`"
  );
});

test("rendering stays deterministic with overlays in play", () => {
  mkdirSync(customAgents(), { recursive: true });
  writeFileSync(join(customAgents(), "qa.overlay.md"), "extended\n");
  assert.equal(sync().code, 0);
  const first = rendered(["agents", "qa.md"]);
  const lock = readFileSync(join(projDir, ".maestro.lock"), "utf8");

  assert.equal(sync().code, 0);
  assert.equal(rendered(["agents", "qa.md"]), first);
  assert.equal(readFileSync(join(projDir, ".maestro.lock"), "utf8"), lock);

  const check = spawnSync(process.execPath, [join(KIT, "render", "sync.mjs"), "--project", projDir, "--kit", KIT, "--check"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(check.status, 0, `--check must pass on a freshly rendered tree:\n${check.stdout}${check.stderr}`);
});
