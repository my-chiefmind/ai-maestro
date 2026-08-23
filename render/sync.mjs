#!/usr/bin/env node
/**
 * sync.mjs — AI Maestro renderer.
 *
 * Generates native Claude Code and Codex agents, skills, and project guidance from the kit
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
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, cpSync,
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
// AI Maestro is dual-runtime by default. Existing projects may explicitly disable either
// renderer, but an ordinary install/update should work in Claude Code and Codex without a
// second opt-in edit followed by another sync.
const claudeEnabled = config.targets?.claude !== false;
const codexEnabled = config.targets?.codex !== false;

// Where generated runtime files and .maestro.lock are written. Defaults to the
// project dir; setups that keep config in a subfolder point this at the repo root (via --out
// or config.outDir) so coding tools discover their native files there.
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

// ── Where a project's OWN agents / skills live ────────────────────────────────
// `<project>/custom/` is the update-safe home: `maestro update` replaces whole kit folders
// (agents/, skills/, render/…) and custom/ is not one of them, so nothing there can be
// caught in the sweep.
//
// `<project>/agents` + `<project>/skills` are the older location, and they are only the
// PROJECT's own when the project and the kit are different directories (the `init` capsule
// flow). Under `setup` the kit is vendored INTO the project — PROJECT === KIT — so those two
// paths ARE the kit's own agents/ and skills/. Reading them as an overlay there re-added
// every kit file unconditionally, which silently defeated config.roster / config.skills
// (a roster of one still rendered all nine agents). Hence the isSelfKit guard. See T-011.
const isSelfKit = PROJECT === KIT;

// `<name>.overlay.md` extends the kit's `<name>.md` rather than replacing it (see below), so
// it is never itself an agent.
const OVERLAY_SUFFIX = ".overlay.md";
const isOverride = (f) => f.endsWith(".md") && !f.endsWith(OVERLAY_SUFFIX);

const mdNames = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter(isOverride).map((f) => f.replace(/\.md$/, "")) : [];
const skillNames = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md"))) : [];

// ── Adopt a team's existing .claude/ instead of overwriting it (T-018) ─────────
// A repo that already used Claude Code has its own agents and skills in .claude/. The renderer
// writes there, so on the FIRST render every one of them whose name the kit also ships was
// overwritten — silently, before any update, with no way back: qa, devops, orchestrator, gc,
// security-review are all names a team plausibly already used.
//
// The guard for this already existed but was scoped to two filenames (CLAUDE.md, AGENTS.md).
// The rule behind it — never overwrite a file we did not generate — applies to everything the
// renderer writes. The prior lock is what distinguishes "ours from last time" from "theirs",
// exactly as it does for CLAUDE.md.
//
// Where a custom/ slot exists (agents, skills) the file is MOVED there: it is then preserved
// AND still what renders, because custom/ overrides the kit file of the same name — so the
// team's setup behaves after the install exactly as it did before. CLAUDE.md and AGENTS.md
// have no custom/ slot (they are generated from config + context, not from a roster), so for
// those the rule is still "keep theirs in place", handled further down.
//
// This runs BEFORE the overlay directories are scanned, so a rescued file is picked up in the
// SAME render. Doing it afterwards would render the kit's version once and only self-correct
// on the next sync — the same bug with an extra step.
const lockPath = join(OUT, ".maestro.lock");
const priorLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
const adopted = [];

function adoptPreexisting() {
  if (checkMode) return; // --check must never write; the drift it reports here is real
  const targets = [
    ...(claudeEnabled ? [{
      kind: "agents",
      from: join(OUT, ".claude", "agents"),
      to: join(PROJECT, "custom", "agents"),
      items: (dir) => (existsSync(dir) ? readdirSync(dir).filter(isOverride) : []),
      rel: (f) => join(".claude", "agents", f),
    }, {
      kind: "skills",
      from: join(OUT, ".claude", "skills"),
      to: join(PROJECT, "custom", "skills"),
      items: (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md"))) : []),
      rel: (d) => join(".claude", "skills", d, "SKILL.md"),
    }] : []),
  ];

  for (const t of targets) {
    for (const item of t.items(t.from)) {
      if (priorLock?.files?.[t.rel(item)]) continue; // we generated this last time — ours to replace
      const src = join(t.from, item);
      const dest = join(t.to, item);
      if (existsSync(dest)) {
        // custom/ already owns this name and already wins, so the .claude/ copy has been having
        // no effect. Say so rather than appearing to lose it.
        adopted.push({ item, kind: t.kind, stale: true });
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      adopted.push({ item, kind: t.kind, stale: false });
    }
  }
}
adoptPreexisting();

// Later entries win, so custom/ overrides the legacy location for the same name.
const agentOverlayDirs = [
  ...(isSelfKit ? [] : [join(PROJECT, "agents")]),
  join(PROJECT, "custom", "agents"),
].filter(existsSync);
const skillOverlayDirs = [
  ...(isSelfKit ? [] : [join(PROJECT, "skills")]),
  join(PROJECT, "custom", "skills"),
].filter(existsSync);

const projAgentNames = [...new Set(agentOverlayDirs.flatMap(mdNames))];
const projSkillNames = [...new Set(skillOverlayDirs.flatMap(skillNames))];

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

// ── The other direction: the kit ships it, this config doesn't name it ─────────
// Both warnings above fire when config names something that doesn't exist. Nothing fired for
// the reverse, and that is the one that loses you things: a project's roster is frozen at
// whatever the starter shipped the day it was set up, so every agent or skill added to the kit
// afterwards is simply absent — not rendered, not mentioned, no error. A project set up before
// `orchestrator` and `project-plan` existed silently never had them.
//
// It stayed invisible for a second reason: until 0.1.27 these filters were a no-op in the
// vendored layout, so the list could drift for months with no effect at all. The moment the
// filter started working, the accumulated drift surfaced as deletions.
//
// Reported, never auto-added: `roster` is also how you deliberately drop an agent you don't
// want, and a renderer that quietly re-adds it makes the list untrustworthy in the other
// direction. `maestro update` offers to adopt them; this only makes the gap visible.
const unlistedAgents = roster
  ? allAgentFiles.map((f) => f.replace(/\.md$/, "")).filter((a) => !roster.includes(a))
  : [];
const unlistedSkills = config.skills ? allSkills.filter((s) => !config.skills.includes(s)) : [];
if (unlistedAgents.length || unlistedSkills.length) {
  const parts = [];
  if (unlistedAgents.length) parts.push(`${unlistedAgents.length} agent(s): ${unlistedAgents.join(", ")}`);
  if (unlistedSkills.length) parts.push(`${unlistedSkills.length} skill(s): ${unlistedSkills.join(", ")}`);
  console.warn(
    `  ⚠ the kit ships ${parts.join("; ")} that config.json doesn't list, so they aren't rendered.\n` +
    `    Add them to "roster"/"skills", or run \`maestro update --adopt-new\` to add them for you.`
  );
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
// A project keeps its own agents in `<project>/custom/agents/*.md` and skills in
// `<project>/custom/skills/<name>/SKILL.md`. These are merged in (overriding a kit file of
// the same name) so a team keeps everything in one place — and, unlike hand-editing
// `.claude/`, they survive both the next render and the next `maestro update`.
//
// A project overlay is deliberately NOT filtered by config.roster / config.skills: naming
// your own agent in the roster as well would be a second place to keep the same fact in
// step. Kit files are opt-in; your own are opt-out by deleting them.
// A project file that shares a name with one the kit ships REPLACES it — that is how you fork
// a kit agent, and the rescue paths in `update`/adoptPreexisting depend on it. But it is a very
// different act from adding an agent of your own, and reporting the two as one number hid the
// only case that needs attention: from "3 overridden (legacy, mine, qa)" you cannot tell that
// just one of them silently cut this project off from kit updates.
const added = { agents: [], skills: [] };
const replaced = { agents: [], skills: [] };
const kitAgentNames = new Set(allAgentFiles.map((f) => f.replace(/\.md$/, "")));
const kitSkillNames = new Set(allSkills);

const claimed = (kind, name) =>
  (kind === "agents" ? kitAgentNames : kitSkillNames).has(name) ? replaced[kind] : added[kind];

for (const dir of agentOverlayDirs) {
  for (const f of readdirSync(dir).filter(isOverride)) {
    generated.set(join(".claude", "agents", f), substitute(readFileSync(join(dir, f), "utf8")));
    claimed("agents", f.replace(/\.md$/, "")).push(f.replace(/\.md$/, ""));
  }
}
for (const dir of skillOverlayDirs) {
  for (const s of skillNames(dir)) {
    generated.set(join(".claude", "skills", s, "SKILL.md"), substitute(readFileSync(join(dir, s, "SKILL.md"), "utf8")));
    claimed("skills", s).push(s);
  }
}

// One name may only be customised one way, so `overridden` still means "there is a full
// override for this name" for the overlay conflict check below.
const overridden = {
  agents: [...added.agents, ...replaced.agents],
  skills: [...added.skills, ...replaced.skills],
};

// ── Extend, rather than replace ────────────────────────────────────────────────
// Copying a whole kit agent to change three lines of it means the copy stops receiving every
// later improvement, and the divergence only grows — the umbrella this kit was extracted from
// ended up 133-182 diff lines per agent that way. So a project can APPEND to a kit file
// instead: `custom/agents/<name>.overlay.md` and `custom/skills/<name>/OVERLAY.md` are added
// under a `## Project overlay` heading, and the kit's half keeps updating underneath.
//
// Overriding and extending the same name is contradictory, not a precedence puzzle — it is an
// error rather than a silent winner.
const extended = { agents: [], skills: [] };
const overlayErrors = [];

function applyOverlay(kind, name, generatedPath, overlaySrc) {
  if (overridden[kind].includes(name)) {
    overlayErrors.push(
      `${kind}: "${name}" has BOTH a full override and an ${kind === "agents" ? OVERLAY_SUFFIX : "OVERLAY.md"} — ` +
        `pick one (an override already contains whatever you want it to say).`
    );
    return;
  }
  if (!generated.has(generatedPath)) {
    // The overlay names something this project doesn't render — usually a roster omission or
    // a typo. Silently dropping it would look like the extension simply had no effect.
    console.warn(
      `  ⚠ ${kind}: overlay for "${name}" has nothing to extend — ` +
        `the kit ${kind === "agents" ? "agent" : "skill"} isn't rendered here (check config.${kind === "agents" ? "roster" : "skills"}).`
    );
    return;
  }
  const base = generated.get(generatedPath);
  generated.set(generatedPath, `${base.trimEnd()}\n\n## Project overlay\n\n${substitute(overlaySrc).trim()}\n`);
  extended[kind].push(name);
}

for (const dir of agentOverlayDirs) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(OVERLAY_SUFFIX))) {
    const name = f.slice(0, -OVERLAY_SUFFIX.length);
    applyOverlay("agents", name, join(".claude", "agents", `${name}.md`), readFileSync(join(dir, f), "utf8"));
  }
}
for (const dir of skillOverlayDirs) {
  if (!existsSync(dir)) continue;
  for (const s of readdirSync(dir).filter((d) => existsSync(join(dir, d, "OVERLAY.md")))) {
    applyOverlay("skills", s, join(".claude", "skills", s, "SKILL.md"), readFileSync(join(dir, s, "OVERLAY.md"), "utf8"));
  }
}

if (overlayErrors.length) {
  for (const e of overlayErrors) console.error(`  ✗ ${e}`);
  process.exit(2);
}

/**
 * Say what this project has changed about the kit's roster. Worth printing on every run: an
 * override is invisible in the generated output (it looks like a kit agent) and is the thing
 * most likely to be quietly holding back an upstream improvement.
 */
