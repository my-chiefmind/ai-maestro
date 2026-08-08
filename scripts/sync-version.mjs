#!/usr/bin/env node
/**
 * sync-version.mjs — make package.json the single source of the kit's version.
 *
 * WHY THIS EXISTS: the version lived in two places that could drift, and did.
 * `package.json` is what npm publishes and what an installed dependency records, while
 * the plain `VERSION` file is what `render/sync.mjs` stamps into every generated project
 * file as {{KIT_VERSION}}. On 2026-08-07 they disagreed three ways at once — npm had
 * 0.1.14, the committed VERSION said 0.1.15, and the working tree said 0.1.17 — so a
 * generated project could claim a kit version that was never published.
 *
 * VERSION cannot simply be deleted: `bin/cli.mjs` vendors a subset of the kit (VENDORED)
 * that includes VERSION but NOT package.json, so a vendored copy has no other way to know
 * what it is.
 *
 * So package.json wins, and this script propagates it. It runs from npm's `version`
 * lifecycle, which fires between the package.json bump and the release commit, so
 * `npm version patch` keeps the two in lock-step automatically. `npm test` asserts they
 * match, which turns a silent drift into a red test.
 *
 * Usage:
 *   node scripts/sync-version.mjs           # rewrite VERSION from package.json
 *   node scripts/sync-version.mjs --check   # exit 1 if they disagree, write nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).version;
const versionFile = join(KIT, "VERSION");
const current = readFileSync(versionFile, "utf8").trim();

if (process.argv.includes("--check")) {
  if (current !== pkgVersion) {
    console.error(
      `✗ version drift: package.json is ${pkgVersion}, VERSION is ${current}.\n` +
        `  Fix with: node scripts/sync-version.mjs`,
    );
    process.exit(1);
  }
  console.log(`✓ version ${pkgVersion} (package.json === VERSION)`);
  process.exit(0);
}

if (current === pkgVersion) {
  console.log(`✓ VERSION already ${pkgVersion}`);
} else {
  writeFileSync(versionFile, `${pkgVersion}\n`);
  console.log(`✓ VERSION ${current} → ${pkgVersion} (from package.json)`);
}
