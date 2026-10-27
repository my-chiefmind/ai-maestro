/**
 * `maestro update` on a vendored kit: local edits to kit files survive (3-way merge), the
 * vendored CLI can update without --kit, and a broken kitSource.path is repaired.
 * Run: node --test test/
 *
 * Each test builds two fake npm installs of the kit (an "old" and a "new" release, under a
 * node_modules path so the CLI runs in packaged mode), sets a project up from the old one and
 * updates it from the new one. Everything is offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", "node_modules", "test", ".backups", ".claude"]);

const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** A packaged copy of this kit at <root>/<name>/node_modules/@mychiefmind/ai-maestro. */
function release(root, name, version, demo) {
  const dir = join(root, name, "node_modules", "@mychiefmind", "ai-maestro");
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(KIT, dir, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  if (demo != null) writeFileSync(join(dir, "scripts", "zz-demo.mjs"), demo);
  return dir;
}

const run = (cli, cwd, ...args) => spawnSync(process.execPath, [join(cli, "bin", "cli.mjs"), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/** A project set up from an "old" release; returns paths and an `update` helper. */
function project({ demo = lines(20) } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-update-")));
  const old = release(root, "old", "0.6.19", demo);
  const app = join(root, "app");
  mkdirSync(app);
  const setup = run(old, app, "setup", "--yes", "--no-board", "--name", "app");
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  const kit = join(app, "maestro");
  assert.ok(existsSync(join(kit, "scripts", "zz-demo.mjs")));
  // Like a real project: the vendored kit is committed, so git history holds each kit file as
  // it was vendored (the merge base for a first local edit).
  for (const args of [["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "maestro setup"]]) {
    const g = spawnSync("git", ["-C", app, ...args], { encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
  }
  return { root, old, app, kit, demo: join(kit, "scripts", "zz-demo.mjs") };
}

test("update: an unedited kit file takes the new release", () => {
  const p = project();
  const next = release(p.root, "new", "0.6.20", lines(20, { 19: "line 19 (kit v0.6.20)" }));
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 19: "line 19 (kit v0.6.20)" }));
  assert.equal(readFileSync(join(p.kit, "VERSION"), "utf8").trim(), "0.6.20");
  assert.ok(!existsSync(join(p.kit, ".maestro-vendor-base")), "no base copies when nothing is edited");
});

test("update: a locally edited kit script is merged, not overwritten — twice in a row", () => {
  const p = project();
  writeFileSync(p.demo, lines(20, { 2: "line 2 (project patch)" }));
  const next = release(p.root, "new", "0.6.20", lines(20, { 19: "line 19 (kit v0.6.20)" }));
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /kept your edits to 1 kit file/);
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 2: "line 2 (project patch)", 19: "line 19 (kit v0.6.20)" }));
  // The pristine release copy is the next update's merge base.
  assert.equal(readFileSync(join(p.kit, ".maestro-vendor-base", "files", "scripts", "zz-demo.mjs"), "utf8"), lines(20, { 19: "line 19 (kit v0.6.20)" }));

  const after = release(p.root, "newer", "0.6.21", lines(20, { 10: "line 10 (kit v0.6.21)", 19: "line 19 (kit v0.6.20)" }));
  const r2 = run(after, p.app, "update", "--offline", "--yes");
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 2: "line 2 (project patch)", 10: "line 10 (kit v0.6.21)", 19: "line 19 (kit v0.6.20)" }));
});

test("update: a conflicting edit stops with markers and a report; a re-run after resolving finishes", () => {
  const p = project();
  writeFileSync(p.demo, lines(20, { 5: "line 5 (project)" }));
  const next = release(p.root, "new", "0.6.20", lines(20, { 5: "line 5 (kit)" }));
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /conflict with v0\.6\.20/);
  assert.match(r.stderr, /maestro\/scripts\/zz-demo\.mjs/);
  const text = readFileSync(p.demo, "utf8");
  assert.match(text, /^<<<<<<< local$/m);
  assert.match(text, /^>>>>>>> kit v0\.6\.20$/m);
  assert.ok(existsSync(join(p.kit, ".maestro-update-pending")));

  // Unresolved: a re-run still refuses.
  const again = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(again.status, 1, again.stdout);

  writeFileSync(p.demo, lines(20, { 5: "line 5 (project and kit)" }));
  const done = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 5: "line 5 (project and kit)" }));
  assert.ok(!existsSync(join(p.kit, ".maestro-update-pending")));
});

