/**
 * Tests for T-014: `maestro update --all --registry <file>`.
 *
 * WHY THIS EXISTS: a registry already told `sync --all` and `maestro drift` where every project
 * is, but `update` took exactly one kit dir. With a portfolio, every kit release meant a manual
 * pass over every repo — which is how installs drift versions apart and how a bad release is
 * found late.
 *
 * The two properties that matter are isolation (one broken project must not abort the batch,
 * and must still be reported) and honesty about what was skipped versus what failed: a repo
 * that hasn't adopted the kit is not a failure, and a parked one is not even looked at.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, pkgDir, cliPath, registryPath;
const proj = (name) => join(tmp, name);

const run = (args) => {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-update-all-"));
  pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  cliPath = join(pkgDir, "bin", "cli.mjs");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });

  for (const name of ["one", "two"]) {
    mkdirSync(proj(name), { recursive: true });
    execFileSync(process.execPath, [cliPath, "setup", "--yes", "--no-board", "--name", name], {
      cwd: proj(name),
      stdio: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
  }
  mkdirSync(proj("never-adopted"), { recursive: true });
  mkdirSync(proj("shelved"), { recursive: true });

  registryPath = join(tmp, "maestro-registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      projects: [
        { name: "one", path: proj("one") },
        { name: "two", path: proj("two") },
        { name: "never", path: proj("never-adopted") },
        { name: "shelved", path: proj("shelved"), status: "parked" },
      ],
    })
  );
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("--dry-run reports without writing, and never looks at a parked project", () => {
  const before = readFileSync(join(proj("one"), "maestro", "VERSION"), "utf8");
  const { code, out } = run(["update", "--all", "--registry", registryPath, "--dry-run"]);

  assert.equal(code, 0);
  assert.match(out, /dry run — nothing will be written/);
  assert.match(out, /Updating 3 project\(s\)/, "the parked project must not be counted");
  assert.doesNotMatch(out, /shelved/, "a parked project is not swept at all");
  assert.equal(readFileSync(join(proj("one"), "maestro", "VERSION"), "utf8"), before, "dry run must not write");
});

test("a project that never adopted the kit is skipped, not counted as a failure", () => {
  const { code, out } = run(["update", "--all", "--registry", registryPath, "--dry-run"]);
  assert.equal(code, 0, "a not-set-up repo must not make the batch fail");
  assert.match(out, /never: not set up — skipped/);
  assert.match(out, /1 not set up/);
});

test("one broken project is reported but does not abort the batch", () => {
  // A project's own agent, to prove the batch still honours the custom/ contract (T-011).
  const customDir = join(proj("one"), "maestro", "custom", "agents");
  mkdirSync(customDir, { recursive: true });
  writeFileSync(join(customDir, "house.md"), "---\nname: house\ndescription: ours\n---\n# House\n");
  writeFileSync(join(proj("two"), "maestro", "config.json"), "{ broken json");

  const { code, out } = run(["update", "--all", "--registry", registryPath, "--force"]);

  assert.equal(code, 1, "the exit code must reflect that something failed");
  assert.match(out, /two: update failed/);
  assert.match(out, /1 failed/);
  // ...and the healthy project was still updated, with its own agent intact.
  assert.ok(existsSync(join(customDir, "house.md")), "a batch update must not eat customisations");
  assert.ok(existsSync(join(proj("one"), ".claude", "agents", "house.md")), "and must re-render them");
});

test("a missing or malformed registry fails loudly rather than reporting zero projects", () => {
  const missing = run(["update", "--all", "--registry", join(tmp, "nope.json")]);
  assert.equal(missing.code, 2);
  assert.match(missing.out, /No registry at/);

  const badPath = join(tmp, "bad-registry.json");
  writeFileSync(badPath, "{ not json");
  const bad = run(["update", "--all", "--registry", badPath]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /not valid JSON/);
});

test("a registry with no active projects is an error, not a silent success", () => {
  const emptyPath = join(tmp, "all-parked.json");
  writeFileSync(
    emptyPath,
    JSON.stringify({ projects: [{ name: "p", path: proj("shelved"), status: "parked" }] })
  );
  const { code, out } = run(["update", "--all", "--registry", emptyPath]);
  assert.equal(code, 2);
  assert.match(out, /lists no active projects/);
});

test("run from a git clone of the kit, the batch updates the projects — it does not pull the clone", () => {
  // The batch spawns `cli.mjs update --kit <project>` per project. `update` decides between
  // "refresh a vendored kit" and "pull my own clone" on IS_PACKAGED, and IS_PACKAGED is false
  // for a clone — so every child took the clone branch, ran `git pull --ff-only` on the SHARED
  // clone, ignored --kit, exited 0, and the batch reported n/n ok having updated nothing.
  // Real paths, so KIT_ROOT matches `git rev-parse --show-toplevel` and the clone branch is
  // genuinely reachable — otherwise this passes for the wrong reason.
  const clone = join(realpathSync(tmp), "kit-clone");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) cpSync(join(KIT, entry), join(clone, entry), { recursive: true, filter });
  execFileSync("git", ["init", "-q", clone], { stdio: "pipe" });

  const target = join(tmp, "clone-target");
  mkdirSync(target, { recursive: true });
  execFileSync(process.execPath, [cliPath, "setup", "--yes", "--no-board", "--name", "clone-target"], {
    cwd: target,
    stdio: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const reg = join(tmp, "clone-registry.json");
  writeFileSync(reg, JSON.stringify({ projects: [{ name: "clone-target", path: target }] }));

  const r = spawnSync(process.execPath, [join(clone, "bin", "cli.mjs"), "update", "--all", "--registry", reg, "--force"], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");

  assert.doesNotMatch(out, /Pulling the kit clone/, "--kit names a project's kit; it must not pull the clone");
  assert.doesNotMatch(out, /no update channel of its own/);
  assert.match(out, /clone-target/);
  assert.match(out, /is on v/, "the project must actually be refreshed");
  assert.equal(r.status, 0);
});

test("a kit may not be refreshed into itself", () => {
  // `--kit .` from a clone, or a registry entry pointing at the kit: refreshVendoredKit would
  // delete each vendored folder and then copy it from the path it had just deleted.
  const { code, out } = run(["update", "--kit", pkgDir]);
  assert.equal(code, 2);
  assert.match(out, /is this kit itself/);
});
