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

// Minimal ANSI colorizer — respects NO_COLOR and non-TTY output (colors are stripped when
// the output isn't an interactive terminal, so piped/CI logs stay clean).
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  b: sgr("1"), dim: sgr("2"),
  indigo: sgr("38;5;99"), pink: sgr("38;5;211"), green: sgr("38;5;42"),
  cyan: sgr("38;5;44"), yellow: sgr("38;5;220"),
};

// True when the CLI runs from an npm/npx install rather than a clone of the kit repo. The
// package copy is then ephemeral (npx cache) or shared (global install) — never write into
// it; vendor the kit into the user's repo instead, mirroring the clone layout.
const IS_PACKAGED = KIT_ROOT.split(sep).includes("node_modules") || KIT_ROOT.includes("_npx");

// What `setup` copies into <repo>/maestro/ when installed from npm. Everything the clone
// flow relies on, including the optional cockpit UI so `npm run board` works out of the box.
const VENDORED = ["agents", "skills", "render", "scripts", "board", "cockpit", "starters", "docs", "bin", "VERSION", "README.md", "LICENSE"];

// Never carry these into the user's repo — they're rebuildable and heavy. The cockpit's deps
// install on first `npm run board` (see the `preboard` script below).
const VENDOR_SKIP = new Set(["node_modules", "dist", ".backups", ".git"]);

function vendorKit(dest) {
  mkdirSync(dest, { recursive: true });
  const filter = (src) => !VENDOR_SKIP.has(basename(src));
  for (const entry of VENDORED) {
    const src = join(KIT_ROOT, entry);
    if (existsSync(src)) cpSync(src, join(dest, entry), { recursive: true, filter });
  }
  // Minimal package.json so `npm run sync` / `npm run validate` / `npm run board` work from
  // the folder, matching what the docs tell clone users to run. `preboard` installs the
  // cockpit's deps on demand so the first `npm run board` just works.
  const pkg = {
    name: "maestro",
    private: true,
    type: "module",
    scripts: {
      setup: "node bin/cli.mjs setup",
      sync: "node render/sync.mjs --project .",
      validate: "node scripts/validate-board.mjs board/data.json",
      preboard: "node -e \"require('fs').existsSync('cockpit/node_modules')||require('child_process').execSync('npm --prefix cockpit install --no-audit --no-fund',{stdio:'inherit'})\"",
      board: "npm --prefix cockpit run dev",
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

// Prompt on a TTY, resolving to the raw answer. Resolves "" if stdin hits EOF (e.g. piped
// input) so an awaiting caller never hangs.
function prompt(rl, question) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    rl.question(question, (a) => finish(a));
    rl.on("close", () => finish(""));
  });
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await prompt(rl, `${question}${suffix}: `);
  rl.close();
  return answer.trim() || fallback;
}

