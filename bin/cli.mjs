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
import { resolve, dirname, join, relative, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createInterface } from "readline";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");
const NODE = process.execPath;

const [cmd, ...rest] = process.argv.slice(2);

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
const has = (args, name) => args.includes(`--${name}`);

function run(scriptRel, args) {
  const r = spawnSync(NODE, [join(KIT_ROOT, scriptRel), ...args], { stdio: "inherit" });
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
  console.log("\n🎼  Maestro — set up a board in your repo\n");

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
  config.kitSource = { mode: "sibling", path: relative(projectDir, KIT_ROOT) || "." };
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
  console.log(`
✅ Done. Next steps:

   1. Edit ${rel}/context.md   — tell agents about your stack, tests, and guardrails.
   2. Add work on the board:
        • Visual:  cd ${relative(process.cwd(), KIT_ROOT) || "."} && npm run board   (opens http://localhost:5273)
        • Or edit  ${rel}/board/data.json  directly.
   3. From your coding tool in this repo, invoke the "orchestrator" agent to run the next ticket.

   Re-run 'maestro sync' whenever you change config.json or context.md.
`);
}

/**
 * setup — configure the kit *in place*, for the "clone into your project" workflow:
 *
 *   cd ~/code/my-app
 *   git clone <maestro> maestro && cd maestro
 *   make board            # runs this, then opens the console
 *
 * The cloned kit IS the workspace: config.json + context.md are written at the kit root and
 * the board lives in ./board. Idempotent — on later runs it detects an existing config and
 * does nothing, so `make board` just launches.
 */
async function setup(args) {
  const configPath = join(KIT_ROOT, "config.json");
  if (existsSync(configPath) && !has(args, "force")) {
    return; // already configured — `make board` proceeds straight to launch
  }

  console.log("\n🎼  Maestro — let's set up your board\n");
  const yes = has(args, "yes");
  // The kit is usually cloned as <project>/maestro, so the parent dir is the project name.
  const defaultName = basename(dirname(KIT_ROOT));
  const name = flag(args, "name") || (yes ? defaultName : await ask("Project name", defaultName));
  const areasRaw = flag(args, "areas") || (yes ? "backend, frontend, infra, docs" : await ask("Areas (comma-separated)", "backend, frontend, infra, docs"));
  const areas = areasRaw.split(",").map((s) => s.trim()).filter(Boolean);

  // Seed config.json + context.md from the orchestrated starter, then stamp in the answers.
  const starter = join(KIT_ROOT, "starters", "orchestrated-project");
  const config = JSON.parse(readFileSync(join(starter, "config.json"), "utf8"));
  config.project = { name, areas };
  config.kitSource = { mode: "self", path: "." };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  if (!existsSync(join(KIT_ROOT, "context.md"))) {
    cpSync(join(starter, "context.md"), join(KIT_ROOT, "context.md"));
  }

  // Render agents & skills in place (writes .claude/ + CLAUDE.md at the kit root).
  console.log("\n→ Rendering agents & skills…");
  run("render/sync.mjs", ["--project", KIT_ROOT, "--kit", KIT_ROOT]);

  console.log(`
✅ Set up "${name}". Opening the board…

   • Edit context.md to tell agents about your stack, tests, and guardrails.
   • Re-run 'make sync' after changing config.json or context.md.
`);
}

function help() {
  console.log(`maestro <command>

  setup       Configure the kit in place (for the clone-into-your-project flow)
  init        Set up Maestro as a sub-capsule in a separate repo (interactive)
  sync        Render .claude/ from config.json + context.md
  validate    Check a board's integrity

Most people just run 'make board' (which calls setup, then opens the console).

Examples:
  make board
  maestro init --dir ~/code/my-app --name my-app --areas backend,frontend --yes
  maestro sync --project .
  maestro validate board/data.json
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
