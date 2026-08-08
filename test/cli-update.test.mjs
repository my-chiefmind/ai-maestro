/**
 * Integration tests for `maestro update` — bringing a vendored kit up to the CLI's version.
 *
 * WHY THIS EXISTS: `setup` from an npm/npx install vendors a full kit copy into
 * <repo>/maestro/ and nothing reads the node_modules copy again — so before `update`,
 * npm-installed users had no path to a newer kit at all (`npm update` refreshed a folder
 * nobody used). These tests pin the command's two contracts: the kit's own files move to
 * the new version (including deletions upstream), and the user's files — config.json,
 * context.md, board data.json/archive.json — survive untouched.
 *
 * The npm install is simulated by copying the kit under a node_modules/ path, which is
 * exactly what flips IS_PACKAGED in bin/cli.mjs.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Everything setup/update need; cockpit and docs are left out to keep the copy fast — the
// VENDORED loop skips entries the package doesn't have.
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, pkgDir, projDir, kitDir;
const cli = (args, opts = {}) =>
  execFileSync(process.execPath, [join(pkgDir, "bin", "cli.mjs"), ...args], {
    cwd: projDir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...opts,
  });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-update-"));
  pkgDir = join(tmp, "node_modules", "@mychiefmind", "ai-maestro");
  const filter = (src) => !["node_modules", "dist", ".backups", ".git"].includes(basename(src));
  for (const entry of PKG_ENTRIES) {
    cpSync(join(KIT, entry), join(pkgDir, entry), { recursive: true, filter });
  }
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  kitDir = join(projDir, "maestro");
  cli(["setup", "--yes", "--no-board"]);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("update refreshes kit files, keeps user files, re-renders", () => {
  // The user's live state: a board that differs from the shipped example, an edited brief.
  const dataPath = join(kitDir, "board", "data.json");
  const userBoard = readFileSync(dataPath, "utf8") + "\n";
  writeFileSync(dataPath, userBoard);
  const contextPath = join(kitDir, "context.md");
  const userContext = readFileSync(contextPath, "utf8") + "\n<!-- user edit -->\n";
  writeFileSync(contextPath, userContext);
  const userConfig = readFileSync(join(kitDir, "config.json"), "utf8");

  // A "new release" in the registry copy: version bump, a new script, a removed starter.
  writeFileSync(join(pkgDir, "VERSION"), "9.9.9\n");
  writeFileSync(join(pkgDir, "scripts", "new-tool.mjs"), "// added in 9.9.9\n");
  rmSync(join(pkgDir, "starters", "lightweight-project"), { recursive: true });

  const out = cli(["update"]);
  assert.match(out, /v\d+\.\d+\.\d+ → v9\.9\.9/);

  // Kit files moved — additions arrive, deletions vanish, VERSION advances.
  assert.equal(readFileSync(join(kitDir, "VERSION"), "utf8").trim(), "9.9.9");
  assert.ok(existsSync(join(kitDir, "scripts", "new-tool.mjs")), "new kit file should be vendored in");
  assert.ok(!existsSync(join(kitDir, "starters", "lightweight-project")), "upstream deletion should propagate");

  // User files survived byte-for-byte.
  assert.equal(readFileSync(dataPath, "utf8"), userBoard);
  assert.equal(readFileSync(contextPath, "utf8"), userContext);
  assert.equal(readFileSync(join(kitDir, "config.json"), "utf8"), userConfig);

  // The re-render stamped the new version into the generated output at the repo root.
  assert.match(readFileSync(join(projDir, "CLAUDE.md"), "utf8"), /9\.9\.9/);
});

test("update is idempotent — a second run reports up to date", () => {
  const out = cli(["update"]);
  assert.match(out, /Already up to date \(v9\.9\.9\)/);
});

test("update refuses to downgrade without --force", () => {
  writeFileSync(join(pkgDir, "VERSION"), "0.0.1\n");
  assert.throws(() => cli(["update"], { stdio: "pipe" }), /refusing to downgrade/);
  writeFileSync(join(pkgDir, "VERSION"), "9.9.9\n");
});

test("update from inside the vendored copy points at the registry", () => {
  // `node maestro/bin/cli.mjs update` — not packaged, not a clone of the kit repo (it sits
  // inside the *project's* git repo). It must not pull the project's repo; it should say how
  // to update properly.
  assert.throws(
    () => execFileSync(process.execPath, [join(kitDir, "bin", "cli.mjs"), "update"], {
      cwd: projDir, encoding: "utf8", stdio: "pipe",
    }),
    /npx @mychiefmind\/ai-maestro@latest update/,
  );
});

test("update errors clearly when nothing is set up", () => {
  const empty = join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  assert.throws(() => cli(["update"], { cwd: empty, stdio: "pipe" }), /nothing to update/);
});
