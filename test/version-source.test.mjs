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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  // Simulated rather than mutated on disk: the point is that a mismatch exits non-zero.
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "-e",
          `const {execFileSync}=require("child_process");
           const fs=require("fs"),p=${JSON.stringify(join(KIT, "VERSION"))};
           const orig=fs.readFileSync(p,"utf8");
           fs.writeFileSync(p,"0.0.0-drift\\n");
           try { execFileSync(process.execPath,[${JSON.stringify(join(KIT, "scripts", "sync-version.mjs"))},"--check"],{stdio:"pipe"}); }
           finally { fs.writeFileSync(p,orig); }`,
        ],
        { stdio: "pipe" },
      ),
    /Command failed/,
  );
});