// Yes/no prompt. Non-interactive (no TTY) falls back to `def` so scripted runs don't hang.
async function askYesNo(question, def = true) {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt(rl, `${question} (${def ? "Y/n" : "y/N"}): `);
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// Start the visual board (installs the cockpit's deps on first run via the `preboard` hook).
// Blocks until the dev server is stopped — this is intentionally the last thing setup does.
function launchBoard(kitDir, kitName) {
  console.log("\n→ Starting the visual board (installs the UI's deps on first run)…");
  console.log("   → http://localhost:5273    (press Ctrl+C to stop)\n");
  const r = spawnSync("npm", ["run", "board"], {
    cwd: kitDir,
    stdio: "inherit",
    shell: process.platform === "win32", // npm is npm.cmd on Windows
  });
  if (r.status !== 0) {
    console.error(`\n✗ Couldn't start the board. Start it yourself:  cd ${kitName} && npm run board`);
  }
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

  const hasCockpit = existsSync(join(kit, "cockpit"));
  console.log(`
${C.green(C.b(`✅  "${name}" is ready.`))}

${C.dim("  What was created")}
   ${C.indigo("./.claude/")}              agents & skills, at your repo root
   ${C.indigo(`${kitName}/context.md`)}       your brief — stack, tests, guardrails
   ${C.indigo(`${kitName}/board/data.json`)}  your work board

${C.pink(C.b("  ▶  Next — onboard your project in Claude Code:"))}
   ${C.cyan("1.")}  Open this repo in Claude Code:   ${C.yellow("claude")}
   ${C.cyan("2.")}  Paste this to teach the agents your codebase:
       ${C.dim(`"Onboard AI Maestro: fill ${kitName}/context.md from the real`)}
       ${C.dim(" codebase, seed a few starter tickets, then run npm run sync.\"")}
   ${C.cyan("3.")}  Then ask the ${C.b("orchestrator")} agent to start.

${C.dim("  Re-render after edits:")}   ${C.yellow("npm run sync")}   ${C.dim(`(from the ${kitName}/ folder)`)}
${C.dim("  Full cheat sheet:")}        the ${C.b("Help")} tab on the board, or the README`);

  // Offer to open the visual board. `--yes` launches without asking; `--no-board` skips it.
  if (hasCockpit) {
    // Launch only on an explicit yes: `--yes`, or an interactive "Y" at the prompt. A
    // non-interactive run (no TTY) without `--yes` never auto-starts the blocking server.
    const wantsBoard = has(args, "no-board") ? false
      : yes ? true
      : process.stdin.isTTY ? await askYesNo("Open the visual board now?", true)
      : false;
    if (wantsBoard) {
      launchBoard(kit, kitName);
    } else {
      console.log(`   • Visual board (later):   cd ${kitName} && npm run board   → http://localhost:5273\n`);
    }
  } else {
    console.log(`   • Visual board:  clone https://github.com/my-chiefmind/ai-maestro and run 'npm run board'\n`);
  }
}

function help() {
  console.log(`ai-maestro <command>

  setup       Set up AI Maestro in your project — a short questionnaire (start here)
              Offers to open the visual board at the end (--no-board to skip, --yes to auto-open)
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

// The commands the interactive picker offers, in menu order.
const COMMANDS = [
  { key: "setup", label: "Set up AI Maestro in your project (start here)" },
  { key: "sync", label: "Re-render .claude/ from config.json + context.md" },
  { key: "validate", label: "Check the board's integrity" },
  { key: "init", label: "Set up as a small capsule pointing at a kit elsewhere" },
];

async function dispatch(command, args) {
  switch (command) {
    case "setup": await setup(args); break;
    case "init": await init(args); break;
    case "sync": process.exit(run("render/sync.mjs", args)); break;
    case "validate": process.exit(run("scripts/validate-board.mjs", args)); break;
    default: console.error(`Unknown command: ${command}\n`); help(); process.exit(2);
  }
}

// No command given: show help, then (in an interactive terminal) let the user pick one.
async function menu() {
  help();
  if (!process.stdin.isTTY) return;
  console.log("Pick a command:\n");
  COMMANDS.forEach((c, i) => console.log(`  ${i + 1})  ${c.key.padEnd(9)} ${c.label}`));
  console.log("  q)  quit\n");
  const answer = (await ask("Select 1-" + COMMANDS.length, "1")).toLowerCase();
  if (answer === "q" || answer === "quit") return;
  const chosen = COMMANDS[Number(answer) - 1] || COMMANDS.find((c) => c.key === answer);
  if (!chosen) {
    console.error(`\n✗ "${answer}" isn't one of 1-${COMMANDS.length}. Run 'ai-maestro <command>' directly.`);
    process.exit(2);
  }
  console.log(`\n→ Running '${chosen.key}'…`);
  await dispatch(chosen.key, []);
}

switch (cmd) {
  case "-h": case "--help": help(); break;
  case undefined: await menu(); break;
  default: await dispatch(cmd, rest);
}
