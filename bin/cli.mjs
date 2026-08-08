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
      preboard: "node scripts/cockpit-install.mjs",
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

// One readline interface for the whole questionnaire, opened on first use. Opening and closing
// one per question drops input that readline had already buffered, which a multi-question run
// hits immediately when answers are piped in — so share it and close it when the questions end
// (an open interface keeps the process alive).
let RL = null;
let inputEnded = false;   // stdin hit EOF — every later question takes its default
let closingOnPurpose = false;

function promptsOpen() {
  if (!RL) {
    RL = createInterface({ input: process.stdin, output: process.stdout });
    RL.once("close", () => {
      RL = null;
      if (!closingOnPurpose) inputEnded = true;
      closingOnPurpose = false;
    });
  }
  return RL;
}
function closePrompts() {
  if (!RL) return;
  closingOnPurpose = true;
  RL.close();
}

// Prompt, resolving to the raw answer. Resolves "" once stdin hits EOF (e.g. piped input runs
// out) so an awaiting caller never hangs and never reads a closed interface.
function prompt(question) {
  if (inputEnded) return Promise.resolve("");
  return new Promise((res) => {
    const iface = promptsOpen();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      iface.off("close", onClose);
      res(v);
    };
    const onClose = () => finish("");
    iface.once("close", onClose);
    try {
      iface.question(question, finish);
    } catch {
      finish(""); // interface closed underneath us — fall back to the default
    }
  });
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await prompt(`${question}${suffix}: `);
  return answer.trim() || fallback;
}

