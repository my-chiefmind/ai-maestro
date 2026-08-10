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
import { cpSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Everything setup/update need; cockpit and docs are left out to keep the copy fast — the
// VENDORED loop skips entries the package doesn't have.
const PKG_ENTRIES = ["agents", "skills", "render", "scripts", "board", "starters", "bin", "VERSION"];

let tmp, pkgDir, projDir, kitDir;
// --offline by default on `update`: the command asks npm whether this CLI is itself stale, and
// a suite that reached the network would go red the day the next version is published. The
// check gets its own test below, against a stubbed npm rather than the real registry.
const cli = (args, opts = {}) =>
  execFileSync(process.execPath, [join(pkgDir, "bin", "cli.mjs"), ...(args[0] === "update" ? [...args, "--offline"] : args)], {
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

test("update won't call a project up to date when the CLI itself is stale", () => {
  // The npx-cache trap: `npx <pkg>` with no @latest reuses whatever is cached, so the CLI and
  // the project can agree at v9.9.9 while the registry has long moved past it. The old code
  // compared only those two and printed a confident "up to date" — the failure this pins.
  // A fake `npm` first on PATH stands in for the registry, so no network is involved.
  const stubBin = join(tmp, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  const npmStub = join(stubBin, "npm");
  writeFileSync(npmStub, '#!/bin/sh\n[ "$1" = view ] && echo 9.9.10\n');
  chmodSync(npmStub, 0o755);
  const withStub = { env: { ...process.env, NO_COLOR: "1", PATH: `${stubBin}:${process.env.PATH}` } };
  // Bypasses the helper's default --offline on purpose — this is the online path.
  const online = (args, opts = {}) =>
    execFileSync(process.execPath, [join(pkgDir, "bin", "cli.mjs"), ...args], {
      cwd: projDir, encoding: "utf8", ...withStub, ...opts,
    });

  assert.throws(() => online(["update"], { stdio: "pipe" }), /v9\.9\.10 is published/);
  // And it names the way out rather than just refusing.
  assert.throws(() => online(["update"], { stdio: "pipe" }), /@latest update/);

  // --offline opts back out: no lookup, the plain message, exit 0.
  assert.match(online(["update", "--offline"]), /Already up to date \(v9\.9\.9\)/);

  // A CLI that is current says so — same stub, but nothing newer than what it ships.
  writeFileSync(npmStub, '#!/bin/sh\n[ "$1" = view ] && echo 9.9.9\n');
  assert.match(online(["update"]), /Already up to date \(v9\.9\.9\)/);

  // npm unreachable is "unknown", never a failure — updating must not require the network.
  writeFileSync(npmStub, "#!/bin/sh\nexit 1\n");
  assert.match(online(["update"]), /Already up to date \(v9\.9\.9\)/);
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

test("update never deletes a project's own board/ workspace folders (T-001)", () => {
  // A folder the project created for itself under board/ — the starter README documents
  // specs/ and reports/ as exactly this. Never shipped by the kit, so it must survive
  // regardless of whether anything with that name exists upstream.
  const evidenceDir = join(kitDir, "board", "evidence");
  mkdirSync(evidenceDir);
  writeFileSync(join(evidenceDir, "notes.md"), "user's own notes\n");
  const specsDir = join(kitDir, "board", "specs");
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(join(specsDir, "T-001.md"), "the project's own ticket detail\n");

  writeFileSync(join(pkgDir, "VERSION"), "9.9.10\n");
  cli(["update"]);

  assert.equal(readFileSync(join(evidenceDir, "notes.md"), "utf8"), "user's own notes\n");
  assert.equal(readFileSync(join(specsDir, "T-001.md"), "utf8"), "the project's own ticket detail\n");
});

test("update never seeds a project's board with the kit's own specs/reports", () => {
  // The kit repo's own board/specs holds ITS maintenance tickets (T-003, T-004, ...), not
  // example content — update must never copy those into a project's board, even though the
  // project now has a specs/ dir of its own (created in the previous test).
  assert.ok(!existsSync(join(kitDir, "board", "specs", "T-003.md")), "kit's own spec should not have been seeded");
  assert.ok(!existsSync(join(kitDir, "board", "reports")), "reports/ should not have been seeded");
});

test("update keeps a hand-edited board/README.md, not just this once but every run after", () => {
  const readmePath = join(kitDir, "board", "README.md");
  const edited = readFileSync(readmePath, "utf8") + "\n<!-- our own notes -->\n";
  writeFileSync(readmePath, edited);

  writeFileSync(join(pkgDir, "VERSION"), "9.9.11\n");
  cli(["update"]);
  assert.equal(readFileSync(readmePath, "utf8"), edited, "edit should survive the first update after it was made");

  writeFileSync(join(pkgDir, "VERSION"), "9.9.12\n");
  cli(["update"]);
  assert.equal(readFileSync(readmePath, "utf8"), edited, "edit should still survive a second, later update");
});