test("update: from a lock without file hashes (<= 0.6.19), --base supplies the merge base", () => {
  const p = project();
  const lockPath = join(p.kit, ".maestro-vendor.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  delete lock.files; delete lock.kitVersion;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  writeFileSync(p.demo, lines(20, { 2: "line 2 (project patch)" }));
  const next = release(p.root, "new", "0.6.20", lines(20, { 19: "line 19 (kit)" }));
  const r = run(next, p.app, "update", "--offline", "--yes", "--base", p.old);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 2: "line 2 (project patch)", 19: "line 19 (kit)" }));
});

test("update: with no record of the previous release, a differing file is kept in custom/rescued", () => {
  const p = project();
  const lockPath = join(p.kit, ".maestro-vendor.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  delete lock.files;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  writeFileSync(p.demo, lines(20, { 2: "line 2 (project patch)" }));
  const next = release(p.root, "new", "0.6.20", lines(20, { 19: "line 19 (kit)" }));
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /custom\/rescued\/scripts\/zz-demo\.mjs/);
  assert.equal(readFileSync(join(p.kit, "custom", "rescued", "scripts", "zz-demo.mjs"), "utf8"), lines(20, { 2: "line 2 (project patch)" }));
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 19: "line 19 (kit)" }));
});

test("update: a project's own file in a kit folder is left alone; a dropped unedited kit file goes", () => {
  const p = project();
  writeFileSync(join(p.kit, "scripts", "my-own.mjs"), "// ours\n");
  const next = release(p.root, "new", "0.6.20", null); // the new release no longer ships zz-demo.mjs
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(p.kit, "scripts", "my-own.mjs"), "utf8"), "// ours\n");
  assert.ok(!existsSync(p.demo));
});

test("update: an edited kit file the release dropped is rescued, not deleted", () => {
  const p = project();
  writeFileSync(p.demo, lines(20, { 2: "patched" }));
  const next = release(p.root, "new", "0.6.20", null);
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(p.kit, "custom", "rescued", "scripts", "zz-demo.mjs"), "utf8"), lines(20, { 2: "patched" }));
});

test("update: a kitSource.path that names no kit is rewritten to the vendored kit", () => {
  const p = project();
  const configPath = join(p.kit, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.kitSource = { path: "../node_modules/@mychiefmind/ai-maestro" };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  // render/sync falls back to the vendored kit (with a warning) instead of failing.
  const sync = spawnSync(process.execPath, [join(p.kit, "render", "sync.mjs"), "--project", p.kit], { cwd: p.app, encoding: "utf8" });
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  assert.match(sync.stderr + sync.stdout, /names no kit/);

  const next = release(p.root, "new", "0.6.20", lines(20));
  const r = run(next, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).kitSource, { mode: "self", path: "." });
  const settings = JSON.parse(readFileSync(join(p.app, ".claude", "settings.json"), "utf8"));
  assert.match(JSON.stringify(settings.hooks), /maestro\/scripts\/usage-hook\.mjs/);
});

test("update: setup writes kitSource as the vendored kit itself", () => {
  const p = project();
  assert.deepEqual(JSON.parse(readFileSync(join(p.kit, "config.json"), "utf8")).kitSource, { mode: "self", path: "." });
});

test("update: the vendored CLI updates its own kit without --kit (from --from, or the registry)", () => {
  const p = project();
  const next = release(p.root, "new", "0.6.20", lines(20, { 1: "new" }));
  // Offline with nothing to update from: a clear message, not "no update channel".
  const offline = run(p.kit, p.app, "update", "--offline");
  assert.equal(offline.status, 2);
  assert.match(offline.stderr, /--from <kit-checkout>/);
  // From the repo root, the vendored CLI finds its own kit; --from names the release.
  const r = run(p.kit, p.app, "update", "--offline", "--yes", "--from", next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(p.kit, "VERSION"), "utf8").trim(), "0.6.20");
  assert.equal(readFileSync(p.demo, "utf8"), lines(20, { 1: "new" }));
});

test("update: a plain (non-clone, non-npm) kit copy finds ./maestro without --kit", () => {
  const p = project();
  const plain = join(p.root, "plain-kit");
  cpSync(release(p.root, "new", "0.6.20", lines(20)), plain, { recursive: true });
  const r = run(plain, p.app, "update", "--offline", "--yes");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(p.kit, "VERSION"), "utf8").trim(), "0.6.20");
  rmSync(p.root, { recursive: true, force: true });
});