// Yes/no prompt. Non-interactive (no TTY) falls back to `def` so scripted runs don't hang.
async function askYesNo(question, def = true) {
  if (!process.stdin.isTTY) return def;
  const answer = await prompt(`${question} (${def ? "Y/n" : "y/N"}): `);
  const a = answer.trim().toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// ── The project brief ──────────────────────────────────────────────────────────
// `setup` asks these once and writes context.md from the answers, so nobody has to hand-edit
// the brief or paste a wall of instructions into their coding tool. Every field defaults to
// "propose one": an unanswered field becomes an explicit open question the agents must resolve
// from the real repo, which is honest, whereas a silent blank reads as "no constraints".
const PROPOSE = "propose one";
const BRIEF_FIELDS = [
  { key: "outcome", flag: "outcome", q: "Product outcome — what the finished product should do" },
  { key: "users", flag: "users", q: "Primary users — who it is for" },
  { key: "stack", flag: "stack", q: "Stack — languages, frameworks, database, hosting" },
  { key: "constraints", flag: "constraints", q: "Constraints — non-negotiable technical or product rules" },
  { key: "runCmd", flag: "run", q: "How it should run locally" },
  { key: "testCmd", flag: "test", q: "How it should be tested" },
];

async function askBrief(args, yes) {
  const brief = {};
  for (const f of BRIEF_FIELDS) {
    brief[f.key] = flag(args, f.flag) || (yes ? PROPOSE : await ask(f.q, PROPOSE));
  }
  return brief;
}

// An answer the user left to the agents ("propose one", or empty) vs. a real one.
const isOpen = (v) => !v || v.trim().toLowerCase() === PROPOSE;
const answered = (v) => (isOpen(v) ? null : v.trim());
const OPEN_LINE = `_Not specified — propose one, then replace this line._`;
const orOpen = (v) => answered(v) ?? OPEN_LINE;

// A run/test answer can be an exact command ("npm test") or a sentence describing an approach
// ("Node's test runner plus a manual browser smoke test"). Only the first is safe to render as
// code: formatting prose as a command invents one that doesn't exist, and a release gate that
// tries to execute it fails for the wrong reason.
const looksLikeCommand = (s) =>
  !!s && s.length <= 60 && !s.includes("\n") && !/[.;,]$/.test(s) &&
  s.split(/\s+/).length <= 6 && !/,|\band\b/i.test(s);
const fmtCmd = (v) => {
  const a = answered(v);
  if (!a) return "_propose one_";
  return looksLikeCommand(a) ? `\`${a}\`` : a;
};

// Render context.md — the one file every agent reads — from the answers. Kept in the same
// shape as the starter's brief so the sections agents look for are always present.
function renderContext(name, areas, brief) {
  // One exact command can serve every area; a prose answer can't, so each area keeps an open
  // slot rather than inheriting a sentence that won't run.
  const testCmd = answered(brief.testCmd);
  const perArea = looksLikeCommand(testCmd) ? `\`${testCmd}\`` : "_propose one_";

  const openItems = BRIEF_FIELDS.filter((f) => isOpen(brief[f.key])).map(
    (f) => `- **${f.q.split(" — ")[0]}** — not specified. Propose one (from this codebase where possible), record it above, and remove this line.`
  );
  if (perArea === "_propose one_" && testCmd) {
    openItems.push(`- **Test command per area** — the brief describes the testing approach ("${testCmd}") but not the exact command each area runs. Record one per area above.`);
  }
  const openSection = openItems.length
    ? `\n## Open questions — resolve these before relying on them\n\n${openItems.join("\n")}\n`
    : "";

  return `# ${name} — project context

_Every agent reads this. Written by \`maestro setup\` from your answers — keep it accurate and
short, and correct anything that's wrong._

## What this is

${orOpen(brief.outcome)}

**Primary users:** ${orOpen(brief.users)}

## Stack & conventions

${orOpen(brief.stack)}

- Match existing code style; don't introduce new patterns without a ticket.

## Running & testing locally

- **Run:** ${fmtCmd(brief.runCmd)}
- **Test:** ${fmtCmd(brief.testCmd)}

## Test commands by area

| Area | Command |
| --- | --- |
${areas.map((a) => `| ${a} | ${perArea} |`).join("\n")}

## Constraints

${orOpen(brief.constraints)}

## Guardrails

- \`main\` is protected — branch + PR, don't push directly.
- Prod deploys are a **separate, human-gated track** — never block a dev ticket on them, and
  never reach prod hosts/DB/secrets without explicit go-ahead.
- Secrets come from a documented local source, never committed.
${openSection}`;
}

// AI Maestro runs each ticket in a git worktree, so the project must be a repository. Create
// one when the folder isn't a repo yet; never touch an existing repo's state.
function ensureGitRepo(repoRoot) {
  const inside = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, stdio: "ignore" });
  if (inside.error) return "no-git"; // git isn't installed — worktrees will fail later, so say so
  if (inside.status === 0) return "existing";
  const r = spawnSync("git", ["init"], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
  return r.status === 0 ? "created" : "failed";
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
  // Same brief as `setup` — the capsule flow is still an install, so it shouldn't leave the
  // user to hand-write context.md.
  const brief = await askBrief(args, yes);
  closePrompts();

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

  // 2b. Replace the starter's placeholder brief with one written from the answers.
  writeFileSync(join(projectDir, "context.md"), renderContext(name, areas, brief));

  // 2c. Tickets run in git worktrees, so the repo must exist.
  const git = ensureGitRepo(repoDir);
  if (git === "created") console.log(`\n✓ Initialized a git repository in ${relative(process.cwd(), repoDir) || "."}/`);
  else if (git === "failed" || git === "no-git") console.error("\n  ⚠ no git repository here — create one before starting the orchestrator (tickets run in worktrees).");

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
  const boardStep = !existsSync(boardData)
    ? `   2. This starter has no board — drive the agents directly from ${rel}/context.md.`
    : IS_PACKAGED
      ? `   2. Review the work on the board (${rel}/board/data.json).`
      : `   2. Review the work on the board (${rel}/board/data.json), or open the visual board:
        cd ${relative(process.cwd(), KIT_ROOT) || "."} && npm run board   (http://localhost:5273)`;
  const syncCmd = IS_PACKAGED
    ? `npx @mychiefmind/ai-maestro sync --project ${rel}`
    : `node ${rel}/render/sync.mjs --project ${rel}`;
  console.log(`
✅ Done. Next steps:

${existsSync(boardData)
  ? `   1. Open this repo in Claude Code and run '/project-plan' — your brief in
      ${rel}/context.md becomes epics and dependency-ordered tickets, then it stops for review.`
  : `   1. Open this repo in Claude Code — your brief is in ${rel}/context.md; correct anything
      the agents should know before they start.`}
${boardStep}
${existsSync(boardData)
  ? `   3. Approve the plan, then run '/orchestrator' to build a ticket. Agents & skills are in
      ./.claude/ at your repo root.`
  : `   3. Agents & skills are in ./.claude/ at your repo root — ask one of them for the work
      you need.`}

   Re-run '${syncCmd}' after changing config.json or context.md.
`);
}

