/**
 * Regression tests for T-018: installing the kit into a repo that ALREADY uses Claude Code
 * must not destroy that repo's agents and skills.
 *
 * WHY THIS EXISTS: the renderer writes into .claude/, so on the first render every pre-existing
 * agent or skill whose name the kit also ships was silently overwritten — before any update,
 * with no message, and with no way back. The exposed names are exactly the ones a team is most
 * likely to have already used: qa, devops, orchestrator, gc, security-review.
 *
 * The guard existed but was scoped to two filenames (CLAUDE.md, AGENTS.md). The rule behind it
 * — never overwrite a file we did not generate — belongs to everything the renderer writes, and
 * the prior lock is what tells "ours from last time" from "theirs".
 *
 * Files with a custom/ slot are MOVED there, which both preserves them and keeps them the thing
 * that renders (custom/ overrides the kit file of the same name), so the team's setup behaves
 * after the install exactly as it did before it.
 *
 * Reproduced against 0.1.23 before this was written.
 *
 * Run: npm test
 */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

let tmp, projDir;
const claude = (...p) => join(projDir, ".claude", ...p);
const custom = (...p) => join(projDir, "custom", ...p);

function sync(extra = []) {
  const r = spawnSync(process.execPath, [join(KIT, "render", "sync.mjs"), "--project", projDir, "--kit", KIT, ...extra], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const AGENT = (n, marker) => `---\nname: ${n}\ndescription: the team's own ${n}\n---\n\n# ${n}\n${marker}\n`;
const SKILL = (n, marker) => `---\nname: ${n}\ndescription: the team's own ${n}\n---\n\n# ${n}\n${marker}\n`;

/** A repo that already used Claude Code: two colliding names, two unique ones, its own CLAUDE.md. */
function seedExistingClaudeSetup() {
  mkdirSync(claude("agents"), { recursive: true });
  mkdirSync(claude("skills", "deploy"), { recursive: true });
  mkdirSync(claude("skills", "gc"), { recursive: true });
  writeFileSync(claude("agents", "qa.md"), AGENT("qa", "OUR-QA"));                     // collides
  writeFileSync(claude("agents", "code-reviewer.md"), AGENT("code-reviewer", "OUR-CR")); // unique
  writeFileSync(claude("skills", "gc", "SKILL.md"), SKILL("gc", "OUR-GC"));            // collides
  writeFileSync(claude("skills", "deploy", "SKILL.md"), SKILL("deploy", "OUR-DEPLOY")); // unique
  writeFileSync(join(projDir, "CLAUDE.md"), "# my-app\nOUR-CLAUDEMD\n");
}

before(() => { tmp = mkdtempSync(join(tmpdir(), "maestro-adopt-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  projDir = join(tmp, `p${Math.random().toString(36).slice(2, 9)}`);
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  cpSync(join(KIT, "starters", "orchestrated-project"), projDir, { recursive: true, filter });
});

test("a pre-existing agent whose name the kit also ships is adopted, never overwritten", () => {
  seedExistingClaudeSetup();
  const { code, out } = sync();
  assert.equal(code, 0, out);

  // The content is intact and still what renders — the whole point of adopting rather than keeping.
  assert.match(readFileSync(claude("agents", "qa.md"), "utf8"), /OUR-QA/, "the team's qa must survive the install");
  assert.match(readFileSync(custom("agents", "qa.md"), "utf8"), /OUR-QA/, "and now live in custom/");
  assert.match(readFileSync(claude("skills", "gc", "SKILL.md"), "utf8"), /OUR-GC/);
  assert.match(readFileSync(custom("skills", "gc", "SKILL.md"), "utf8"), /OUR-GC/);
});

test("a pre-existing agent with a name the kit doesn't ship is adopted too, not left orphaned", () => {
  seedExistingClaudeSetup();
  assert.equal(sync().code, 0);
  assert.match(readFileSync(claude("agents", "code-reviewer.md"), "utf8"), /OUR-CR/);
  assert.ok(existsSync(custom("agents", "code-reviewer.md")), "brought under management, so it renders deterministically");
  assert.ok(existsSync(custom("skills", "deploy", "SKILL.md")));
});

test("CLAUDE.md is kept in place rather than adopted — it has no custom/ slot", () => {
  seedExistingClaudeSetup();
  const { out } = sync();
  assert.match(readFileSync(join(projDir, "CLAUDE.md"), "utf8"), /OUR-CLAUDEMD/);
  assert.ok(!existsSync(custom("CLAUDE.md")), "there is no roster slot for it, so it stays where it is");
  assert.match(out, /kept your existing CLAUDE\.md/);
});

test("the move is reported per file, and names both ends", () => {
  seedExistingClaudeSetup();
  const { out } = sync();
  assert.match(out, /adopted 4 file\(s\) that were already in \.claude\//);
  assert.match(out, /\.claude\/agents\/qa\.md\s+→\s+custom\/agents\/qa\.md/);
  assert.match(out, /\.claude\/skills\/gc\s+→\s+custom\/skills\/gc/);
});

test("adoption is idempotent — a second render moves nothing", () => {
  seedExistingClaudeSetup();
  assert.equal(sync().code, 0);
  const second = sync();
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.out, /adopted \d+ file/, "everything is already in custom/ and in the lock");
});

test("a file the renderer itself generated last time is still replaced, not adopted", () => {
  // Without this, every kit agent would migrate into custom/ on the second render and the
  // project would fork the entire roster by accident.
  assert.equal(sync().code, 0);
  const before = readFileSync(claude("agents", "qa.md"), "utf8");
  const second = sync();
  assert.doesNotMatch(second.out, /adopted/);
  assert.ok(!existsSync(custom("agents", "qa.md")), "a kit-generated file is ours to rewrite");
  assert.equal(readFileSync(claude("agents", "qa.md"), "utf8"), before);
});

test("--check never writes, even when there is something to adopt", () => {
  seedExistingClaudeSetup();
  const { out } = sync(["--check"]);
  assert.ok(!existsSync(custom("agents", "qa.md")), "check mode must not move files");
  assert.match(readFileSync(claude("agents", "qa.md"), "utf8"), /OUR-QA/, "nor rewrite them");
  assert.doesNotMatch(out, /adopted \d+ file/);
});

test("when custom/ already owns the name, the .claude/ copy is reported as stale, not silently dropped", () => {
  mkdirSync(custom("agents"), { recursive: true });
  writeFileSync(custom("agents", "qa.md"), AGENT("qa", "CUSTOM-WINS"));
  mkdirSync(claude("agents"), { recursive: true });
  writeFileSync(claude("agents", "qa.md"), AGENT("qa", "STALE-COPY"));

  const { code, out } = sync();
  assert.equal(code, 0, out);
  assert.match(out, /stale copy/);
  assert.match(readFileSync(custom("agents", "qa.md"), "utf8"), /CUSTOM-WINS/, "custom/ is not clobbered");
  assert.match(readFileSync(claude("agents", "qa.md"), "utf8"), /CUSTOM-WINS/, "and is what renders");
});

test("the report separates adding your own from replacing a kit agent", () => {
  seedExistingClaudeSetup();
  const { out } = sync();
  // The bug this pins: all four used to be reported as one "overridden" count, hiding the two
  // that actually cut this project off from kit updates.
  assert.match(out, /agents: 1 added \(code-reviewer\); 1 replacing a kit agent \(qa\)/);
  assert.match(out, /skills: 1 added \(deploy\); 1 replacing a kit skill \(gc\)/);
});

test("replacing a kit agent warns with the consequence and the cheaper alternative", () => {
  seedExistingClaudeSetup();
  const { out } = sync();
  assert.match(out, /"qa" replaces the kit's — kit updates to it will not reach this project/);
  assert.match(out, /custom\/agents\/qa\.overlay\.md/, "point at the extend form");
  assert.match(out, /custom\/skills\/gc\/OVERLAY\.md/);
  assert.doesNotMatch(out, /"code-reviewer" replaces/, "adding your own agent warns about nothing");
});
