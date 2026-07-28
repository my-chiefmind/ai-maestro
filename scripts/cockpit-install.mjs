#!/usr/bin/env node
/**
 * cockpit-install.mjs — install the cockpit UI's dependencies, deterministically.
 *
 * Usage:
 *   node scripts/cockpit-install.mjs            (run for you by the `preboard` hook)
 *   node scripts/cockpit-install.mjs --force    (reinstall even if node_modules exists)
 *
 * WHY THIS FILE EXISTS: this used to be an inline `node -e "...execSync('npm install
 * --no-audit')..."` in package.json. That form was flagged by supply-chain scanners and
 * was genuinely worse in one respect — `npm install` re-resolves semver ranges, so the
 * dependency set the cockpit ran on was not the one pinned in cockpit/package-lock.json.
 *
 * The guarantees this script makes, and the reasons for them:
 *
 *   1. It NEVER runs at package-install time. There is no preinstall/postinstall/prepare
 *      hook in this package; `npm i @mychiefmind/ai-maestro` executes nothing. This runs
 *      only via `preboard`, i.e. only when someone explicitly asks to start the board.
 *   2. It is idempotent and does nothing if cockpit/node_modules already exists.
 *   3. It uses `npm ci`, not `npm install` — installs exactly the committed lockfile and
 *      fails loudly if the lockfile is missing or has drifted from package.json.
 *   4. It shells out with execFileSync + an argument array. Every argument is a literal
 *      in this file; no board content, config value, filename, or environment value ever
 *      reaches the command line.
 *
 * We do NOT pass --ignore-scripts: the cockpit's toolchain (vite → esbuild) links a
 * platform-specific binary in a postinstall script, so the UI cannot build without them.
 * We do NOT pass --no-audit: npm's audit output is advisory and never gated anything, so
 * suppressing it bought no safety and only hid information.
 *
 * No third-party dependencies.
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COCKPIT = join(KIT_ROOT, "cockpit");

// npm is npm.cmd on Windows, which CreateProcess cannot launch directly — that platform
// needs the shell. Safe here only because every argument below is a literal constant;
// keep it that way, and never interpolate a caller-supplied value into ARGS.
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
const ARGS = ["ci", "--no-fund"];

function main() {
  if (!existsSync(COCKPIT)) {
    // A kit vendored without the optional UI. Nothing to install; `board` will explain.
    return 0;
  }
  // `--force` is how the explicit `npm run cockpit:install` re-syncs an existing tree; the
  // implicit `preboard` path never passes it, so starting the board can't silently reinstall.
  const force = process.argv.slice(2).includes("--force");
  if (!force && existsSync(join(COCKPIT, "node_modules"))) {
    return 0; // Already installed — this hook is a first-run convenience, not a sync step.
  }
  if (!existsSync(join(COCKPIT, "package-lock.json"))) {
    console.error(
      "✗ cockpit/package-lock.json is missing, so the UI's dependencies cannot be\n" +
      "  installed reproducibly. Refusing to fall back to an unpinned `npm install`.\n" +
      "  Reinstall @mychiefmind/ai-maestro, or run `npm install` in cockpit/ yourself\n" +
      "  if you accept an unpinned dependency set."
    );
    return 1;
  }

  console.log("→ Installing the cockpit UI's dependencies from its lockfile (first run only)…");
  try {
    execFileSync(NPM, ARGS, { cwd: COCKPIT, stdio: "inherit", shell: IS_WIN });
  } catch {
    console.error(
      "\n✗ Couldn't install the cockpit's dependencies.\n" +
      "  Run `npm ci` in the cockpit/ folder to see the full error."
    );
    return 1;
  }
  return 0;
}

process.exit(main());
