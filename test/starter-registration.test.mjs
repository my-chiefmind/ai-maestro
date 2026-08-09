/**
 * Tests that everything the kit SHIPS is also REGISTERED in the orchestrated starter.
 *
 * WHY THIS EXISTS: render/sync.mjs renders the intersection of what the kit ships and what
 * a project's config.json names in `roster` / `skills`. So a skill can land in skills/, be
 * listed in package.json `files`, be published to npm — and still never reach a single
 * project, because no starter config names it. That is exactly what happened to
 * frontend-quality, orchestration-health, pipeline-quality and the pipeline-developer agent
 * (T-017): they shipped in 0.1.22 and were inert.
 *
 * It went unnoticed because the `setup` flow had a second bug (T-011) that re-added every
 * kit file regardless of the roster, masking the omission. With that fixed, an unregistered
 * skill is simply absent — so the omission has to be caught here instead.
 *
 * The lightweight starter is a DELIBERATE subset (a small library doesn't want an
 * orchestrator), so it is checked only for the reverse error: naming something that
 * doesn't exist.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

const kitAgents = readdirSync(join(KIT, "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));
const kitSkills = readdirSync(join(KIT, "skills")).filter((d) =>
  existsSync(join(KIT, "skills", d, "SKILL.md"))
);

const readStarter = (name) =>
  JSON.parse(readFileSync(join(KIT, "starters", name, "config.json"), "utf8"));

const orchestrated = readStarter("orchestrated-project");
const lightweight = readStarter("lightweight-project");

test("every kit agent is in the orchestrated starter's roster", () => {
  const missing = kitAgents.filter((a) => !orchestrated.roster.includes(a));
  assert.deepEqual(
    missing,
    [],
    `agents/${missing.join(".md, agents/")}.md ships but no project gets it — add it to ` +
      `starters/orchestrated-project/config.json "roster" (or delete the agent).`
  );
});

test("every kit skill is in the orchestrated starter's skills list", () => {
  const missing = kitSkills.filter((s) => !orchestrated.skills.includes(s));
  assert.deepEqual(
    missing,
    [],
    `skills/${missing.join("/, skills/")}/ ships but no project gets it — add it to ` +
      `starters/orchestrated-project/config.json "skills" (or delete the skill).`
  );
});

// The reverse error, for both starters: a config naming something the kit doesn't ship
// renders nothing and (since T-004) only warns. A starter is the one config that must be
// exactly right, because every new project is seeded from it.
for (const [label, cfg] of [["orchestrated", orchestrated], ["lightweight", lightweight]]) {
  test(`the ${label} starter names no agent the kit doesn't ship`, () => {
    const unknown = cfg.roster.filter((r) => !kitAgents.includes(r));
    assert.deepEqual(unknown, [], `roster entries with no agents/<name>.md: ${unknown.join(", ")}`);
  });

  test(`the ${label} starter names no skill the kit doesn't ship`, () => {
    const unknown = cfg.skills.filter((s) => !kitSkills.includes(s));
    assert.deepEqual(unknown, [], `skills entries with no skills/<name>/SKILL.md: ${unknown.join(", ")}`);
  });
}

test("the lightweight starter is a subset of the orchestrated one, not a divergent list", () => {
  const stray = [
    ...lightweight.roster.filter((r) => !orchestrated.roster.includes(r)),
    ...lightweight.skills.filter((s) => !orchestrated.skills.includes(s)),
  ];
  assert.deepEqual(
    stray,
    [],
    `the lightweight starter may ship FEWER agents/skills than the orchestrated one, but not ` +
      `different ones: ${stray.join(", ")}`
  );
});
