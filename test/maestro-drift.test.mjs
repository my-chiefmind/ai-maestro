/**
 * Tests for scripts/maestro-drift.mjs — the cross-project drift report (T-002).
 *
 * Builds a small registry of three fixture projects (clean, hand-edited, never set up) via
 * real `maestro setup` runs (packaged, same technique as test/cli-update.test.mjs), then
 * checks the report calls each one correctly and --strict exits non-zero exactly when
 * something needs attention.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, registryPath;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-drift-"));
  const pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) {
    cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });
  }
  const pkgCli = join(pkgDir, "bin", "cli.mjs");
  const runSetup = (dir) =>
    execFileSync(process.execPath, [pkgCli, "setup", "--yes", "--no-board"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    });

  const clean = join(tmp, "clean-proj");
  mkdirSync(clean);
  runSetup(clean);

  const drifted = join(tmp, "drifted-proj");
  mkdirSync(drifted);
  runSetup(drifted);
  const agentPath = join(drifted, ".claude", "agents", "backend-developer.md");
  writeFileSync(agentPath, readFileSync(agentPath, "utf8") + "\n<!-- hand edit -->\n");

  const notSetup = join(tmp, "not-setup-proj");
  mkdirSync(notSetup);

  registryPath = join(tmp, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    projects: [
      { name: "clean-proj", path: clean },
      { name: "drifted-proj", path: drifted },
      { name: "not-setup-proj", path: notSetup },
    ],
  }));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const drift = (extraArgs = []) =>
  execFileSync(process.execPath, [join(KIT, "scripts", "maestro-drift.mjs"), "--registry", registryPath, "--offline", ...extraArgs], {
    encoding: "utf8",
  });

test("reports a clean project as clean", () => {
  const out = drift();
  assert.match(out, /clean-proj\s+v[\d.]+\s+✓ clean/);
});

test("reports the hand-edited project as drifted, naming the file", () => {
  const out = drift();
  assert.match(out, /drifted-proj\s+v[\d.]+\s+✗ drifted/);
  assert.match(out, /backend-developer\.md/);
});

test("reports the never-set-up project as not set up, without crashing the whole run", () => {
  const out = drift();
  assert.match(out, /not-setup-proj\s+—\s+— not set up/);
});

test("exits 0 by default even with issues present, 1 under --strict", () => {
  assert.doesNotThrow(() => drift());
  assert.throws(() => drift(["--strict"]));
});

test("a missing registry file fails loudly with a usage hint, not a stack trace", () => {
  assert.throws(
    () => execFileSync(process.execPath, [join(KIT, "scripts", "maestro-drift.mjs"), "--registry", join(tmp, "nope.json")], { encoding: "utf8", stdio: "pipe" }),
    /No registry at/,
  );
});
