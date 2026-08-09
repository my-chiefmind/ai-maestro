#!/usr/bin/env node
/**
 * sync.mjs — AI Maestro renderer.
 *
 * Generates a project's .claude/ (agents + skills) and a project CLAUDE.md from the kit
 * plus the project's hand-maintained config.json + context.md, and writes a .maestro.lock
 * with content hashes for drift detection.
 *
 * Usage:
 *   node render/sync.mjs --project <dir> [--kit <dir>] [--check]
 *   node render/sync.mjs --all [--registry <file>] [--check]
 *
 *   --project   the managed project directory (contains config.json + context.md)
 *   --kit       the AI Maestro kit root (default: resolved from config.kitSource, else this repo)
 *   --check     verify generated files are current; exit 1 on drift (for CI / pre-commit)
 *   --all       render every project in a registry (default ./maestro-registry.json), one
 *               subprocess per project so a broken project can't abort the rest of the batch
 *   --registry  registry file for --all — see scripts/registry.mjs
 *
 * No third-party dependencies.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync,
} from "fs";
import { createHash } from "crypto";
import { resolve, dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { readRegistry, findKitDir } from "../scripts/registry.mjs";
import { agentFileToCode } from "../scripts/board-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const THIS_KIT = resolve(__dir, "..");
const THIS_SCRIPT = fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const allMode = args.includes("--all");
const projectArg = argValue("--project");
const kitArg = argValue("--kit");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
function sha256(s) {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}
function readJSON(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ── --all: one project at a time, in a subprocess, so a broken project can't take the rest
// of the batch down with it — each project's failure is isolated and reported, not fatal. ──
if (allMode) {
  const registryPath = resolve(argValue("--registry") || "maestro-registry.json");
  let projects;
  try {
    ({ projects } = readRegistry(registryPath));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  if (!projects.length) {
    console.error(`✗ ${registryPath} lists no projects.`);
    process.exit(2);
  }

  let failures = 0;
  for (const { name, path: projectPath } of projects) {
    const kitDir = existsSync(projectPath) ? findKitDir(projectPath) : null;
    if (!kitDir) {
      console.error(`✗ ${name}: not set up (no config.json at ${projectPath}/maestro or ${projectPath})`);
      failures++;
      continue;
    }
    const r = spawnSync(process.execPath, [THIS_SCRIPT, "--project", kitDir, ...(checkMode ? ["--check"] : [])], {
      encoding: "utf8",
    });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) {
      console.error(`✗ ${name}: render failed (exit ${r.status})`);
      failures++;
    }
  }
  console.log(`\n${failures ? "✗" : "✓"} ${projects.length - failures}/${projects.length} project(s) rendered cleanly.`);
  process.exit(failures ? 1 : 0);
}

if (!projectArg) {
  console.error("Error: --project <dir> is required (or --all with a registry).");
  process.exit(2);
}
const PROJECT = resolve(projectArg);
const configPath = join(PROJECT, "config.json");
if (!existsSync(configPath)) {
  console.error(`Error: no config.json in ${PROJECT}`);
  process.exit(2);
}
const config = readJSON(configPath);

// Where generated files (.claude/, CLAUDE.md, .maestro.lock) are written. Defaults to the
// project dir; setups that keep config in a subfolder point this at the repo root (via --out
// or config.outDir) so the coding tool discovers .claude/ there.
const OUT = argValue("--out")
  ? resolve(argValue("--out"))
  : config.outDir
    ? resolve(PROJECT, config.outDir)
    : PROJECT;

// Resolve the kit root: explicit --kit, else config.kitSource.path, else this repo.
const KIT = resolve(
  kitArg ?? (config.kitSource?.path ? join(PROJECT, config.kitSource.path) : THIS_KIT)
);
if (!existsSync(join(KIT, "agents"))) {
  console.error(`Error: kit not found at ${KIT} (no agents/ dir).`);
  process.exit(2);
}

const kitVersion = existsSync(join(KIT, "VERSION"))
  ? readFileSync(join(KIT, "VERSION"), "utf8").trim()
  : "0.0.0";

const context = existsSync(join(PROJECT, "context.md"))
  ? readFileSync(join(PROJECT, "context.md"), "utf8")
  : "";

const projectName = config.project?.name ?? "project";

// ── Which agents / skills to include ──────────────────────────────────────────
const projAgentsDir = join(PROJECT, "agents");
const projAgentNames = existsSync(projAgentsDir)
  ? readdirSync(projAgentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  : [];
const projSkillsDir = join(PROJECT, "skills");
const projSkillNames = existsSync(projSkillsDir)
  ? readdirSync(projSkillsDir).filter((d) => existsSync(join(projSkillsDir, d, "SKILL.md")))
  : [];

const allAgentFiles = readdirSync(join(KIT, "agents")).filter((f) => f.endsWith(".md"));
const roster = config.roster; // array of file basenames without .md, or undefined = all
const agentFiles = roster
  ? allAgentFiles.filter((f) => roster.includes(f.replace(/\.md$/, "")))
  : allAgentFiles;
// A roster entry that matches neither the kit nor a project-local agent is silently dropped
// below — that reads as "the agent doesn't exist" when it's usually a typo. Warn instead.
if (roster) {
  const known = new Set([...allAgentFiles.map((f) => f.replace(/\.md$/, "")), ...projAgentNames]);
  for (const r of roster) {
    if (!known.has(r)) console.warn(`  ⚠ config.roster: "${r}" matches no agent — typo?`);
  }
}

const allSkills = readdirSync(join(KIT, "skills")).filter((d) =>
  existsSync(join(KIT, "skills", d, "SKILL.md"))
);
// Filter to real kit skills, exactly like agentFiles above — otherwise a typo'd config.skills
// entry gets passed straight into the readFileSync below and crashes with a raw ENOENT
// instead of being caught by the warning right next to it.
const skills = config.skills ? allSkills.filter((s) => config.skills.includes(s)) : allSkills;
if (config.skills) {
  const known = new Set([...allSkills, ...projSkillNames]);
  for (const s of config.skills) {
    if (!known.has(s)) console.warn(`  ⚠ config.skills: "${s}" matches no skill — typo?`);
  }
}

// ── Template substitution ──────────────────────────────────────────────────────
// Paths the generated agents/skills reference, expressed relative to OUT (where .claude/ and
// CLAUDE.md live — i.e. where the coding tool runs). This keeps every board/script reference
// correct regardless of layout: `board` when generated files sit beside the board, or
// `maestro/board` when they're rendered up to the repo root.
const posix = (p) => p.split("\\").join("/");
const boardRel = posix(relative(OUT, join(PROJECT, "board"))) || "board";
const kitRel = posix(relative(OUT, KIT)) || ".";

const TEMPLATE_VALUES = {
  PROJECT_NAME: projectName,
  KIT_VERSION: kitVersion,
  BOARD: boardRel,
  KIT: kitRel,
};

// Generic {{KEY}} substitution with optional `| filter` (title/upper/lower), rather than one
// hardcoded .replaceAll per placeholder — new placeholders (project-level or per-call `extra`
// values) need no new line here. A key with no match — including anything not in
// TEMPLATE_VALUES — passes through literally as `{{KEY}}`, exactly like the old hardcoded
// version left every placeholder it didn't know about untouched.
function substitute(text, extra) {
  const values = extra ? { ...TEMPLATE_VALUES, ...extra } : TEMPLATE_VALUES;
  return text.replace(/\{\{\s*([A-Z0-9_]+)(?:\s*\|\s*([a-z]+))?\s*\}\}/g, (whole, key, filter) => {
    if (!(key in values)) return whole;
    let val = String(values[key]);
    if (filter === "title") val = val.charAt(0).toUpperCase() + val.slice(1);
    if (filter === "upper") val = val.toUpperCase();
    if (filter === "lower") val = val.toLowerCase();
    return val;
  });
}

// ── Build the generated file set (path -> content) ──────────────────────────────
const generated = new Map();

for (const f of agentFiles) {
  const src = readFileSync(join(KIT, "agents", f), "utf8");
  generated.set(join(".claude", "agents", f), substitute(src));
}
for (const s of skills) {
  const src = readFileSync(join(KIT, "skills", s, "SKILL.md"), "utf8");
  generated.set(join(".claude", "skills", s, "SKILL.md"), substitute(src));
}

// ── Project overlay: the project's own agents/skills win over the kit's ─────────
// A project can keep custom or customised agents in `<project>/agents/*.md` and skills in
// `<project>/skills/<name>/SKILL.md`. These are merged in (overriding a kit file of the same
// name) so a team keeps everything in one place — and, unlike hand-editing `.claude/`, they
// survive the next render.
if (existsSync(projAgentsDir)) {
  for (const f of readdirSync(projAgentsDir).filter((f) => f.endsWith(".md"))) {
    generated.set(join(".claude", "agents", f), substitute(readFileSync(join(projAgentsDir, f), "utf8")));
  }
}
if (existsSync(projSkillsDir)) {
  for (const s of projSkillNames) {
    generated.set(join(".claude", "skills", s, "SKILL.md"), substitute(readFileSync(join(projSkillsDir, s, "SKILL.md"), "utf8")));
  }
}

// The model policy, baked in so the orchestrator can apply per-area floors without reading config.
const floors = config.model?.floors ?? {};
const floorLines = Object.keys(floors).length
  ? Object.entries(floors).map(([area, m]) => `\`${area}\` → \`${m}\``).join(", ")
  : "_(none)_";

// Project CLAUDE.md = a short header + model policy + the project context, so every agent reads it.
const claudeMd = `# ${projectName} — AI Maestro-managed project

> Generated by AI Maestro v${kitVersion}. Do not hand-edit the generated \`.claude/\` files —
> change \`config.json\` / \`context.md\` and re-run \`sync.mjs\`.

This project is run board-first. Work lives in \`${boardRel}/data.json\`; each ticket declares its
\`agent_plan\` and \`model\`. See the AI Maestro method and the generated agents/skills under
\`.claude/\`.

## Model policy

- **Default model:** \`${config.model?.default ?? "sonnet"}\`
- **Area floors:** ${floorLines}

Run each ticket on the **stronger** of its \`model\` and its area's floor. A ticket's plan always
ends with the terminal gates \`qa → merge\` (add \`pd\` for \`multi-agent\` or human-gated tickets),
even if \`agent_plan\` omits them.

## Project context

${context.trim() || "_(fill in context.md)_"}
`;
generated.set("CLAUDE.md", claudeMd);

// AGENTS.md: the same brief, for tools that look for that filename by convention instead of
// (or alongside) CLAUDE.md — e.g. Codex. Content mirrors CLAUDE.md; only the framing differs.
const agentsMd = `# ${projectName} — agent brief

> Generated by AI Maestro v${kitVersion} from \`config.json\` / \`context.md\`. Do not hand-edit —
> re-run \`sync.mjs\` after changing either. (Also see \`CLAUDE.md\`, generated from the same
> source for Claude Code specifically.)

This project is run board-first. Work lives in \`${boardRel}/data.json\`; each ticket declares its
\`agent_plan\` and \`model\`. Agents and skills are generated under \`.claude/\`.

## Model policy

- **Default model:** \`${config.model?.default ?? "sonnet"}\`
- **Area floors:** ${floorLines}

Run each ticket on the **stronger** of its \`model\` and its area's floor. A ticket's plan always
ends with the terminal gates \`qa → merge\` (add \`pd\` for \`multi-agent\` or human-gated tickets),
even if \`agent_plan\` omits them.

## Project context

${context.trim() || "_(fill in context.md)_"}
`;
generated.set("AGENTS.md", agentsMd);

// ── Multi-target rendering: Codex agent files ────────────────────────────────────
// Opt-in via config.targets.codex — most projects only run Claude Code, and a second agent
// file per agent (in a format Claude Code itself never reads) is pure noise until asked for.
// Frontmatter values come straight from the .claude/agents/*.md source already generated
// above, so this never drifts from it independently.
if (config.targets?.codex) {
  function frontmatterValue(md, key) {
    const block = md.match(/^---\n([\s\S]*?)\n---/);
    if (!block) return "";
    const m = block[1].match(new RegExp(`^${key}:\\s*"?(.*?)"?$`, "m"));
    return m ? m[1] : "";
  }
  function bodyAfterFrontmatter(md) {
    const m = md.match(/^---[\s\S]*?---\n([\s\S]*)$/);
    return (m ? m[1] : md).trim();
  }
  const codexAgentPaths = [...generated.keys()].filter((k) => k.startsWith(join(".claude", "agents") + "/"));
  for (const rel of codexAgentPaths) {
    const name = rel.slice((join(".claude", "agents") + "/").length).replace(/\.md$/, "");
    const md = generated.get(rel);
    const description = frontmatterValue(md, "description").replace(/"/g, '\\"');
    const body = bodyAfterFrontmatter(md).replace(/"""/g, '\\"\\"\\"');
    generated.set(join(".codex", "agents", `${name}.toml`), `# ${name} — Codex agent
# Generated by AI Maestro v${kitVersion} from .claude/agents/${name}.md — do not edit directly.
# To disable, remove targets.codex from config.json and re-run sync.

[agent]
name        = "${name}"
description = "${description}"
model       = "inherit"

[prompt]
content = """
${body}
"""
`);
  }
}

// ── Multi-target rendering: the orchestrate Workflow script ──────────────────────
// Opt-in via config.targets.workflow — generates .claude/workflows/orchestrate.js from
// workflows/orchestrate.wrapper.js.tmpl with the shared core (workflows/orchestrator-core.js)
// embedded, and the project's constants injected. Off by default: the orchestrator skill
// covers the model-driven flow; the Workflow script is for teams that want the harness's
// deterministic control flow (fix loops, gate enforcement, run records) instead.
if (config.targets?.workflow) {
  const orch = config.orchestrator ?? {};
  const areas = config.project?.areas ?? [];

  // area → repo dir. Single-repo projects (the default) run everything at the repo root;
  // a multi-repo workspace overrides per area via config.orchestrator.repoPath.
  const repoPath = {};
  for (const [area, p] of Object.entries(orch.repoPath ?? {})) repoPath[area] = resolve(OUT, p);

  // area → test command; missing areas fall back to the core's placeholder (which the qa/pd
  // gates treat as "no real verification configured" and block on).
  const testCmd = orch.testCmd ?? {};

  // Roster codes + roles. qa and principal-delivery review; every other rostered agent
  // writes. The orchestrator itself is the harness, not a stage.
  const READERS = new Set(["qa", "pd"]);
  const agentsMap = {};
  for (const f of agentFiles) {
    const name = f.replace(/\.md$/, "");
    if (name === "orchestrator") continue;
    const code = agentFileToCode(name);
    agentsMap[code] = { type: name, role: READERS.has(code) ? "reader" : "writer" };
  }

  // area → default implementer agent type (used only when a ticket has no agent_plan).
  const DEFAULT_AREA_AGENTS = {
    backend: "backend-developer", frontend: "frontend-developer",
    infra: "devops", docs: "technical-writer", pipeline: "pipeline-developer",
  };
  const agentType = {};
  for (const area of areas) {
    const wanted = orch.areaAgents?.[area] ?? DEFAULT_AREA_AGENTS[area] ?? "principal-engineer";
    // Only route to agents actually on the roster; anything else falls back to pe.
    agentType[area] = Object.values(agentsMap).some((a) => a.type === wanted) ? wanted : "principal-engineer";
  }

  // Fix-agent routing hints ({ code: regexString }), filtered to rostered writer codes.
  const DEFAULT_HINTS = {
    frontend: "\\.(tsx|jsx|css|scss|html|vue|svelte)$",
    backend: "\\.(py|go|rb|rs|java|php)$|\\bapi\\b|server/",
    devops: "Dockerfile|\\.tf$|\\.ya?ml$|infra/",
    pipeline: "pipeline|etl|\\bdag\\b",
  };
  const fixHints = {};
  for (const [code, pattern] of Object.entries({ ...DEFAULT_HINTS, ...(orch.fixAgentHints ?? {}) })) {
    if (agentsMap[code]?.role === "writer" && pattern) fixHints[code] = pattern;
  }

  const wrapper = readFileSync(join(KIT, "workflows", "orchestrate.wrapper.js.tmpl"), "utf8");
  const core = readFileSync(join(KIT, "workflows", "orchestrator-core.js"), "utf8");
  const boardData = join(PROJECT, "board", "data.json");
  generated.set(join(".claude", "workflows", "orchestrate.js"), substitute(wrapper, {
    ORCHESTRATOR_CORE: core,
    PROJECT_ROOT_JSON: JSON.stringify(OUT),
    BOARD_ABS_JSON: JSON.stringify(boardData),
    ARCHIVE_ABS_JSON: JSON.stringify(join(PROJECT, "board", "archive.json")),
    WORKTREES_JSON: JSON.stringify(join(OUT, ".maestro", "worktrees")),
    RUNS_JSON: JSON.stringify(join(OUT, ".maestro", "run")),
    VALIDATE_CMD_JSON: JSON.stringify(`node ${join(KIT, "scripts", "validate-board.mjs")} ${boardData}`),
    MERGE_STRATEGY_JSON: JSON.stringify(orch.mergeStrategy === "pr" ? "pr" : "local-push"),
    PUBLISH_BOARD_JSON: JSON.stringify(orch.publishBoard === true),
    REPO_PATH_JSON: JSON.stringify(repoPath),
    TEST_CMD_JSON: JSON.stringify(testCmd),
    AGENT_TYPE_JSON: JSON.stringify(agentType),
    AGENTS_JSON: JSON.stringify(agentsMap),
    AREA_PLAN_JSON: JSON.stringify(orch.areaPlan ?? {}),
    FIX_AGENT_HINTS_JSON: JSON.stringify(fixHints),
  }));
}

// ── Lock file ────────────────────────────────────────────────────────────────
const lock = {
  kitVersion,
  configHash: sha256(readFileSync(configPath, "utf8")), // cheap "has config.json changed" probe
  generatedAt: null, // intentionally not timestamped (keeps the lock deterministic)
  files: {},
};
for (const [rel, content] of [...generated].sort()) {
  lock.files[rel] = sha256(content);
}
const lockContent = JSON.stringify(lock, null, 2) + "\n";

// ── Check mode: compare, don't write ────────────────────────────────────────────
if (checkMode) {
  let drift = 0;
  for (const [rel, content] of generated) {
    const abs = join(OUT, rel);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
      console.log(`  ✗ drift: ${rel}`);
      drift++;
    }
  }
  const lockPath = join(OUT, ".maestro.lock");
  if (!existsSync(lockPath) || readFileSync(lockPath, "utf8") !== lockContent) {
    console.log("  ✗ drift: .maestro.lock");
    drift++;
  }
  if (drift) {
    console.log(`\n✗ ${drift} file(s) out of date. Run sync.mjs to regenerate.`);
    process.exit(1);
  }
  console.log("✓ Generated files are current.");
  process.exit(0);
}

// ── Write mode ─────────────────────────────────────────────────────────────────
// Prune only files THIS tool generated last time (recorded in the prior lock) and no longer
// generates — so a removed roster entry disappears, but anything else a user placed under
// .claude/ is never touched. This is the safety fix: sync never deletes files it didn't create.
const lockPath = join(OUT, ".maestro.lock");
const priorLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
if (priorLock?.files) {
  for (const rel of Object.keys(priorLock.files)) {
    if (generated.has(rel)) continue;
    const abs = join(OUT, rel);
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
  // Drop now-empty .claude/skills/<name> dirs left behind by a pruned skill.
  const skillsRoot = join(OUT, ".claude", "skills");
  if (existsSync(skillsRoot)) {
    for (const d of readdirSync(skillsRoot)) {
      const abs = join(skillsRoot, d);
      if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
    }
  }
}

// Safety: never overwrite a CLAUDE.md or AGENTS.md we didn't generate (a project may already
// have its own at the repo root). Skip it, warn, and keep it out of the lock so --check stays
// honest.
const NEVER_CLOBBER = new Set(["CLAUDE.md", "AGENTS.md"]);
const skip = new Set();
for (const rel of generated.keys()) {
  if (NEVER_CLOBBER.has(rel) && existsSync(join(OUT, rel)) && !priorLock?.files?.[rel]) skip.add(rel);
}

for (const [rel, content] of generated) {
  if (skip.has(rel)) {
    console.log(`  ⚠ kept your existing ${rel} at ${OUT} (not overwritten). Add your project context to config/context.md and reference it there if you like.`);
    continue;
  }
  const abs = join(OUT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
for (const rel of skip) delete lock.files[rel];
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");

const agentCount = [...generated.keys()].filter((r) => r.includes(join(".claude", "agents"))).length;
const skillCount = [...generated.keys()].filter((r) => r.endsWith("SKILL.md")).length;
const codexCount = [...generated.keys()].filter((r) => r.startsWith(join(".codex", "agents"))).length;
const hasWorkflow = generated.has(join(".claude", "workflows", "orchestrate.js"));
console.log(
  `✓ Rendered ${projectName} (kit v${kitVersion}): ` +
    `${agentCount} agents, ${skillCount} skills, CLAUDE.md, AGENTS.md${codexCount ? `, ${codexCount} Codex agent(s)` : ""}${hasWorkflow ? ", orchestrate workflow" : ""}, .maestro.lock`
);