function reportCustomisations() {
  // What was moved out of .claude/ on this run, before anything else — it is a change to the
  // project's own files, so it must not be buried under the customisation summary.
  if (adopted.length) {
    const moved = adopted.filter((a) => !a.stale);
    const stale = adopted.filter((a) => a.stale);
    if (moved.length) {
      console.log(
        `  ↪ adopted ${moved.length} file(s) that were already in .claude/ — moved into ` +
          `${posix(relative(OUT, join(PROJECT, "custom")))}/ so this render could not overwrite them:`
      );
      for (const a of moved) console.log(`     .claude/${a.kind}/${a.item}  →  custom/${a.kind}/${a.item}`);
    }
    for (const a of stale) {
      console.log(`  ⚠ .claude/${a.kind}/${a.item} was a stale copy — custom/${a.kind}/${a.item} already replaces it, and is what renders.`);
    }
  }

  const line = (label, kind) => {
    const a = added[kind], r = replaced[kind], e = extended[kind];
    if (!a.length && !r.length && !e.length) return null;
    const parts = [];
    if (a.length) parts.push(`${a.length} added (${a.join(", ")})`);
    if (r.length) parts.push(`${r.length} replacing a kit ${label.replace(/s$/, "")} (${r.join(", ")})`);
    if (e.length) parts.push(`${e.length} extended (${e.join(", ")})`);
    return `  · ${label}: ${parts.join("; ")}`;
  };
  const lines = [line("agents", "agents"), line("skills", "skills")].filter(Boolean);
  if (lines.length) console.log(["  your customisations:", ...lines].join("\n"));

  // The consequence of a replacement, stated once, with the cheaper alternative. Adding your
  // own agent costs nothing; replacing a kit one silently opts this project out of every future
  // improvement to it, and people reach for it when all they wanted was to add a rule.
  for (const kind of ["agents", "skills"]) {
    for (const name of replaced[kind]) {
      const alt = kind === "agents" ? `${name}.overlay.md` : `${name}/OVERLAY.md`;
      console.log(
        `  ⚠ your ${kind.replace(/s$/, "")} "${name}" replaces the kit's — kit updates to it will ` +
          `not reach this project. If you only meant to add rules, use custom/${kind}/${alt} instead.`
      );
    }
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
const agentsRuntimeDescription = codexEnabled
  ? "Codex skills are under `.agents/skills/`, and project-scoped subagents are under `.codex/agents/`."
  : "Runtime agents and skills are generated under `.claude/`.";
const codexEffortPolicy = codexEnabled
  ? `
In Codex, the portable workload tiers map to reasoning effort: \`haiku\` → low, \`sonnet\` →
medium, and \`opus\` → high. Keep the current Codex model unless the caller explicitly selects
another model.
`
  : "";
const claudeCrossReference = claudeEnabled
  ? " (Also see `CLAUDE.md`, generated from the same source for Claude Code specifically.)"
  : "";
const agentsMd = `# ${projectName} — agent brief

> Generated by AI Maestro v${kitVersion} from \`config.json\` / \`context.md\`. Do not hand-edit —
> re-run \`sync.mjs\` after changing either.${claudeCrossReference}

This project is run board-first. Work lives in \`${boardRel}/data.json\`; each ticket declares its
\`agent_plan\` and \`model\`. ${agentsRuntimeDescription}

## Model policy

- **Default model:** \`${config.model?.default ?? "sonnet"}\`
- **Area floors:** ${floorLines}

Run each ticket on the **stronger** of its \`model\` and its area's floor. A ticket's plan always
ends with the terminal gates \`qa → merge\` (add \`pd\` for \`multi-agent\` or human-gated tickets),
even if \`agent_plan\` omits them.

${codexEffortPolicy}

## Project context

${context.trim() || "_(fill in context.md)_"}
`;
generated.set("AGENTS.md", agentsMd);

// ── Multi-target rendering: native Codex skills + custom agents ──────────────────
// Codex discovers repo skills in .agents/skills and project-scoped custom subagents in
// .codex/agents. Both are derived from the same fully-overlaid content already rendered for
// Claude, so the two targets cannot drift independently.
if (codexEnabled) {
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
  const codexSkillPaths = [...generated.keys()].filter((k) =>
    k.startsWith(join(".claude", "skills") + "/") && k.endsWith("SKILL.md")
  );
  for (const rel of codexSkillPaths) {
    const suffix = rel.slice((join(".claude", "skills") + "/").length);
    generated.set(join(".agents", "skills", suffix), generated.get(rel));
  }

  const codexAgentPaths = [...generated.keys()].filter((k) => k.startsWith(join(".claude", "agents") + "/"));
  for (const rel of codexAgentPaths) {
    const name = rel.slice((join(".claude", "agents") + "/").length).replace(/\.md$/, "");
    const md = generated.get(rel);
    const description = frontmatterValue(md, "description");
    const body = bodyAfterFrontmatter(md);
    generated.set(join(".codex", "agents", `${name}.toml`), `# ${name} — Codex agent
# Generated by AI Maestro v${kitVersion} from agents/${name}.md — do not edit directly.
# To disable Codex output, set targets.codex to false in config.json and re-run sync.

name = ${JSON.stringify(name)}
description = ${JSON.stringify(description)}
developer_instructions = ${JSON.stringify(body)}
`);
  }
}

// The .claude representation is also our internal canonical render used to build the Codex
// target above. A Codex-only project can suppress those final files without duplicating the
// overlay/substitution pipeline.
if (!claudeEnabled) {
  for (const rel of [...generated.keys()]) {
    if (rel === "CLAUDE.md" || rel.startsWith(join(".claude") + "/")) generated.delete(rel);
  }
}

// ── Multi-target rendering: the orchestrate Workflow script ──────────────────────
// Opt-in via config.targets.workflow — generates .claude/workflows/orchestrate.js from
// workflows/orchestrate.wrapper.js.tmpl with the shared core (workflows/orchestrator-core.js)
// embedded, and the project's constants injected. Off by default: the orchestrator skill
// covers the model-driven flow; the Workflow script is for teams that want the harness's
// deterministic control flow (fix loops, gate enforcement, run records) instead.
if (config.targets?.workflow && claudeEnabled) {
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
    TICKET_CMD_JSON: JSON.stringify(`node ${join(KIT, "scripts", "board-write.mjs")}`),
    PLAN_CMD_JSON: JSON.stringify(`node ${join(KIT, "scripts", "plan-write.mjs")}`),
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

// ── What we may not overwrite ─────────────────────────────────────────────────
// Never clobber a CLAUDE.md or AGENTS.md we didn't generate (a project may already have its
// own at the repo root). Decided HERE, before the lock is built, because both modes need the
// same answer: write mode skips these files, and check mode must not then report them — or
// their absence from the lock — as drift. Deciding it inside write mode only meant `--check`
// failed forever in exactly the projects the rule exists to protect.
// CLAUDE.md and AGENTS.md are the two generated files with no custom/ slot to be adopted into
// — they come from config + context, not from a roster — so for them the rule stays "keep the
// project's own in place". Everything else the renderer writes is handled by adoptPreexisting().
const NEVER_CLOBBER = new Set(["CLAUDE.md", "AGENTS.md"]);
const skip = new Set();
for (const rel of generated.keys()) {
  // Claude files are adopted into custom/ above. Codex-native files have no lossless universal
  // custom/ representation, so preserve an unmanaged file in place instead of overwriting it.
  const unmanagedCodex = rel.startsWith(join(".agents") + "/") || rel.startsWith(join(".codex") + "/");
  if ((NEVER_CLOBBER.has(rel) || unmanagedCodex) && existsSync(join(OUT, rel)) && !priorLock?.files?.[rel]) {
    skip.add(rel);
  }
}

// ── Lock file ────────────────────────────────────────────────────────────────
const lock = {
  kitVersion,
  configHash: sha256(readFileSync(configPath, "utf8")), // cheap "has config.json changed" probe
  generatedAt: null, // intentionally not timestamped (keeps the lock deterministic)
  files: {},
};
for (const [rel, content] of [...generated].sort()) {
  if (skip.has(rel)) continue;
  lock.files[rel] = sha256(content);
}
const lockContent = JSON.stringify(lock, null, 2) + "\n";

// ── Check mode: compare, don't write ────────────────────────────────────────────
if (checkMode) {
  let drift = 0;
  for (const [rel, content] of generated) {
    if (skip.has(rel)) continue; // the project's own file, deliberately not ours to match
    const abs = join(OUT, rel);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
      console.log(`  ✗ drift: ${rel}`);
      drift++;
    }
  }
  // `lockPath` is the one resolved above, for the prior lock — not re-declared here.
  if (!existsSync(lockPath) || readFileSync(lockPath, "utf8") !== lockContent) {
    console.log("  ✗ drift: .maestro.lock");
    drift++;
  }
  // Reported before the verdict, either way: an override is the most likely reason a generated
  // file doesn't match, so suppressing it on the drift path withheld the explanation exactly
  // when someone was looking for one.
  reportCustomisations();
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
// generated runtime folders are never touched. This is the safety fix: sync never deletes files it didn't create.
if (priorLock?.files) {
  for (const rel of Object.keys(priorLock.files)) {
    if (generated.has(rel)) continue;
    const abs = join(OUT, rel);
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
  // Drop now-empty target skill dirs left behind by a pruned skill.
  for (const skillsRoot of [join(OUT, ".claude", "skills"), join(OUT, ".agents", "skills")]) {
    if (existsSync(skillsRoot)) {
      for (const d of readdirSync(skillsRoot)) {
        const abs = join(skillsRoot, d);
        if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
      }
    }
  }
}

for (const [rel, content] of generated) {
  if (skip.has(rel)) {
    const codexFile = rel.startsWith(join(".agents") + "/") || rel.startsWith(join(".codex") + "/");
    console.log(
      `  ⚠ kept your existing ${rel} at ${OUT} (not overwritten). ` +
      (codexFile
        ? "It remains user-managed; rename or remove it if you want Maestro to own this target path."
        : "Add your project context to config/context.md and reference it there if you like.")
    );
    continue;
  }
  const abs = join(OUT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
// `skip` was already applied when lock.files was built, so what check mode compares against
// and what write mode records are the same bytes by construction.
writeFileSync(lockPath, lockContent);

const agentCount = [...generated.keys()].filter((r) => r.includes(join(".claude", "agents"))).length;
const skillCount = [...generated.keys()].filter((r) => r.startsWith(join(".claude", "skills")) && r.endsWith("SKILL.md")).length;
const codexCount = [...generated.keys()].filter((r) => r.startsWith(join(".codex", "agents"))).length;
const codexSkillCount = [...generated.keys()].filter((r) => r.startsWith(join(".agents", "skills")) && r.endsWith("SKILL.md")).length;
const hasWorkflow = generated.has(join(".claude", "workflows", "orchestrate.js"));
console.log(
  `✓ Rendered ${projectName} (kit v${kitVersion}): ` +
    `${agentCount} Claude agent(s), ${skillCount} Claude skill(s), AGENTS.md` +
    `${claudeEnabled ? ", CLAUDE.md" : ""}` +
    `${codexCount ? `, ${codexCount} Codex agent(s), ${codexSkillCount} Codex skill(s)` : ""}` +
    `${hasWorkflow ? ", orchestrate workflow" : ""}, .maestro.lock`
);
reportCustomisations();