/**
 * setup — the whole onboarding, in one questionnaire: it asks for the project brief (outcome,
 * users, stack, constraints, run/test commands), writes config.json + context.md from the
 * answers, initializes a git repo if the folder isn't one, renders the agents/skills, and
 * validates the board — so the only thing left is to ask Claude Code to plan the work.
 *
 * Two equivalent entry points:
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

  console.log("\n🎼  AI Maestro — tell me about the project and you're set up\n");
  console.log(C.dim("  Press Enter to accept the default. \"propose one\" lets the agents work it\n  out from your codebase and show you what they chose.\n"));
  const yes = has(args, "yes");
  // The kit lives at <project>/maestro, so the parent dir names the project.
  const repoRoot = dirname(kit);
  const defaultName = basename(repoRoot);
  const name = flag(args, "name") || (yes ? defaultName : await ask("Project name", defaultName));
  const brief = await askBrief(args, yes);
  const areasRaw = flag(args, "areas") || (yes ? "backend, frontend, infra, docs" : await ask("Areas of work (comma-separated)", "backend, frontend, infra, docs"));
  const areas = areasRaw.split(",").map((s) => s.trim()).filter(Boolean);
  closePrompts(); // the questions are done — don't hold stdin open through the work below

  // Seed config.json from the orchestrated starter, then stamp in the answers.
  const starter = join(kit, "starters", "orchestrated-project");
  const config = JSON.parse(readFileSync(join(starter, "config.json"), "utf8"));
  config.project = { name, areas };
  config.kitSource = { mode: "self", path: "." };
  config.outDir = ".."; // render .claude/ + CLAUDE.md to the repo root, where the tool looks
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Write the brief from the answers. An existing context.md is the user's own work (only a
  // `--force` re-run gets here with one) — keep it rather than overwrite their edits.
  const contextPath = join(kit, "context.md");
  const keptContext = existsSync(contextPath);
  if (keptContext) {
    console.log(`\n  ⚠ kept your existing ${kitName}/context.md — your answers weren't written to it.`);
  } else {
    writeFileSync(contextPath, renderContext(name, areas, brief));
  }

  // A git repo is a hard requirement (tickets run in worktrees) — create one if needed.
  const git = ensureGitRepo(repoRoot);
  if (git === "created") console.log(`\n✓ Initialized a git repository in ${relative(process.cwd(), repoRoot) || "."}/`);
  else if (git === "failed") console.error("\n  ⚠ 'git init' failed — run it yourself before starting the orchestrator (tickets run in worktrees).");
  else if (git === "no-git") console.error("\n  ⚠ git isn't installed — install it before starting the orchestrator (tickets run in worktrees).");

  // Render agents & skills to the repo root (config.outDir="..").
  console.log("\n→ Setting up your agents & skills…");
  run("render/sync.mjs", ["--project", kit], kit);

  // Validate the seeded board so a broken starting point surfaces now, not mid-run.
  const boardData = join(kit, "board", "data.json");
  if (existsSync(boardData)) {
    console.log("\n→ Checking the board…");
    run("scripts/validate-board.mjs", [boardData, "--agents", join(kit, "agents")], kit);
  }

  const hasCockpit = existsSync(join(kit, "cockpit"));
  const openCount = keptContext ? 0 : BRIEF_FIELDS.filter((f) => isOpen(brief[f.key])).length;
  const openNote = openCount
    ? `\n${C.dim(`  ${openCount} question${openCount > 1 ? "s" : ""} left to the agents — planning proposes an answer for each and shows you.`)}`
    : "";
  console.log(`
${C.green(C.b(`✅  "${name}" is ready.`))}

${C.dim("  What was created")}
   ${C.indigo("./.claude/")}              agents & skills, at your repo root
   ${C.indigo(`${kitName}/context.md`)}       your brief, written from your answers
   ${C.indigo(`${kitName}/board/data.json`)}  your work board

${C.pink(C.b("  ▶  Next — in Claude Code:"))}
   ${C.cyan("1.")}  Open this repo:   ${C.yellow("claude")}
   ${C.cyan("2.")}  Plan the work:    ${C.yellow("/project-plan")}
       ${C.dim("turns your brief into epics and dependency-ordered tickets,")}
       ${C.dim("then stops for your review.")}
   ${C.cyan("3.")}  Approve it, then build:   ${C.yellow("/orchestrator")}   ${C.dim("— one ticket per run")}
${openNote}
${C.dim("  Re-render after edits:")}   ${C.yellow("npm run sync")}   ${C.dim(`(from the ${kitName}/ folder)`)}
${C.dim("  Full cheat sheet:")}        the ${C.b("Help")} tab on the board, or the README`);

  // Offer to open the visual board. `--yes` launches without asking; `--no-board` skips it.
  if (hasCockpit) {
    // Launch only in a terminal: the server blocks until Ctrl+C, so a run without a TTY
    // (CI, scripts) must never start it — even with `--yes`, which otherwise means
    // "launch without asking".
    const wantsBoard = has(args, "no-board") || !process.stdin.isTTY ? false
      : yes ? true
      : await askYesNo("Open the visual board now?", true);
    closePrompts(); // the board server takes over stdin from here
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
              Asks for your project brief, writes config.json + context.md from the answers,
              runs 'git init' if needed, renders .claude/, and checks the board.
              Offers to open the visual board at the end (--no-board to skip, --yes to auto-open)
              Answer non-interactively with: --name, --areas, --outcome, --users, --stack,
              --constraints, --run, --test  (anything omitted defaults to "propose one")
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
  if (answer === "q" || answer === "quit") { closePrompts(); return; }
  const chosen = COMMANDS[Number(answer) - 1] || COMMANDS.find((c) => c.key === answer);
  if (!chosen) {
    console.error(`\n✗ "${answer}" isn't one of 1-${COMMANDS.length}. Run 'ai-maestro <command>' directly.`);
    process.exit(2);
  }
  console.log(`\n→ Running '${chosen.key}'…`);
  // Left open on purpose: the chosen command's own questions reuse this interface, and each
  // command closes it once its questionnaire is done.
  await dispatch(chosen.key, []);
  closePrompts();
}

switch (cmd) {
  case "-h": case "--help": help(); break;
  case undefined: await menu(); break;
  default: await dispatch(cmd, rest);
}
