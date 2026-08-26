#!/usr/bin/env node
/**
 * maestro — the one command a newcomer runs.
 *
 *   maestro init [--dir <repo>] [--name <name>] [--areas a,b,c] [--starter orchestrated|lightweight] [--yes]
 *   maestro update [--kit <dir>] [--force] [--offline]   (bring a set-up kit to this CLI's version)
 *   maestro sync [...]        (thin passthrough to render/sync.mjs)
 *   maestro validate [...]    (thin passthrough to scripts/validate-board.mjs)
 *   maestro run <id> [...]    (thin passthrough to scripts/run-ticket.mjs)
 *
 * `init` is interactive: it asks a few questions, copies a starter into <repo>/maestro/,
 * writes config.json for you, renders the agents/skills, validates the board, and prints
 * exactly what to run next. No hand-editing of paths, no memorising flags.
 *
 * No third-party dependencies.
 */

import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, readdirSync, statSync, realpathSync } from "fs";
import { resolve, dirname, join, relative, basename, sep, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createInterface } from "readline";
import { createHash } from "crypto";
import { readRegistry, findKitDir } from "../scripts/registry.mjs";
import { emptyPlan, renderPlanMd, planCompleteness } from "../scripts/plan-core.mjs";

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

// The vendored board folder mixes kit files (schema, README) with the project's live tickets —
// these two are the user's work and must survive an update.
const BOARD_USER_FILES = new Set(["data.json", "archive.json"]);

// Free-form workspace folders a project grows under board/ on its own (specs/, reports/ — see
// the starter README) that the kit never shipped as template content in the first place, even
// though this repo's OWN board now happens to have them (its specs/ holds ai-maestro's own
// tickets, not example content — T-001). Never seed them into a project, and — belt and
// braces alongside the lock-based removal below — never remove them either.
const BOARD_NEVER_VENDOR = new Set(["specs", "reports"]);

// Records, per board file, the content hash THIS tool last vendored — written by vendorKit /
// refreshVendoredKit, read back on the next update. Lets refreshVendoredKit tell "the kit
// stopped shipping this" (safe to remove) apart from "this was never ours to begin with" (a
// project's own board content, e.g. an unlisted future workspace folder — never remove without
// this), and lets it tell "the project hand-edited a kit file" (e.g. board/README.md — keep
// their edit) apart from "unedited since we wrote it" (safe to overwrite). See T-001.
const VENDOR_LOCK_FILE = ".maestro-vendor.lock";
const sha256 = (data) => "sha256:" + createHash("sha256").update(data).digest("hex");

/** Two paths naming the same directory. Compared through symlinks, since process.cwd() resolves
 * them and a --kit argument does not — on macOS that alone makes /var and /private/var differ. */
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

// Where a project's OWN agents/skills live, safe from every sweep below because `custom` is
// not a VENDORED entry. render/sync.mjs merges it over the kit's roster.
const CUSTOM_DIR = "custom";

// Vendored folders that mix kit files with files the project may have added itself. Handled
// like board/ rather than by the blind remove-and-recopy the other entries get: that swept
// away any agent or skill a project had added, silently, on every single update — while the
// docs told people to put them exactly there (T-011). `file` entries are `<name>.md`,
// `dir` entries are `<name>/SKILL.md`.
const OVERLAY_ENTRIES = { agents: "file", skills: "dir" };

/** Identity of one overlay item, for the vendor lock: its content, or its SKILL.md's. */
function overlayItemHash(abs, kind) {
  if (kind === "file") return sha256(readFileSync(abs));
  const skill = join(abs, "SKILL.md");
  return existsSync(skill) ? sha256(readFileSync(skill)) : "dir";
}

/** The items of an overlay-style folder, keyed by name. Ignores anything of the wrong shape. */
function overlayItems(dir, kind) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    if (VENDOR_SKIP.has(f) || f === VENDOR_LOCK_FILE) return false;
    const abs = join(dir, f);
    return kind === "file" ? f.endsWith(".md") && statSync(abs).isFile() : statSync(abs).isDirectory();
  });
}

function overlayVendorHashes(dir, kind) {
  const hashes = {};
  for (const f of overlayItems(dir, kind)) hashes[f] = overlayItemHash(join(dir, f), kind);
  return hashes;
}

function readVendorLock(dest) {
  const p = join(dest, VENDOR_LOCK_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // corrupt/foreign file — treat as "no lock", the safe (never-remove) default
  }
}

