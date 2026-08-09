/**
 * Tests for the render/sync.mjs features ported from lense-kit's toolkit/render/sync.mjs
 * (T-004 §2 item 12): roster/skills typo warnings, generic {{KEY|filter}} templating,
 * AGENTS.md output, opt-in Codex multi-target rendering, configHash in the lock, and --all
 * batch mode with per-project error isolation.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = join(KIT, "render", "sync.mjs");

function makeProject(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "sync-features-"));
  const proj = join(tmp, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "config.json"), JSON.stringify({
    project: { name: "fixture", areas: ["backend"] },
    roster: ["backend-developer", "qa"],
    skills: ["board-validate"],
    model: { default: "sonnet", floors: {} },
    kitSource: { mode: "self", path: "." },
    ...overrides,
  }));
  writeFileSync(join(proj, "context.md"), "context body\n");
  return { tmp, proj };
}

// console.warn goes to stderr, so combine both streams — execFileSync's return value alone
// (stdout only) would silently drop every warning this test asserts on.
function sync(proj, extraArgs = []) {
  const r = spawnSync(process.execPath, [SYNC, "--project", proj, "--kit", KIT, ...extraArgs], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sync.mjs exited ${r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}

test("generates AGENTS.md alongside CLAUDE.md", () => {
  const { tmp, proj } = makeProject();
  try {
    sync(proj);
    assert.ok(existsSync(join(proj, "AGENTS.md")));
    const agentsMd = readFileSync(join(proj, "AGENTS.md"), "utf8");
    assert.match(agentsMd, /fixture — agent brief/);
    assert.match(agentsMd, /context body/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("never overwrites a pre-existing AGENTS.md it didn't generate", () => {
  const { tmp, proj } = makeProject();
  try {
    writeFileSync(join(proj, "AGENTS.md"), "the project's own AGENTS.md\n");
    const out = sync(proj);
    assert.equal(readFileSync(join(proj, "AGENTS.md"), "utf8"), "the project's own AGENTS.md\n");
    assert.match(out, /kept your existing AGENTS\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("warns on a typo'd roster or skills entry instead of silently dropping or crashing", () => {
  const { tmp, proj } = makeProject({ roster: ["backend-developer", "typo-agent"], skills: ["board-validate", "typo-skill"] });
  try {
    const out = sync(proj);
    assert.match(out, /config\.roster: "typo-agent" matches no agent/);
    assert.match(out, /config\.skills: "typo-skill" matches no skill/);
    // and it still rendered everything real, rather than aborting
    assert.ok(existsSync(join(proj, ".claude", "agents", "backend-developer.md")));
    assert.ok(existsSync(join(proj, ".claude", "skills", "board-validate", "SKILL.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("opt-in Codex rendering: off by default, on with targets.codex", () => {
  const { tmp, proj } = makeProject();
  try {
    sync(proj);
    assert.ok(!existsSync(join(proj, ".codex")), "no .codex/ without targets.codex");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const { tmp: tmp2, proj: proj2 } = makeProject({ targets: { codex: true } });
  try {
    sync(proj2);
    const toml = readFileSync(join(proj2, ".codex", "agents", "backend-developer.toml"), "utf8");
    assert.match(toml, /name\s*=\s*"backend-developer"/);
    assert.match(toml, /\[prompt\]/);
    // the agent's frontmatter description made it into the Codex file, not just a placeholder
    const md = readFileSync(join(proj2, ".claude", "agents", "backend-developer.md"), "utf8");
    const description = md.match(/description:\s*"(.*)"/)[1];
    assert.ok(toml.includes(description.slice(0, 40)), "Codex description should come from the agent's own frontmatter");
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }
});

test("the lock records a configHash that changes when config.json changes", () => {
  const { tmp, proj } = makeProject();
  try {
    sync(proj);
    const lock1 = JSON.parse(readFileSync(join(proj, ".maestro.lock"), "utf8"));
    assert.match(lock1.configHash, /^sha256:/);

    const config = JSON.parse(readFileSync(join(proj, "config.json"), "utf8"));
    config.project.areas.push("infra");
    writeFileSync(join(proj, "config.json"), JSON.stringify(config));
    sync(proj);
    const lock2 = JSON.parse(readFileSync(join(proj, ".maestro.lock"), "utf8"));
    assert.notEqual(lock2.configHash, lock1.configHash);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--all renders every registry project and isolates a broken one", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sync-all-"));
  try {
    const good = join(tmp, "good");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "config.json"), JSON.stringify({
      project: { name: "good" }, kitSource: { path: relative(good, KIT) },
    }));
    writeFileSync(join(good, "context.md"), "");

    const brokenDir = join(tmp, "broken");
    mkdirSync(brokenDir, { recursive: true }); // no config.json at all — never set up

    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      projects: [{ name: "good-project", path: good }, { name: "broken-project", path: brokenDir }],
    }));

    const r = spawnSync(process.execPath, [SYNC, "--all", "--registry", registryPath], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    assert.notEqual(r.status, 0, "--all should exit non-zero when a project failed");
    assert.match(out, /✓ Rendered good/);
    assert.match(out, /broken-project: not set up/);
    assert.ok(existsSync(join(good, "CLAUDE.md")), "the good project should still have rendered");
    assert.match(out, /1\/2 project\(s\) rendered cleanly/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("{{KEY | filter}} templating: unknown keys pass through literally", () => {
  const { tmp, proj } = makeProject();
  try {
    mkdirSync(join(proj, "agents"), { recursive: true });
    writeFileSync(join(proj, "agents", "custom.md"), '---\nname: "custom"\ndescription: "test"\n---\n\nBoard: {{BOARD}}. Unknown: {{NOT_A_REAL_KEY}}.\n');
    sync(proj);
    const rendered = readFileSync(join(proj, ".claude", "agents", "custom.md"), "utf8");
    assert.match(rendered, /Board: board\./);
    assert.match(rendered, /Unknown: \{\{NOT_A_REAL_KEY\}\}\./, "an unmatched key must pass through untouched, not be blanked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("opt-in orchestrate workflow: off by default, generated + injected with targets.workflow", () => {
  const off = makeProject();
  try {
    sync(off.proj);
    assert.ok(!existsSync(join(off.proj, ".claude", "workflows", "orchestrate.js")),
      "no workflow file without targets.workflow");
  } finally {
    rmSync(off.tmp, { recursive: true, force: true });
  }

  const on = makeProject({
    project: { name: "fixture", areas: ["backend", "frontend"] },
    roster: ["orchestrator", "principal-engineer", "backend-developer", "frontend-developer", "qa", "principal-delivery"],
    targets: { workflow: true },
    orchestrator: { mergeStrategy: "pr", publishBoard: true, testCmd: { backend: "npm test" } },
  });
  try {
    const out = sync(on.proj);
    assert.match(out, /orchestrate workflow/);
    const wf = readFileSync(join(on.proj, ".claude", "workflows", "orchestrate.js"), "utf8");

    // Wrapper + core are both present, with every placeholder resolved.
    assert.match(wf, /export const meta = \{/);
    assert.match(wf, /name: "orchestrate"/);
    assert.doesNotMatch(wf, /\{\{[A-Z0-9_]+\}\}/, "no unresolved placeholders may survive");

    // Injected constants reflect this project and this config.
    const cfg = wf.match(/const PROJECT_CONFIG = \{([\s\S]*?)\n\};/)[1];
    assert.match(cfg, /MERGE_STRATEGY: "pr"/);
    assert.match(cfg, /PUBLISH_BOARD: true/);
    assert.match(cfg, /"backend":\s*"npm test"/, "per-area test command must be injected");
    assert.ok(cfg.includes(JSON.stringify(join(on.proj, "board", "data.json"))), "BOARD must be the project's board");
    assert.match(cfg, /"qa":\s*\{"type":"qa","role":"reader"\}/, "qa must be a reader");
    assert.match(cfg, /"frontend":\s*\{"type":"frontend-developer","role":"writer"\}/, "frontend must be a writer");
    assert.doesNotMatch(cfg, /"orchestrator"/, "the orchestrator itself is not a stage agent");

    // The validator command is wired in, so board writes get checked by the real kit rule.
    assert.match(cfg, /VALIDATE_CMD: "node .*validate-board\.mjs/);

    // The embedded core kept its terminal-state adaptation: finished tickets are archived,
    // never marked done in place on the active board.
    assert.match(wf, /land-and-archive convention/);
  } finally {
    rmSync(on.tmp, { recursive: true, force: true });
  }
});

test("the generated workflow rerenders deterministically and is tracked by the lock", () => {
  const { tmp, proj } = makeProject({ targets: { workflow: true } });
  try {
    // version-source.test.mjs runs in a parallel process and briefly rewrites the kit's
    // VERSION file for its drift test — normalize the stamped version so this comparison
    // pins determinism of the render, not the absence of that unrelated race.
    const stripVersion = (s) => s.replace(/Generated by AI Maestro v\S+/, "Generated by AI Maestro vX");
    sync(proj);
    const p = join(proj, ".claude", "workflows", "orchestrate.js");
    const first = readFileSync(p, "utf8");
    sync(proj);
    assert.equal(stripVersion(readFileSync(p, "utf8")), stripVersion(first), "two renders must be byte-identical");
    const lock = JSON.parse(readFileSync(join(proj, ".maestro.lock"), "utf8"));
    const key = Object.keys(lock.files).find((k) => k.endsWith(join("workflows", "orchestrate.js")));
    assert.ok(key, "the lock must cover the generated workflow");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
