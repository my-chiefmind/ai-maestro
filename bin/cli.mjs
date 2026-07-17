#!/usr/bin/env node
/**
 * maestro — the one command a newcomer runs.
 *
 *   maestro init [--dir <repo>] [--name <name>] [--areas a,b,c] [--starter orchestrated|lightweight] [--yes]
 *   maestro sync [...]        (thin passthrough to render/sync.mjs)
 *   maestro validate [...]    (thin passthrough to scripts/validate-board.mjs)
 *
 * `init` is interactive: it asks a few questions, copies a starter into <repo>/maestro/,
 * writes config.json for you, renders the agents/skills, validates the board, and prints
 * exactly what to run next. No hand-editing of paths, no memorising flags.
 *
 * No third-party dependencies.
 */

import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync } from "fs";
import { resolve, dirname, join, relative, basename, sep } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createInterface } from "readline";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");
const NODE = process.execPath;

// True when the CLI runs from an npm/npx install rather than a clone of the kit repo. The
// package copy is then ephemeral (npx cache) or shared (global install) — never write into
// it; vendor the kit into the user's repo instead, mirroring the clone layout.
const IS_PACKAGED = KIT_ROOT.split(sep).includes("node_modules") || KIT_ROOT.includes("_npx");

// What `setup` copies into <repo>/maestro/ when installed from npm. Everything the clone
// flow relies on, minus repo-only extras (cockpit ships separately; see the README).
const VENDORED = ["agents", "skills", "render", "scripts", "board", "starters", "docs", "bin", "VERSION", "README.md", "LICENSE"];

function vendorKit(dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of VENDORED) {
    const src = join(KIT_ROOT, entry);
    if (existsSync(src)) cpSync(src, join(dest, entry), { recursive: true });
  }
  // Minimal package.json so `npm run sync` / `npm run validate` work from the folder,
  // matching what the docs tell clone users to run.
  const pkg = {
    name: "maestro",
    private: true,
    type: "module",
    scripts: {
      setup: "node bin/cli.mjs setup",
      sync: "node render/sync.mjs --project .",
      validate: "node scripts/validate-board.mjs board/data.json",
    },
  };
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
const has = (args, name) => args.includes(`--${name}`);