function writeVendorLock(dest, lock) {
  writeFileSync(join(dest, VENDOR_LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");
}

// Minimal package.json so `npm run sync` / `npm run validate` / `npm run board` work from
// the folder, matching what the docs tell clone users to run. `preboard` installs the
// cockpit's deps on demand so the first `npm run board` just works. `update` goes through
// npx: the vendored copy is dependency-free and can't fetch a newer version itself.
function writeVendorPackageJson(dest) {
  const pkg = {
    name: "maestro",
    private: true,
    type: "module",
    scripts: {
      setup: "node bin/cli.mjs setup",
      sync: "node render/sync.mjs --project .",
      validate: "node scripts/validate-board.mjs board/data.json",
      ticket: "node scripts/board-write.mjs",
      plan: "node scripts/plan-write.mjs",
      lanes: "node scripts/lane-plan.mjs",
      update: "npx @mychiefmind/ai-maestro@latest update --kit .",
      preboard: "node scripts/cockpit-install.mjs",
      board: "npm --prefix cockpit run dev",
    },
  };
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Create `custom/` at setup, with the empty folders and a README.
 *
 * The docs name `custom/agents/` and `custom/skills/<name>/SKILL.md` as where your own agents
 * go, but nothing created either — the folder only ever appeared when `update` or the renderer
 * rescued a file into it. So the documented path didn't exist in a fresh install, which reads
 * as "that isn't really how this works" and sends people back to hand-editing generated
 * runtime folders — exactly what the renderer overwrites.
 *
 * Never overwrites: on a `--force` re-run the README may have been edited, and any agent
 * already there is the whole point of the folder.
 */
function seedCustomDir(kit) {
  const dir = join(kit, CUSTOM_DIR);
  for (const sub of Object.keys(OVERLAY_ENTRIES)) mkdirSync(join(dir, sub), { recursive: true });
  const readme = join(dir, "README.md");
  if (existsSync(readme)) return;
  writeFileSync(
    readme,
    `# Your agents and skills

This folder is yours. \`maestro update\` replaces the kit's folders wholesale and never touches
this one, so anything here survives every upgrade — unlike hand-editing \`.claude/\`,
\`.agents/\`, or \`.codex/\`, which the renderer regenerates.

| You want to | Put it in |
| --- | --- |
| Add an agent of your own | \`custom/agents/<name>.md\` |
| Add a skill of your own | \`custom/skills/<name>/SKILL.md\` |
| Add rules to a kit agent | \`custom/agents/<name>.overlay.md\` |
| Add rules to a kit skill | \`custom/skills/<name>/OVERLAY.md\` |
| Replace a kit agent outright | \`custom/agents/<name>.md\` (same name as the kit's) |

Prefer an **overlay** over a replacement: an overlay is appended under a \`## Project overlay\`
heading and the kit's half keeps improving underneath, while a replacement opts this project out
of every future update to that file. \`sync\` reports which you have.

Your own agents and skills need no \`config.json\` entry — \`roster\` and \`skills\` select which
*kit* files you take; everything here is always rendered. Run \`npm run sync\` after changing
anything in this folder.
`
  );
}

function vendorKit(dest) {
  mkdirSync(dest, { recursive: true });
  const filter = (src) => !VENDOR_SKIP.has(basename(src));
  const boardFilter = (src) => filter(src) && !BOARD_NEVER_VENDOR.has(basename(src));
  for (const entry of VENDORED) {
    const src = join(KIT_ROOT, entry);
    if (existsSync(src)) cpSync(src, join(dest, entry), { recursive: true, filter: entry === "board" ? boardFilter : filter });
  }
  writeVendorPackageJson(dest);
  const lock = { board: boardVendorHashes(join(dest, "board")) };
  for (const [entry, kind] of Object.entries(OVERLAY_ENTRIES)) {
    lock[entry] = overlayVendorHashes(join(dest, entry), kind);
  }
  writeVendorLock(dest, lock);
}

// Hashes what vendorKit's initial copy just wrote under board/, for the vendor lock. Only
// correct for a brand-new vendor: nothing has diverged yet, so "what's on disk" and "what we
// vendored" are the same thing. refreshVendoredKit tracks its own lock entries as it goes
// instead, precisely to keep divergence (a hand-edited board/README.md, say) distinguishable
// from "unedited since we wrote it" across repeated updates.
function boardVendorHashes(destBoard) {
  const hashes = {};
  if (!existsSync(destBoard)) return hashes;
  for (const f of readdirSync(destBoard)) {
    if (BOARD_USER_FILES.has(f) || BOARD_NEVER_VENDOR.has(f) || VENDOR_SKIP.has(f) || f === VENDOR_LOCK_FILE) continue;
    const abs = join(destBoard, f);
    hashes[f] = statSync(abs).isFile() ? sha256(readFileSync(abs)) : "dir";
  }
  return hashes;
}

// Re-vendor over an existing kit copy. Each entry is removed before copying so files deleted
// upstream disappear too — a plain overwrite would leave them behind forever. board/ is the
// exception: it mixes kit-owned files with the project's own workspace, so nothing there is
// removed on "not shipped upstream" alone — only files THIS tool vendored last time (per the
// vendor lock) and that the new release no longer ships. See T-001: the old rule read a
// project's own board/specs/, board/reports/, or any future workspace folder as "deleted
// upstream" and deleted it right along with actual removals.
function refreshVendoredKit(dest) {
  const filter = (src) => !VENDOR_SKIP.has(basename(src));
  const priorLock = readVendorLock(dest) ?? {};
  const priorBoard = priorLock.board ?? {};
  const newLock = {};
  const rescued = []; // project-owned files moved to custom/ — reported by update()
  for (const entry of VENDORED) {
    const src = join(KIT_ROOT, entry);
    if (!existsSync(src)) continue;
    if (entry === "board") {
      const destBoard = join(dest, "board");
      mkdirSync(destBoard, { recursive: true });
      for (const f of readdirSync(destBoard)) {
        if (BOARD_USER_FILES.has(f) || VENDOR_SKIP.has(f) || f === VENDOR_LOCK_FILE) continue;
        if (!(f in priorBoard)) continue; // never vendored by us — leave it, whatever it is
        if (existsSync(join(src, f))) continue; // still shipped upstream — copy loop below handles it
        rmSync(join(destBoard, f), { recursive: true, force: true });
      }
      const newBoardLock = {};
      for (const f of readdirSync(src)) {
        if (VENDOR_SKIP.has(f) || BOARD_NEVER_VENDOR.has(f)) continue;
        if (BOARD_USER_FILES.has(f)) {
          if (!existsSync(join(destBoard, f))) cpSync(join(src, f), join(destBoard, f), { recursive: true, filter });
          continue; // never tracked in the lock — the project's own data, never touched again
        }
        const srcAbs = join(src, f);
        const destAbs = join(destBoard, f);
        const srcIsFile = statSync(srcAbs).isFile();
        const srcHash = srcIsFile ? sha256(readFileSync(srcAbs)) : "dir";
        // The project hand-edited this since we last vendored it (its on-disk content no
        // longer matches what we wrote) — most concretely board/README.md, which projects
        // commonly make their own. Keep their edit; keep recording OUR hash, not theirs, so
        // the divergence keeps being detected on every future run, not just this one.
        if (srcIsFile && existsSync(destAbs) && f in priorBoard && priorBoard[f] !== "dir"
            && sha256(readFileSync(destAbs)) !== priorBoard[f]) {
          newBoardLock[f] = priorBoard[f];
          continue;
        }
        rmSync(destAbs, { recursive: true, force: true });
        cpSync(srcAbs, destAbs, { recursive: true, filter });
        newBoardLock[f] = srcHash;
      }
      newLock.board = newBoardLock;
    } else if (entry in OVERLAY_ENTRIES) {
      newLock[entry] = refreshOverlayEntry(dest, entry, OVERLAY_ENTRIES[entry], priorLock[entry], rescued);
    } else {
      rmSync(join(dest, entry), { recursive: true, force: true });
      cpSync(src, join(dest, entry), { recursive: true, filter });
    }
  }
  writeVendorLock(dest, newLock);
  writeVendorPackageJson(dest);
  return rescued;
}

/**
 * Refresh one overlay-style folder (agents/, skills/), moving anything the project owns into
 * `custom/` FIRST so the remove-and-recopy below cannot take it. Two things get rescued:
 *
 *   - items this release doesn't ship — the project added them;
 *   - items it does ship, whose content no longer matches what we vendored — the project
 *     hand-edited a kit file, i.e. forked it. Moving the fork to custom/ preserves both the
 *     edit AND its effect, since custom/ overrides the kit file of the same name.
 *
 * The hand-edit case needs a prior lock entry to detect, so it only works from the second
 * update after this landed. The unshipped case needs no history and works immediately —
 * which is the one that was destroying people's work.
 *
 * Nothing here deletes: without a lock we cannot tell "the project added this" from "the kit
 * removed it two versions ago", and rescuing a stale kit file into custom/ is a nuisance
 * while deleting someone's agent is not recoverable.
 */
function refreshOverlayEntry(dest, entry, kind, prior, rescued) {
  const filter = (src) => !VENDOR_SKIP.has(basename(src));
  const src = join(KIT_ROOT, entry);
  const destDir = join(dest, entry);
  const customDir = join(dest, CUSTOM_DIR, entry);
  const shipped = new Set(overlayItems(src, kind));

  for (const f of overlayItems(destDir, kind)) {
    const abs = join(destDir, f);
    const why = !shipped.has(f)
      ? "not shipped by this release"
      : prior?.[f] && prior[f] !== overlayItemHash(abs, kind)
        ? "hand-edited kit file"
        : null;
    if (!why) continue;

    const target = join(customDir, f);
    if (existsSync(target)) {
      // custom/ already holds this name, and custom/ is what renders — the copy here is a
      // stale duplicate that has been having no effect. Say so rather than silently dropping it.
      rescued.push({ from: join(entry, f), to: join(CUSTOM_DIR, entry, f), why: "duplicate of custom/ — custom/ kept" });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(abs, target, { recursive: true, filter });
    rescued.push({ from: join(entry, f), to: join(CUSTOM_DIR, entry, f), why });
  }

  rmSync(destDir, { recursive: true, force: true });
  cpSync(src, destDir, { recursive: true, filter });
  return overlayVendorHashes(destDir, kind);
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

/**
 * Seed `board/plan.json` from the brief, and render its `plan.md` mirror.
 *
 * Only the goal is seeded, and only when the user actually answered. The rest of the plan —
 * the scope boundary, deliverables, use cases, functional and non-functional requirements — is
 * a set of commitments nobody but the user can make, and a plausible guess written here would
 * count as "filled" toward the completeness percentage while being no one's decision. The
 * percentage is only worth printing if it is honest.
 *
 * Returns the plan's completeness percentage, or null if the plan couldn't be written (an
 * older starter with no board, say) — setup then just doesn't mention it.
 *
 * @param {string} kit @param {string} name @param {Record<string,string>} brief
 * @returns {number | null}
 */
function seedPlan(kit, name, brief) {
  const boardDir = join(kit, "board");
  if (!existsSync(boardDir)) return null;
  const planPath = join(boardDir, "plan.json");

  try {
    // An existing plan is the user's own work — a --force re-run must not blank it.
    let plan;
    if (existsSync(planPath)) {
      try { plan = JSON.parse(readFileSync(planPath, "utf8")); } catch { plan = emptyPlan(); }
      const hasGoal = plan?.sections?.goal?.text?.trim();
      if (hasGoal) return planCompleteness(plan).percent;
    } else {
      plan = emptyPlan();
    }

    const outcome = answered(brief.outcome);
    if (outcome) plan.sections.goal.text = outcome;

    writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
    writeFileSync(join(boardDir, "plan.md"), renderPlanMd(plan, name));
    return planCompleteness(plan).percent;
  } catch {
    return null; // never let a plan-seeding hiccup abort an otherwise-good setup
  }
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
  // Not a fixed URL: the board takes the next free port when 5273 is busy — which it is
  // whenever another project's board is open — and prints the one it settled on below.
  console.log("   → it will print its URL in a moment    (press Ctrl+C to stop)\n");
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
  config.outDir = ".."; // render native runtime files to the repo root (parent of the capsule)
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
        cd ${relative(process.cwd(), KIT_ROOT) || "."} && npm run board   (prints its URL; usually http://localhost:5273)`;
  const syncCmd = IS_PACKAGED
    ? `npx @mychiefmind/ai-maestro sync --project ${rel}`
    : `node ${rel}/render/sync.mjs --project ${rel}`;
  console.log(`
✅ Done. Next steps:

${existsSync(boardData)
  ? `   1. Open this repo in Claude Code or Codex and run '/project-plan' — your brief in
      ${rel}/context.md becomes epics and dependency-ordered tickets, then it stops for review.`
  : `   1. Open this repo in Claude Code or Codex — your brief is in ${rel}/context.md; correct anything
      the agents should know before they start.`}
${boardStep}
${existsSync(boardData)
  ? `   3. Approve the plan, then run '/orchestrator' to build a ticket. Agents & skills are in
      ./.claude/ for Claude and ./.agents/ + ./.codex/ for Codex.`
  : `   3. Agents & skills are ready for Claude and Codex at your repo root — ask one of them for the work
      you need.`}

   Re-run '${syncCmd}' after changing config.json or context.md.
`);
}

/**
 * setup — the whole onboarding, in one questionnaire: it asks for the project brief (outcome,
 * users, stack, constraints, run/test commands), writes config.json + context.md from the
 * answers, initializes a git repo if the folder isn't one, renders the agents/skills, and
 * validates the board — so the only thing left is to ask Claude Code or Codex to plan the work.
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
 * native Claude Code and Codex files at your REPO ROOT (where coding tools discover them). No npm
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
  } else {
    // Not packaged: this is the "clone ai-maestro into your repo as maestro/, then run
    // maestro/bin/cli.mjs setup" flow, where the project root is dirname(KIT_ROOT) — the
    // kit's own physical location decides the target, not cwd. That's correct when cwd is
    // the kit itself or somewhere above it (the documented flow), but an invocation from an
    // unrelated cwd silently targets whatever dirname(KIT_ROOT) happens to be — kit-075 §2d:
    // this scaffolded context.md/board/.claude straight into an uninvolved directory with no
    // warning. Refuse rather than guess; cd to the right place is a one-word fix.
    const cwd = process.cwd();
    const relToKit = relative(cwd, KIT_ROOT);
    const cwdRelatedToKit = cwd === KIT_ROOT || (!relToKit.startsWith("..") && !isAbsolute(relToKit));
    if (!cwdRelatedToKit) {
      console.error(`✗ Refusing to guess which project this is for.

  You're running this kit's setup from:
    ${cwd}
  but the kit itself lives at:
    ${KIT_ROOT}

  That combination would target ${dirname(KIT_ROOT)}/ as the project — which has nothing to
  do with where you are, and is very likely not what you meant.

  Fix: cd to the project you actually want to set up (the kit should sit at
  <project>/maestro/, so cd into <project> or into the maestro/ clone itself), then re-run.
  Or use the npx flow instead, which always targets your current directory:
    npx @mychiefmind/ai-maestro setup`);
      process.exit(2);
    }
  }

  const configPath = join(kit, "config.json");
  const kitName = basename(kit);
  // Whether this is a genuinely first-time setup, as opposed to a --force re-run over an
  // already-configured project — decides below whether the board gets reseeded from the
  // starter or left alone as the project's own live data.
  const fresh = !existsSync(configPath);
  if (!fresh && !has(args, "force")) {
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
  config.outDir = ".."; // render native runtime files to the repo root, where tools look
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Seed the initial board from the starter, not from whatever ended up at kit/board/ —
  // vendorKit() (packaged) copies the whole kit board/ wholesale, and a clone checkout
  // (kit === KIT_ROOT) IS this kit's own board/ on disk. Both hold ai-maestro's own tickets,
  // not example content a new project should start from (see T-001's archive note). Only on
  // a genuinely fresh setup — a --force re-run must never clobber a project's live board.
  if (fresh) {
    for (const f of ["data.json", "archive.json", "plan.json", "plan.md"]) {
      const starterFile = join(starter, "board", f);
      if (existsSync(starterFile)) cpSync(starterFile, join(kit, "board", f));
    }
  }

  seedCustomDir(kit);

  // Write the brief from the answers. An existing context.md is the user's own work (only a
  // `--force` re-run gets here with one) — keep it rather than overwrite their edits.
  const contextPath = join(kit, "context.md");
  const keptContext = existsSync(contextPath);
  if (keptContext) {
    console.log(`\n  ⚠ kept your existing ${kitName}/context.md — your answers weren't written to it.`);
  } else {
    writeFileSync(contextPath, renderContext(name, areas, brief));
  }

  // Seed the project plan from the one brief answer that maps to it cleanly. Only the goal:
  // everything else in the plan (scope boundary, deliverables, use cases, requirements) is a
  // commitment the user has to actually make, and a seeded guess would count as "filled" while
  // being nobody's decision. A 15% plan that says what's missing beats a 100% one that lies.
  const planned = seedPlan(kit, name, brief);

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
   ${C.indigo("./.claude/")}              Claude agents & skills, at your repo root
   ${C.indigo("./.agents/ + ./.codex/")}  Codex skills & subagents, at your repo root
   ${C.indigo(`${kitName}/context.md`)}       your brief, written from your answers
   ${C.indigo(`${kitName}/board/data.json`)}  your work board
   ${C.indigo(`${kitName}/board/plan.json`)}  your project plan${planned == null ? "" : C.dim(`  — ${planned}% complete`)}

${C.pink(C.b("  ▶  Next — in Claude Code or Codex:"))}
   ${C.cyan("1.")}  Open this repo:   ${C.yellow("claude")} ${C.dim("or")} ${C.yellow("codex")}
   ${C.cyan("2.")}  Plan the work:    ${C.yellow("/project-plan")}
       ${C.dim("writes the project plan — goal, scope, deliverables, use cases,")}
       ${C.dim("requirements — then turns it into epics and dependency-ordered")}
       ${C.dim("tickets, stopping for your review at each step.")}
       ${C.dim("Fill in any section later with")} ${C.yellow("/plan-update")} ${C.dim("or the board's Plan tab.")}
   ${C.cyan("3.")}  Approve it, then build:   ${C.yellow("/orchestrator")}   ${C.dim("— one ticket per run")}
       ${C.dim("It only runs tickets the plan covers — that's the point of the plan.")}
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
      console.log(`   • Visual board (later):   cd ${kitName} && npm run board   → prints its URL (usually http://localhost:5273)\n`);
    }
  } else {
    console.log(`   • Visual board:  clone https://github.com/my-chiefmind/ai-maestro and run 'npm run board'\n`);
  }
}

const readKitVersion = (dir) =>
  existsSync(join(dir, "VERSION")) ? readFileSync(join(dir, "VERSION"), "utf8").trim() : "0.0.0";

const PKG_NAME = "@mychiefmind/ai-maestro";

/**
 * The newest version published to npm, or null when the lookup can't be made — offline, npm
 * missing, package unpublished. Same contract as the one in scripts/maestro-drift.mjs: a
 * failure is "unknown", never an error, because updating must not require the network.
 */
function latestPublishedVersion() {
  const r = spawnSync("npm", ["view", PKG_NAME, "version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Is this CLI itself out of date? `npx <pkg>` with no `@latest` reuses whatever the npx cache
 * already holds, so a months-old CLI can run against a months-old project and find them in
 * perfect agreement. Returns the newer published version, or null when the CLI is current /
 * the lookup didn't happen. Only meaningful for a packaged copy — a clone updates via git.
 */
function newerPublishedThan(version, args) {
  if (!IS_PACKAGED || has(args, "offline")) return null;
  const latest = latestPublishedVersion();
  return latest && cmpSemver(latest, version) > 0 ? latest : null;
}

function cmpSemver(a, b) {
  const pa = a.split(/[.+-]/, 3).map(Number);
  const pb = b.split(/[.+-]/, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// A clone updates via git — but only when KIT_ROOT is itself the top of a repository. A kit
// vendored into a user's project sits *inside* their repo, so a bare "am I in a repo?" check
// would happily `git pull` the user's project instead of the kit.
function isKitClone() {
  const r = spawnSync("git", ["-C", KIT_ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 && resolve(r.stdout.trim()) === KIT_ROOT;
}

/**
 * update — bring an installed kit up to the version this CLI ships.
 *
 * From npm/npx/global (IS_PACKAGED): refreshes the kit that `setup` vendored into
 * <repo>/maestro/ — kit files are replaced, the user's config.json / context.md / board data
 * are kept — then re-renders all enabled runtime targets and re-checks the board. The registry is the update
 * channel, so run it through the latest package:
 *
 *   npx @mychiefmind/ai-maestro@latest update      # at the repo root
 *   npm run update                                 # from the maestro/ folder (same thing)
 *
 * From a clone of the kit repo: `git pull --ff-only`, then re-render (or, for a shared kit
 * with no config.json of its own, print the per-project re-render command).
 */
/**
 * update --all — bring every project in a registry to this CLI's version.
 *
 * With a portfolio of repos, the recurring cost of a kit release is a manual pass over every
 * one of them, which is how installs quietly drift versions apart. Each project runs in its own
 * subprocess (the isolation `sync --all` already uses) so one broken project reports and the
 * batch continues, and `--dry-run` shows what would change before anything is touched.
 *
 * Parked projects are excluded by readRegistry itself — that is what parked means.
 */
async function updateAll(args) {
  const registryPath = resolve(flag(args, "registry") || "maestro-registry.json");
  const dryRun = has(args, "dry-run");
  let projects;
  try {
    ({ projects } = readRegistry(registryPath));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  if (!projects.length) {
    console.error(`✗ ${registryPath} lists no active projects.`);
    process.exit(2);
  }

  const target = readKitVersion(KIT_ROOT);
  // Asked once for the whole batch, not once per project: walking a registry and moving every
  // project onto a version that is itself out of date is the one outcome nobody wants here.
  const stale = newerPublishedThan(target, args);
  if (stale) {
    console.error(`✗ This CLI ships v${target}, but v${stale} is published — refusing to move ${projects.length} project(s) onto a stale version.
  Re-run: npx ${PKG_NAME}@latest update --all`);
    process.exit(2);
  }
  console.log(`\n🎼  Updating ${projects.length} project(s) to v${target}${dryRun ? "  (dry run — nothing will be written)" : ""}\n`);

  // Passed through to each project so a batch behaves like the single-project command.
  // --offline goes with it unconditionally: the staleness check above already covered the
  // batch, and without it every project would repeat the same registry lookup.
  const passthrough = [...["force"].filter((f) => has(args, f)).map((f) => `--${f}`), "--offline"];

  let failures = 0, skipped = 0, changed = 0;
  for (const { name, path: projectPath } of projects) {
    const kitDir = existsSync(projectPath) ? findKitDir(projectPath) : null;
    if (!kitDir) {
      // Not a failure: a registry legitimately lists repos that haven't adopted the kit yet.
      console.log(`  ${C.dim("–")} ${name}: not set up — skipped`);
      skipped++;
      continue;
    }
    const current = readKitVersion(kitDir);
    if (dryRun) {
      const verdict = current === target ? "already up to date" : `v${current} → v${target}`;
      console.log(`  ${current === target ? C.dim("·") : C.cyan("→")} ${name}: ${verdict}`);
      if (current !== target) changed++;
      continue;
    }
    const r = spawnSync(NODE, [join(KIT_ROOT, "bin", "cli.mjs"), "update", "--kit", kitDir, ...passthrough], {
      encoding: "utf8",
    });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) {
      console.error(`✗ ${name}: update failed (exit ${r.status})`);
      failures++;
    } else if (current !== target) {
      changed++;
    }
  }

  const summary = [`${projects.length - failures - skipped}/${projects.length} ok`];
  if (changed) summary.push(`${changed} ${dryRun ? "would change" : "updated"}`);
  if (skipped) summary.push(`${skipped} not set up`);
  if (failures) summary.push(`${failures} failed`);
  console.log(`\n${failures ? "✗" : "✓"} ${summary.join(", ")}.`);
  process.exit(failures ? 1 : 0);
}

/**
 * After the kit is refreshed, tell the project what the new kit ships that its config doesn't
 * name — and offer to adopt it.
 *
 * WHY: `config.roster` / `config.skills` select which KIT agents and skills a project takes, and
 * `update` never edits a project's config. So a roster stays frozen at whatever the starter
 * shipped the day the project was set up, and everything added to the kit afterwards is simply
 * absent: not rendered, not mentioned, no error. Until 0.1.27 those filters were a no-op in the
 * vendored layout, which hid the drift completely — then the fix made the filters real and the
 * accumulated omissions surfaced all at once as deletions.
 *
 * Two lists, because they answer different questions:
 *   - "new in this release" comes from the vendor lock, which records what we vendored last
 *     time. Precise, and the common case.
 *   - "unlisted" is everything the kit ships that the config omits, which also catches drift
 *     that accumulated silently over many releases — the case that actually bit.
 *
 * Never adopted silently: `roster` is also how a project deliberately drops an agent it doesn't
 * want, and a command that quietly re-adds it makes the list untrustworthy. So: report always,
 * ask when there's a terminal, and require an explicit flag otherwise.
 */
async function reconcileRoster(kit, kitRel, args, preRefreshLock) {
  const configPath = join(kit, "config.json");
  if (!existsSync(configPath)) return;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return; // a broken config is the renderer's error to report, with a better message
  }
  // No roster/skills key at all means "take everything" — nothing can be missing.
  if (!Array.isArray(config.roster) && !Array.isArray(config.skills)) return;

  const kitAgents = existsSync(join(kit, "agents"))
    ? readdirSync(join(kit, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    : [];
  const kitSkills = existsSync(join(kit, "skills"))
    ? readdirSync(join(kit, "skills")).filter((d) => existsSync(join(kit, "skills", d, "SKILL.md")))
    : [];

  const unlistedAgents = Array.isArray(config.roster) ? kitAgents.filter((a) => !config.roster.includes(a)) : [];
  const unlistedSkills = Array.isArray(config.skills) ? kitSkills.filter((s) => !config.skills.includes(s)) : [];
  if (!unlistedAgents.length && !unlistedSkills.length) return;

  // What THIS release added, from the lock written before the refresh overwrote it.
  const priorAgents = new Set(Object.keys(preRefreshLock?.agents ?? {}).map((f) => f.replace(/\.md$/, "")));
  const priorSkills = new Set(Object.keys(preRefreshLock?.skills ?? {}));
  const isNew = (name, prior) => prior.size > 0 && !prior.has(name);
  const newAgents = unlistedAgents.filter((a) => isNew(a, priorAgents));
  const newSkills = unlistedSkills.filter((s) => isNew(s, priorSkills));

  const line = (label, all, fresh) =>
    all.length
      ? `     ${label}: ${all.map((n) => (fresh.includes(n) ? `${n} ${C.green("(new)")}` : n)).join(", ")}`
      : null;

  console.log(`\n  ${C.yellow("⚠")} this kit ships ${unlistedAgents.length + unlistedSkills.length} item(s) your config.json doesn't list, so they are NOT rendered:`);
  for (const l of [line("agents", unlistedAgents, newAgents), line("skills", unlistedSkills, newSkills)]) {
    if (l) console.log(l);
  }
  if (newAgents.length || newSkills.length) {
    console.log(C.dim(`     ${C.green("(new)")} = added by this release; the rest have been unlisted for longer.`));
  }

  const adopt = has(args, "adopt-new")
    ? true
    : has(args, "no-adopt") || has(args, "yes") || !process.stdin.isTTY
      ? false
      : await askYesNo("  Add them to config.json so they render?", true);
  closePrompts();

  if (!adopt) {
    console.log(C.dim(`     Left as-is. Add them to "roster"/"skills" in ${kitRel}/config.json, or re-run with --adopt-new.`));
    return;
  }

  if (Array.isArray(config.roster)) config.roster = [...config.roster, ...unlistedAgents];
  if (Array.isArray(config.skills)) config.skills = [...config.skills, ...unlistedSkills];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  ${C.green("✓")} added ${unlistedAgents.length + unlistedSkills.length} entry(ies) to ${kitRel}/config.json`);
}

async function update(args) {
  if (has(args, "all")) return updateAll(args);
  // `--kit <dir>` names a vendored kit to refresh — a different job from bringing THIS copy of
  // the kit up to date, so it wins over the clone branch below. It used to be read only after
  // that branch, which meant `update --all` run from a git clone of the kit sent every project
  // through `git pull` on the shared clone, ignored --kit, updated nothing, and still exited 0
  // — a batch that reported "n/n ok" having done none of the work.
  const explicitKit = flag(args, "kit");
  if (!IS_PACKAGED && !explicitKit) {
    if (!isKitClone()) {
      console.error(`✗ This kit copy has no update channel of its own — it was vendored by 'setup'.
  Update it from the registry instead (from your repo root):

    npx @mychiefmind/ai-maestro@latest update`);
      process.exit(2);
    }
    const before = readKitVersion(KIT_ROOT);
    console.log(`→ Pulling the kit clone at ${KIT_ROOT} …`);
    const pull = spawnSync("git", ["-C", KIT_ROOT, "pull", "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) {
      console.error("✗ 'git pull --ff-only' failed — resolve that in the kit clone, then re-run.");
      process.exit(1);
    }
    const after = readKitVersion(KIT_ROOT);
    console.log(before === after ? `✓ Already up to date (v${after}).` : `✓ Kit updated v${before} → v${after}.`);
    if (existsSync(join(KIT_ROOT, "config.json"))) {
      console.log("\n→ Re-rendering agents & skills…");
      if (run("render/sync.mjs", ["--project", KIT_ROOT]) !== 0) process.exit(1);
    } else {
      // A shared kit serves several repos and doesn't know where they are.
      console.log(`  This kit has no project of its own — re-render each repo that uses it:
    node ${join(KIT_ROOT, "render", "sync.mjs")} --project <repo>/maestro`);
    }
    return;
  }

  // Find the vendored kit to refresh. `--kit` wins; then a kit at the cwd (npm run update from
  // inside maestro/); then the default vendoring spot, <cwd>/maestro.
  const cwdIsKit = existsSync(join(process.cwd(), "config.json")) && existsSync(join(process.cwd(), "render", "sync.mjs"));
  const kit = resolve(explicitKit || (cwdIsKit ? process.cwd() : join(process.cwd(), "maestro")));
  const kitRel = relative(process.cwd(), kit) || ".";
  // Refreshing a kit INTO itself would have refreshVendoredKit delete each vendored folder and
  // then copy it from the path it just deleted. Reachable via `--kit .` from a clone, or a
  // registry entry pointing at the kit itself, and it damages the kit rather than failing.
  if (samePath(kit, KIT_ROOT)) {
    console.error(`✗ ${kitRel}/ is this kit itself — 'update' refreshes a kit vendored into a project.
  From a clone of the kit, run 'maestro update' with no --kit to pull it instead.`);
    process.exit(2);
  }
  if (!existsSync(join(kit, "config.json"))) {
    console.error(`✗ No set-up kit at ${kitRel}/ — nothing to update.
  Run 'npx @mychiefmind/ai-maestro setup' first, or point at the kit folder with --kit <dir>.`);
    process.exit(2);
  }

  const before = readKitVersion(kit);
  const target = readKitVersion(KIT_ROOT);
  if (before === target && !has(args, "force")) {
    // "The project matches this CLI" only means "up to date" if the CLI is itself current. A
    // stale npx cache makes those two agree at any age, and this branch then reported a project
    // several releases behind as current — wrong, and reassuring, which is the worst pairing.
    // The neighbouring downgrade branch already told people to run @latest; this one didn't.
    const latest = newerPublishedThan(target, args);
    if (latest) {
      console.error(`✗ ${kitRel}/ is at v${before} and so is this CLI — but v${latest} is published.
  npx reuses whatever it has cached unless you name a version, so this ran an old copy. Re-run:

    npx ${PKG_NAME}@latest update${explicitKit ? ` --kit ${kitRel}` : ""}`);
      process.exit(2);
    }
    console.log(`✓ Already up to date (v${target}).`);
    return;
  }
  if (cmpSemver(target, before) < 0 && !has(args, "force")) {
    console.error(`✗ ${kitRel}/ is at v${before} but this CLI ships v${target} — refusing to downgrade.
  Run the latest CLI ('npx @mychiefmind/ai-maestro@latest update'), or pass --force to downgrade anyway.`);
    process.exit(2);
  }

  console.log(`→ Updating ${kitRel}/ v${before} → v${target} …`);
  // Read BEFORE the refresh overwrites it: this is the only record of what the previous
  // version shipped, and it's what makes "new in this release" distinguishable from
  // "unlisted for the last six releases".
  const preRefreshLock = readVendorLock(kit);
  const rescued = refreshVendoredKit(kit);
  console.log(`  ✓ kit files refreshed — your config.json, context.md, and board data were kept`);
  // Name what moved. The line above used to be the whole report, which read as an all-clear
  // even on updates that had just deleted a project's own agents and skills (T-011).
  if (rescued.length) {
    console.log(`\n  ${C.yellow("↪")} moved ${rescued.length} file(s) of your own into ${kitRel}/${CUSTOM_DIR}/ — they're safe there, and every future update leaves them alone:`);
    for (const r of rescued) console.log(`     ${r.from}  →  ${r.to}   ${C.dim(`(${r.why})`)}`);
    console.log(C.dim(`     custom/ overrides the kit file of the same name, so they keep working as before.`));
  }

  await reconcileRoster(kit, kitRel, args, preRefreshLock);

  console.log("\n→ Re-rendering agents & skills…");
  if (run("render/sync.mjs", ["--project", kit], kit) !== 0) {
    console.error(`✗ Render failed. Fix the errors above, then run 'npm run sync' from ${kitRel}/.`);
    process.exit(1);
  }

  const boardData = join(kit, "board", "data.json");
  if (existsSync(boardData)) {
    console.log("\n→ Checking the board…");
    run("scripts/validate-board.mjs", [boardData, "--agents", join(kit, "agents")], kit);
  }

  console.log(`\n${C.green(C.b(`✅  ${kitRel}/ is on v${target}.`))}`);
}

function help() {
  console.log(`ai-maestro <command>

  setup       Set up AI Maestro in your project — a short questionnaire (start here)
              Asks for your project brief, writes config.json + context.md from the answers,
              runs 'git init' if needed, renders Claude + Codex files, and checks the board.
              Offers to open the visual board at the end (--no-board to skip, --yes to auto-open)
              Answer non-interactively with: --name, --areas, --outcome, --users, --stack,
              --constraints, --run, --test  (anything omitted defaults to "propose one")
  update      Bring a set-up kit to this CLI's version
              Refreshes the kit files in maestro/ and re-renders Claude + Codex targets; your config.json,
              context.md, board data, and anything in maestro/custom/ are kept. Run it through
              the latest package: 'npx @mychiefmind/ai-maestro@latest update' (or 'npm run
              update' from maestro/). On a git clone of the kit it pulls and re-renders instead.
              --all --registry <file> updates every project in a registry, each isolated so one
              failure doesn't stop the batch; --dry-run reports what would change.
              Lists any agent/skill the kit ships that your config.json doesn't name (those are
              not rendered) and offers to add them: --adopt-new adds without asking, --no-adopt
              reports and leaves them out.
              If the project already matches this CLI, it checks that the CLI is itself current
              before saying so — npx runs a cached copy unless you name a version, and a stale
              one would otherwise call a months-old project up to date. --offline skips it.
  sync        Re-render Claude + Codex targets from config.json + context.md
              --all --registry <file> renders every project in a registry (same format as
              'drift', below), one subprocess each, so one broken project can't abort the rest.
  validate    Check the board's integrity
  ticket      Change the board safely — add | import | set-status | set-routing | retrace | archive | drop
              The only supported way to write a board: locked, validated and atomic, so two
              writers can't silently overwrite each other. 'import' bulk-adds a whole planned
              board in one write and only ever ADDS — an existing id is an error, never an
              overwrite. Run 'maestro ticket --help' for the full list.
  run         Run a cross-review-enabled ticket: dev → PR → reviewer
              A triggered, one-shot pipeline, not a daemon — checks the ticket is eligible
              (todo, no human_gate, deps done, in scope), then runs the dev role in its own
              git worktree (never your primary checkout) under its chosen runtime/model. A
              reviewer (its own runtime/model) then reviews the PR and takes one real
              'gh pr review' action, verified from GitHub's own review history, not the
              agent's say-so. Never merges without --auto-merge. Needs dev_runtime/
              reviewer_runtime on the ticket or config.json's crossReview.
              Run 'maestro run --help' for the headless-permissions flags it requires.
  lanes       What can safely run in parallel — plan | next | check
              A lane is a worktree running a QUEUE of tickets one at a time. Two tickets go in
              different lanes only when nothing suggests they touch the same files. Pool size
              is config.orchestration.maxWorktrees (default 3, ceiling 5).
  plan        The project plan every ticket is scoped against — status | questions | add | ...
              'maestro plan status' prints how complete the plan is and what's still thin;
              'coverage' shows which requirements no ticket is working. Written under the same
              lock as the board. Run 'maestro plan --help' for ops.
  drift       Report version + hand-edit drift across a registry of projects
              Needs a registry file (default ./maestro-registry.json): { "projects": [
              { "name": "...", "path": "..." } ] }. --offline skips the npm version check;
              --strict exits 1 if anything needs attention (for CI).
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
  { key: "update", label: "Bring a set-up kit to this CLI's version" },
  { key: "sync", label: "Re-render Claude + Codex files from config.json + context.md" },
  { key: "validate", label: "Check the board's integrity" },
  { key: "ticket", label: "Change the board safely (add | import | set-status | set-routing | archive)" },
  { key: "plan", label: "The project plan and its completeness (status | questions | add)" },
  { key: "run", label: "Run a cross-review-enabled ticket: dev → PR → reviewer" },
  { key: "lanes", label: "What can safely run in parallel (plan | next | check)" },
  { key: "drift", label: "Report version + hand-edit drift across a registry of projects" },
  { key: "init", label: "Set up as a small capsule pointing at a kit elsewhere" },
];

async function dispatch(command, args) {
  switch (command) {
    case "setup": await setup(args); break;
    case "update": await update(args); break;
    case "init": await init(args); break;
    case "sync": process.exit(run("render/sync.mjs", args)); break;
    case "validate": process.exit(run("scripts/validate-board.mjs", args)); break;
    case "ticket": process.exit(run("scripts/board-write.mjs", args)); break;
    case "plan": process.exit(run("scripts/plan-write.mjs", args)); break;
    case "run": process.exit(run("scripts/run-ticket.mjs", args)); break;
    case "lanes": process.exit(run("scripts/lane-plan.mjs", args)); break;
    case "drift": process.exit(run("scripts/maestro-drift.mjs", args)); break;
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
