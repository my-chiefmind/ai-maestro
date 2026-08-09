/**
 * Tests that the kit has exactly ONE authoritative version.
 *
 * WHY THIS EXISTS: the version lives in package.json (what npm publishes and what an
 * installed dependency records) and in the plain VERSION file (what render/sync.mjs
 * stamps into every generated project file as {{KIT_VERSION}}). On 2026-08-07 those
 * disagreed three ways at once — npm 0.1.14, committed VERSION 0.1.15, working-tree
 * VERSION 0.1.17 — which meant a generated project could advertise a kit version that was
 * never published, and no test noticed.
 *
 * VERSION can't just be removed: bin/cli.mjs's VENDORED list copies VERSION but not
 * package.json, so a vendored kit has no other way to identify itself. So package.json is
 * the source and scripts/sync-version.mjs propagates it from npm's `version` lifecycle.
 * These tests make a drift loud instead of silent.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8"));
const versionFile = readFileSync(join(KIT, "VERSION"), "utf8").trim();

test("VERSION matches package.json — the two must never drift", () => {
  assert.equal(
    versionFile,
    pkg.version,
    "VERSION and package.json disagree. Run: node scripts/sync-version.mjs",
  );
});

test("VERSION is a bare semver, since sync.mjs stamps it verbatim into generated files", () => {
  assert.match(versionFile, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test("the `version` lifecycle script keeps VERSION in step with an npm bump", () => {
  // Without this wiring, `npm version patch` bumps package.json alone and the drift
  // silently returns on the very next release.
  assert.ok(pkg.scripts?.version, "package.json needs a `version` lifecycle script");
  assert.match(pkg.scripts.version, /sync-version\.mjs/);
});

test("--check passes against the committed tree", () => {
  const out = execFileSync(process.execPath, [join(KIT, "scripts", "sync-version.mjs"), "--check"], {
    encoding: "utf8",
  });
  assert.match(out, /package\.json === VERSION/);
});

test("--check fails loudly when they disagree", () => {
  // Run against a THROWAWAY copy of the kit, never the real one. This used to write
  // "0.0.0-drift" into the repo's own VERSION and restore it in a finally — but `npm test`
  // runs test files in parallel, and render/sync.mjs stamps VERSION into everything it
  // generates. Any render test that happened to run inside that window baked a bogus kit
  // version into its output, or straddled the restore and disagreed with its own lock. That
  // made several suites intermittently red for reasons nothing in them explained.
  const dir = mkdtempSync(join(tmpdir(), "maestro-version-"));
  try {
    mkdirSync(join(dir, "scripts"));
    cpSync(join(KIT, "scripts", "sync-version.mjs"), join(dir, "scripts", "sync-version.mjs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const run = (args = []) =>
      execFileSync(process.execPath, [join(dir, "scripts", "sync-version.mjs"), ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });

    writeFileSync(join(dir, "VERSION"), "0.0.0-drift\n");
    assert.throws(() => run(["--check"]), /Command failed/, "a mismatch must exit non-zero");

    // ...and the non-check run repairs it, which is what npm's `version` lifecycle relies on.
    run();
    assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "1.2.3");
    assert.match(run(["--check"]), /package\.json === VERSION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
