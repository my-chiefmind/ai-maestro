/**
 * Tests for cockpit port selection.
 *
 * WHY THESE EXIST: every kit ships the same defaults — 4600 for the data service, 5273 for
 * the UI. That is fine for one project and broken for two. The failure was not a clean
 * "port in use" error either: Express calls the `listen` callback before the bind result is
 * known, so the second board printed "ready on 4600", then the socket died, the event loop
 * drained, and the process exited 0. `concurrently -k` read that as success and took Vite
 * down with it. A board vanished with no error anywhere.
 *
 * So two things are pinned here:
 *   - a busy port is actually detected as busy, on BOTH address families (Vite binds
 *     `localhost`, which is ::1 on some machines and 127.0.0.1 on others — checking one
 *     would hand back a port the other is already serving);
 *   - the unpinned default advances rather than dying, while an explicitly requested port
 *     never silently moves. dev.mjs tells Vite which port to proxy to before the service
 *     starts, so a service that drifted off it would leave the UI proxying into nothing.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COCKPIT = join(KIT_ROOT, "cockpit");
const { isPortFree, findFreePort } = await import(
  join(COCKPIT, "server", "ports.mjs")
);

// Well clear of both defaults, so a board running while the suite does can't perturb this.
const BASE = 4790;

/** Hold a port for the duration of `fn`, then release it. */
async function holding(port, host, fn) {
  const squatter = createServer();
  await new Promise((res, rej) => {
    squatter.once("error", rej);
    squatter.listen(port, host, res);
  });
  try {
    return await fn();
  } finally {
    await new Promise((res) => squatter.close(res));
  }
}

test("a free port reads as free, a held one does not", async () => {
  assert.equal(await isPortFree(BASE, ["127.0.0.1"]), true);
  await holding(BASE, "127.0.0.1", async () => {
    assert.equal(await isPortFree(BASE, ["127.0.0.1"]), false);
  });
  // Released again — the probe must not leave the port bound behind it.
  assert.equal(await isPortFree(BASE, ["127.0.0.1"]), true);
});

test("a port held on one address family is not free for the other", async () => {
  // Vite binds `localhost`. If we only probed 127.0.0.1 we would call this port free and
  // hand the UI a port something is already serving on ::1.
  await holding(BASE + 1, "::1", async () => {
    assert.equal(await isPortFree(BASE + 1, ["127.0.0.1", "::1"]), false);
  });
});

test("findFreePort walks past what is taken", async () => {
  await holding(BASE + 2, "127.0.0.1", () =>
    holding(BASE + 3, "127.0.0.1", async () => {
      assert.equal(await findFreePort(BASE + 2, ["127.0.0.1"], 10), BASE + 4);
    })
  );
});

test("findFreePort gives up loudly rather than returning a busy port", async () => {
  await holding(BASE + 5, "127.0.0.1", async () => {
    await assert.rejects(
      () => findFreePort(BASE + 5, ["127.0.0.1"], 1),
      /No free port/
    );
  });
});

/**
 * Start the data service and resolve with everything it printed plus its exit code.
 * `settle` is how long we let it run before shutting it down when it does NOT exit on its
 * own (the success path — it would otherwise serve forever).
 */
function runService({ env = {}, args = [], settle = 2500 } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(COCKPIT, "server", "index.mjs"), ...args], {
      cwd: COCKPIT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), settle);
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ out, code });
    });
  });
}

// These drive the real service, so they must not touch 4600 — a board running while the
// suite does would otherwise fail the suite, which is exactly the collision we're fixing.
// PORT moves the search's starting point, which is all these need.
const SVC = BASE + 10;

// index.mjs imports express/marked from cockpit/node_modules, which the Kit CI job never
// installs (the Cockpit job does). Skip rather than fail — but loudly, so a green run on a
// machine without them can't be mistaken for coverage. Matches cockpit-server.test.mjs.
// The ports.mjs tests above need none of this: it is dependency-free, so they always run.
const SKIP = existsSync(join(COCKPIT, "node_modules"))
  ? false
  : "cockpit deps not installed — run `npm run cockpit:install` to exercise these";
if (SKIP) console.error(`\n⚠ cockpit-ports service tests SKIPPED: ${SKIP}\n`);

test("PORT is where the search starts, not where it must land", { skip: SKIP }, async () => {
  const { out } = await holding(SVC, "127.0.0.1", () =>
    runService({ env: { PORT: String(SVC) } })
  );
  assert.match(out, new RegExp(`cockpit data service on http://localhost:${SVC + 1}`));
  assert.match(out, new RegExp(`${SVC} was busy`));
});

test("--port pins exactly, and fails rather than drifting off Vite's proxy target", { skip: SKIP }, async () => {
  const { out, code } = await holding(SVC, "127.0.0.1", () =>
    runService({ args: ["--port", String(SVC)] })
  );
  assert.match(out, new RegExp(`Port ${SVC} is already in use`));
  assert.doesNotMatch(out, new RegExp(`localhost:${SVC + 1}`), "a pinned port must not fall back");
  assert.equal(code, 1, "must exit non-zero, or concurrently -k reads it as a clean stop");
});

test("a non-numeric port is rejected, not turned into a named pipe", { skip: SKIP }, async () => {
  const viaEnv = await runService({ env: { PORT: "abc" } });
  assert.match(viaEnv.out, /PORT="abc" is not a port number/);
  assert.equal(viaEnv.code, 1);

  const viaFlag = await runService({ args: ["--port", "no"] });
  assert.match(viaFlag.out, /--port="no" is not a port number/);
  assert.equal(viaFlag.code, 1);
});