function run(scriptRel, args, root = KIT_ROOT) {
  const r = spawnSync(NODE, [join(root, scriptRel), ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await new Promise((res) => rl.question(`${question}${suffix}: `, res));
  rl.close();
  return answer.trim() || fallback;
}

async function init(args) {
  console.log("\n🎼  AI Maestro — set up a board in your repo\n");

  const yes = has(args, "yes");
  const repoDir = resolve(flag(args, "dir") || process.cwd());
  const defaultName = basename(repoDir);

  const name = flag(args, "name") || (yes ? defaultName : await ask("Project name", defaultName));
  const starter = (flag(args, "starter") || (yes ? "orchestrated" : await ask("Starter — orchestrated or lightweight", "orchestrated"))).toLowerCase();
  const areasRaw = flag(args, "areas") || (yes ? "backend, frontend, infra, docs" : await ask("Areas (comma-separated)", "backend, frontend, infra, docs"));
  const areas = areasRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const starterDir = join(KIT_ROOT, "starters", starter === "lightweight" ? "lightweight-project" : "orchestrated-project");
  if (!existsSync(starterDir)) {
    console.error(`✗ Unknown starter "${starter}". Use "orchestrated" or "lightweight".`);
    process.exit(2);
  }

  const projectDir = join(repoDir, "maestro");
  if (existsSync(join(projectDir, "config.json"))) {
    console.error(`✗ ${projectDir} already has a config.json — refusing to overwrite. Delete it first, or run 'maestro sync' to re-render.`);
    process.exit(2);
  }

  // 1. Copy the capsule into <repo>/maestro/
  mkdirSync(projectDir, { recursive: true });
  cpSync(starterDir, projectDir, { recursive: true });

  // 2. Write config.json (name, areas, kit location) — no hand-editing required.
  const configPath = join(projectDir, "config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  config.project = { ...(config.project || {}), name, areas };
  // From npm there is no stable kit path to point at — leave kitSource pathless so sync
  // resolves the kit from the installed package (`npx @mychiefmind/ai-maestro sync` re-fetches it).
  config.kitSource = IS_PACKAGED
    ? { mode: "npm", package: "@mychiefmind/ai-maestro" }
    : { mode: "sibling", path: relative(projectDir, KIT_ROOT) || "." };
  config.outDir = ".."; // render .claude/ + CLAUDE.md to the repo root (parent of the capsule)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\n✓ Created ${relative(process.cwd(), projectDir) || projectDir}/  (from the ${starter} starter)\n`);

  // 3. Render the agents & skills.
  console.log("→ Rendering agents & skills…");
  if (run("render/sync.mjs", ["--project", projectDir, "--kit", KIT_ROOT]) !== 0) {
    console.error("✗ Render failed. Fix the errors above and run 'maestro sync' again.");
    process.exit(1);
  }

  // 4. Validate the board (best-effort; a fresh board is often empty).
  const boardData = join(projectDir, "board", "data.json");
  if (existsSync(boardData)) {
    console.log("\n→ Validating the board…");
    run("scripts/validate-board.mjs", [boardData, "--agents", join(KIT_ROOT, "agents")]);
  }

  // 5. Tell them exactly what to do next.
  const rel = relative(process.cwd(), projectDir) || ".";
  const boardStep = IS_PACKAGED
    ? `   2. Add work on the board (${rel}/board/data.json).`
    : `   2. Add work on the board (${rel}/board/data.json), or open the visual board:
        cd ${relative(process.cwd(), KIT_ROOT) || "."} && npm run board   (http://localhost:5273)`;
  const syncCmd = IS_PACKAGED
    ? `npx @mychiefmind/ai-maestro sync --project ${rel}`
    : `node ${rel}/render/sync.mjs --project ${rel}`;
  console.log(`
✅ Done. Next steps:

   1. Edit ${rel}/context.md   — tell agents about your stack, tests, and guardrails.
${boardStep}
   3. Agents & skills are in ./.claude/ at your repo root — open this repo in Claude Code and
      ask the "orchestrator" agent to start.

   Re-run '${syncCmd}' after changing config.json or context.md.
`);
}

/**
 * setup — the whole onboarding, in one questionnaire. Two equivalent entry points:
 *
 *   cd ~/code/my-app
 *   npx @mychiefmind/ai-maestro setup                # vendors the kit into ./maestro/, then sets it up
 *
 *   git clone <maestro> maestro
 *   node maestro/bin/cli.mjs setup      # same, on a clone — answer 2 questions, done
 *
 * The cloned kit holds your config.json / context.md / board; the generated agents land in
 * ./.claude/ + ./CLAUDE.md at your REPO ROOT (where the coding tool discovers them). No npm
 * install, no server — the core kit is dependency-free. The cockpit UI is optional.
 * Idempotent: re-running detects an existing config and does nothing.
 */
async function setup(args) {
  // Under npx / an npm install the package copy is ephemeral — vendor the kit into
  // <cwd>/maestro/ first, then set that copy up exactly like the cloned-kit flow.
  let kit = KIT_ROOT;
  if (IS_PACKAGED) {
    kit = join(process.cwd(), "maestro");
    if (!existsSync(join(kit, "config.json"))) {
      console.log(`→ Copying the AI Maestro kit into ${relative(process.cwd(), kit) || kit}/ …`);
      vendorKit(kit);
    }
  }

  const configPath = join(kit, "config.json");
  const kitName = basename(kit);
  if (existsSync(configPath) && !has(args, "force")) {
    console.log(`✓ Already set up. Edit ${kitName}/context.md, then run 'npm run sync' from the ${kitName}/ folder.`);
    return;
  }

  console.log("\n🎼  AI Maestro — two questions and you're set up\n");
  const yes = has(args, "yes");
  // The kit lives at <project>/maestro, so the parent dir names the project.
  const repoRoot = dirname(kit);
  const defaultName = basename(repoRoot);
  const name = flag(args, "name") || (yes ? defaultName : await ask("Project name", defaultName));
  const areasRaw = flag(args, "areas") || (yes ? "backend, frontend, infra, docs" : await ask("Areas (comma-separated)", "backend, frontend, infra, docs"));
  const areas = areasRaw.split(",").map((s) => s.trim()).filter(Boolean);

  // Seed config.json + context.md from the orchestrated starter, then stamp in the answers.
  const starter = join(kit, "starters", "orchestrated-project");
  const config = JSON.parse(readFileSync(join(starter, "config.json"), "utf8"));
  config.project = { name, areas };
  config.kitSource = { mode: "self", path: "." };
  config.outDir = ".."; // render .claude/ + CLAUDE.md to the repo root, where the tool looks
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  if (!existsSync(join(kit, "context.md"))) {
    cpSync(join(starter, "context.md"), join(kit, "context.md"));
  }

  // Render agents & skills to the repo root (config.outDir="..").
  console.log("\n→ Setting up your agents & skills…");
  run("render/sync.mjs", ["--project", kit], kit);

  const boardLine = existsSync(join(kit, "cockpit"))
    ? `   • Optional visual board:  npm run board   (from the ${kitName}/ folder)`
    : `   • Optional visual board:  clone https://github.com/my-chiefmind/ai-maestro and run 'npm run board'`;
  console.log(`
✅ "${name}" is ready — no install, nothing running.

   • Agents & skills:   ./.claude/   (at your repo root — open this repo in Claude Code and
                        ask the "orchestrator" agent to start)
   • Your settings:     ${kitName}/context.md  (describe your stack, tests, guardrails)
                        ${kitName}/board/data.json  (your work board)
   • Re-render after edits:  npm run sync    (from the ${kitName}/ folder)
${boardLine}
`);
}

function help() {
  console.log(`ai-maestro <command>

  setup       Set up AI Maestro in your project — a short questionnaire (start here)
  sync        Re-render .claude/ from config.json + context.md
  validate    Check the board's integrity
  init        Alternative: set up as a small capsule pointing at a kit elsewhere

The usual flow — one command in your repo:

  cd ~/code/my-app
  npx @mychiefmind/ai-maestro setup        # copies the kit into ./maestro/ and sets you up

Or clone the kit yourself (same result, plus the cockpit UI):

  git clone https://github.com/my-chiefmind/ai-maestro.git maestro
  node maestro/bin/cli.mjs setup

Examples:
  npx @mychiefmind/ai-maestro setup
  node maestro/render/sync.mjs --project maestro
  node maestro/scripts/validate-board.mjs maestro/board/data.json
`);
}

switch (cmd) {
  case "setup": await setup(rest); break;
  case "init": await init(rest); break;
  case "sync": process.exit(run("render/sync.mjs", rest)); break;
  case "validate": process.exit(run("scripts/validate-board.mjs", rest)); break;
  case "-h": case "--help": case undefined: help(); break;
  default: console.error(`Unknown command: ${cmd}\n`); help(); process.exit(2);
}
