/**
 * Tests for the cockpit dependency-install path.
 *
 * WHY THESE EXIST: supply-chain scanners flagged this package for "install-time code
 * execution" because an inline `execSync('npm ... install --no-audit')` lived in a
 * package.json script. Two properties make that flag wrong, and both are invisible to a
 * reader unless something pins them down:
 *
 *   - the package declares NO install lifecycle hooks, so `npm i @mychiefmind/ai-maestro`
 *     executes nothing at all; the install runs only when a user explicitly starts the
 *     board, and only on first run;
 *   - the install is reproducible — `npm ci` against the committed lockfile — rather than
 *     an `npm install` that re-resolves semver ranges at an arbitrary later date.
 *
 * Both are one careless edit away from regressing, and the regression would be silent.
 * These tests fail loudly instead. See SECURITY.md for the full write-up.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(KIT, "scripts", "cockpit-install.mjs");

// Script names that npm itself runs during `npm install`/`npm pack`. If any of these ever
// appears, the package gains genuine install-time execution and the scanner flag becomes real.
const LIFECYCLE = [
  "preinstall", "install", "postinstall",
  "preprepare", "prepare", "postprepare",
  "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish",
];

// A kit layout is `<root>/scripts/cockpit-install.mjs` + `<root>/cockpit/`. The installer
// resolves the cockpit relative to its own location, so a temp copy is a full fixture.
function makeKit({ lockfile = true, nodeModules = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "maestro-install-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "cockpit"), { recursive: true });
  copyFileSync(INSTALLER, join(root, "scripts", "cockpit-install.mjs"));
  writeFileSync(join(root, "cockpit", "package.json"), JSON.stringify({ name: "maestro-cockpit" }));
  if (lockfile) writeFileSync(join(root, "cockpit", "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  if (nodeModules) mkdirSync(join(root, "cockpit", "node_modules"), { recursive: true });
  return root;
}

// Put a fake `npm` first on PATH that records its arguments instead of installing anything.
// Lets us assert exactly what would have been executed — including that nothing was.
function makeNpmShim(root) {
  const bin = join(root, "fakebin");
  const record = join(root, "npm-argv.txt");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "npm");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit 0\n`);
  chmodSync(shim, 0o755);
  return { bin, record };
}

function runInstaller(root, args = []) {
  const { bin, record } = makeNpmShim(root);
  const r = spawnSync(process.execPath, [join(root, "scripts", "cockpit-install.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    npmArgs: existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : null,
  };
}

test("the published package declares no install lifecycle hooks", () => {
  const scripts = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts ?? {};
  const found = LIFECYCLE.filter((k) => k in scripts && k !== "prepublishOnly");
  assert.deepEqual(found, [],
    `installing this package must execute nothing; found lifecycle hook(s): ${found.join(", ")}`);
  // prepublishOnly runs on OUR machine at publish time, never on a consumer's — it is the
  // one exception, and it must stay a local validator with no install semantics.
  if (scripts.prepublishOnly) {
    assert.match(scripts.prepublishOnly, /^node scripts\/validate-board\.mjs\b/);
  }
});

test("the vendored package.json written by `setup` declares no install lifecycle hooks", () => {
  // The vendored scripts block is a literal in bin/cli.mjs; read it rather than running
  // setup, so this stays a fast unit test that still catches an edit to that literal.
  const cli = readFileSync(join(KIT, "bin", "cli.mjs"), "utf8");
  for (const hook of LIFECYCLE) {
    assert.ok(!new RegExp(`^\\s*${hook}:`, "m").test(cli),
      `bin/cli.mjs vendors a '${hook}' script — vendored kits must not execute on install`);
  }
});

// These files DOCUMENT the old `execSync(... --no-audit)` form in their comments, so scan
// executable code only — otherwise explaining the history would trip the guard.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("starting the board does not shell out to a package manager via a shell string", () => {
  const sources = [
    ["scripts/cockpit-install.mjs", readFileSync(INSTALLER, "utf8")],
    ["bin/cli.mjs", readFileSync(join(KIT, "bin", "cli.mjs"), "utf8")],
    ["package.json", readFileSync(join(KIT, "package.json"), "utf8")],
  ];
  for (const [name, raw] of sources) {
    const src = stripComments(raw);
    assert.ok(!/\bexecSync\s*\(/.test(src), `${name} uses execSync; use execFileSync with an argument array`);
    assert.ok(!/--no-audit/.test(src), `${name} passes --no-audit; audit output is advisory, suppressing it only hides information`);
  }

  // `npm install` re-resolves semver ranges, so no package.json script may run it — the
  // installer's own error text is allowed to NAME it, which is why this checks the parsed
  // script definitions rather than grepping source. What the installer actually executes
  // is pinned by the npm-shim tests below.
  const scripts = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts ?? {};
  for (const [name, body] of Object.entries(scripts)) {
    assert.ok(!/\bnpm\b[\s\S]*\binstall\b/.test(body),
      `script '${name}' runs \`npm install\`; the board path must use \`npm ci\` against the lockfile`);
  }
});

test("no-ops when the cockpit's dependencies are already installed", () => {
  const root = makeKit({ nodeModules: true });
  const r = runInstaller(root);
  assert.equal(r.status, 0);
  assert.equal(r.npmArgs, null, "npm must not be invoked when node_modules already exists");
});

test("installs from the lockfile with `npm ci`, never `npm install`", () => {
  const root = makeKit();
  const r = runInstaller(root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.npmArgs, ["ci", "--no-fund"],
    "the implicit path must run exactly `npm ci --no-fund` — no install, no extra flags");
});

test("aborts loudly when the lockfile is missing instead of falling back to an unpinned install", () => {
  const root = makeKit({ lockfile: false });
  const r = runInstaller(root);
  assert.equal(r.status, 1, "a missing lockfile must be a hard failure");
  assert.match(r.stderr, /package-lock\.json is missing/);
  assert.equal(r.npmArgs, null, "npm must not run at all when the dependency set can't be pinned");
});

test("only an explicit --force reinstalls over an existing tree", () => {
  const root = makeKit({ nodeModules: true });
  const r = runInstaller(root, ["--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.npmArgs, ["ci", "--no-fund"]);

  // ...and `preboard` — the implicit path — must never be the thing passing it.
  const pkg = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8"));
  assert.ok(!/--force/.test(pkg.scripts.preboard),
    "preboard must not force a reinstall; starting the board is not a request to re-resolve deps");
});

test("the committed lockfile satisfies `npm ci` with this machine's npm", () => {
  // Catches gross drift between package.json and the lockfile, which is the common case.
  //
  // It does NOT prove the lockfile is good everywhere, and shouldn't be read that way.
  // `npm install --package-lock-only` once wrote a truncated entry for
  // @napi-rs/wasm-runtime — two of its three dependencies missing — that npm 11 accepted
  // and npm 10.8.2 rejected with "Missing: @emnapi/core from lock file". Same platform,
  // same lockfile, different answer. Forcing --os/--cpu does not reproduce it either;
  // the variable is the npm version, so no local run can stand in for CI here.
  //
  // CI is the authoritative check. Keep its Node version pinned so which npm it uses is
  // a decision rather than an accident.
  const r = spawnSync("npm", ["ci", "--dry-run", "--no-fund"], {
    cwd: join(KIT, "cockpit"), encoding: "utf8",
  });
  assert.equal(r.status, 0, `npm ci rejects the committed lockfile:\n${r.stderr || r.stdout}`);
});

test("the cockpit lockfile is committed and ships in the published tarball", () => {
  // `npm ci` on a user's machine is only reproducible if the lockfile actually reaches them.
  // npm strips a ROOT package-lock.json from tarballs but keeps nested ones; that behaviour
  // is what this whole design rests on, so assert it rather than trusting it.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: KIT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes("cockpit/package-lock.json"), "cockpit/package-lock.json must be published");
  assert.ok(files.includes("scripts/cockpit-install.mjs"), "the installer must be published");
});

test("the published tarball never ships this repo's own real board data", () => {
  // board/data.json and board/specs/*.md hold ai-maestro's OWN live tickets, not example
  // content (see board/archive.json's T-001 entry) — publishing them would both leak internal
  // planning to every npm consumer and (before the fix) get vendored straight into new
  // projects' boards. The template files (schema, README) and the starter's placeholder board
  // must still ship — this pins the exclusion without also silently breaking a fresh setup.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: KIT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const forbidden of ["board/data.json", "board/archive.json"]) {
    assert.ok(!files.includes(forbidden), `${forbidden} must not be published`);
  }
  assert.ok(!files.some((f) => f.startsWith("board/specs/")), "board/specs/ must not be published");
  assert.ok(!files.some((f) => f.startsWith("board/reports/")), "board/reports/ must not be published");

  assert.ok(files.includes("board/board.schema.json"), "the board schema must still be published");
  assert.ok(files.includes("board/README.md"), "the board format doc must still be published");
  assert.ok(files.includes("starters/orchestrated-project/board/data.json"), "the starter's placeholder board must still be published");
});
