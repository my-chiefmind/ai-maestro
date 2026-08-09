/**
 * Tests for the cockpit data service's exposure controls.
 *
 * WHY THESE EXIST: the service has no authentication, by design — it is a tool for one
 * developer on one machine. Everything that keeps that true is a boundary somewhere else,
 * and each one was found broken:
 *
 *   - it listened on 0.0.0.0, so an unauthenticated read/write board API was on every
 *     interface, reachable by anyone on the same network;
 *   - nothing checked the Host header, so DNS rebinding could reach it same-origin from a
 *     hostile page even once bound to loopback;
 *   - /api/docs/render would render ANY .md under the kit root through `marked` (which
 *     does not sanitise) into HTML the UI injects with dangerouslySetInnerHTML. That
 *     included board/specs/*.md — files this same service writes on request via
 *     PUT /api/spec/:id. Write a spec, ask for it rendered, run script in the cockpit's
 *     origin, rewrite the board that agents act on.
 *
 * All three are invisible from reading a route handler in isolation, so they are pinned
 * here against a real server. See SECURITY.md §2.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(KIT, "cockpit", "server", "index.mjs");
const SPECS = join(KIT, "board", "specs");
const PORT = 4703; // not the default 4600, so a running dev board doesn't collide
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A spec whose body is hostile markdown. The service writes specs on request, so this is
// content an attacker (or a prompt-injected agent) can genuinely put on disk.
const PROBE_ID = "ZZ-servertest-probe";
const PROBE_PAYLOAD = '# probe\n\n<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n';

// The service needs express/marked from cockpit/node_modules, which a fresh clone or a CI
// job that never starts the board won't have. Skip rather than fail — but skip loudly, so
// a green run on a machine without them can't be mistaken for coverage.
const SKIP = existsSync(join(KIT, "cockpit", "node_modules"))
  ? false
  : "cockpit deps not installed — run `npm run cockpit:install` to exercise these";
if (SKIP) console.error(`\n⚠ cockpit-server tests SKIPPED: ${SKIP}\n`);

let proc;

before(async () => {
  if (SKIP) return;
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  // Poll until it answers rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${ORIGIN}/api/board/version`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("cockpit server did not start");
});

after(() => {
  if (SKIP) return;
  proc?.kill();
  // The probe spec is written into the real board dir. Remove only the probe file, and the
  // dir itself only when the probe was the sole thing in it (i.e. this run created the dir) —
  // `rmSync(..., { recursive: true })` never refuses a non-empty directory, so a naive version
  // of this cleanup wipes the repo's real specs/reports whenever they happen to be present.
  rmSync(join(SPECS, `${PROBE_ID}.md`), { force: true });
  if (existsSync(SPECS) && readdirSync(SPECS).length === 0) rmSync(SPECS, { recursive: true });
});

const get = (path, headers = {}) => fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });

// `Host` is a forbidden header name for fetch/undici — it is dropped silently, which would
// make these tests pass against a server with no guard at all. Go through node:http, which
// lets us set it, so we are actually testing what a rebinding attacker sends.
function rawGet(path, hostHeader) {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: hostHeader } },
      (r) => { r.resume(); r.on("end", () => res(r.statusCode)); },
    );
    req.on("error", rej);
    req.end();
  });
}

test("binds loopback only, not every interface", { skip: SKIP || (process.platform === "win32" && "lsof is POSIX-only") }, async () => {
  // Asserted via the server's own socket rather than by trying to reach it from off-box,
  // which a test can't portably do. 0.0.0.0 would report as '::' or '0.0.0.0'.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  assert.match(out, /127\.0\.0\.1:/, `expected a loopback bind, got:\n${out}`);
  assert.ok(!/\*:/.test(out), `server is listening on all interfaces:\n${out}`);
});

test("rejects requests not addressed to localhost (DNS rebinding)", { skip: SKIP }, async () => {
  for (const host of ["evil.attacker.com", "attacker.com:4703", "board.internal"]) {
    assert.equal(await rawGet("/api/board/version", host), 403, `Host: ${host} should be refused`);
  }
});

test("accepts the localhost forms, including through the Vite dev proxy", { skip: SKIP }, async () => {
  // Vite forwards the browser's Host unchanged, so the proxied case arrives as :5273.
  for (const host of ["localhost:4703", "127.0.0.1:4703", "localhost:5273", "[::1]:4703"]) {
    assert.equal(await rawGet("/api/board/version", host), 200, `Host: ${host} should be allowed`);
  }
});

test("will not render a spec file as a doc", { skip: SKIP }, async () => {
  // 1. write hostile markdown through the public endpoint — still allowed, specs are editable
  const put = await fetch(`${ORIGIN}/api/spec/${PROBE_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: PROBE_PAYLOAD }),
  });
  assert.equal(put.status, 200);
  assert.ok(existsSync(join(SPECS, `${PROBE_ID}.md`)), "spec should have been written");

  // 2. ...but it must not be reachable through the renderer, which feeds innerHTML
  const r = await get(`/api/docs/render?path=board/specs/${PROBE_ID}.md`);
  assert.equal(r.status, 404, "specs must not be renderable as docs");

  // 3. and the payload must not come back from any listed doc path either
  const listed = await (await get("/api/docs")).json();
  const paths = listed.sections.flatMap((s) => s.files.map((f) => f.path));
  assert.ok(!paths.some((p) => p.includes("specs/")), "the docs listing must not advertise specs");
});

test("renders only what /api/docs lists, and still renders all of it", { skip: SKIP }, async () => {
  const listed = await (await get("/api/docs")).json();
  const paths = listed.sections.flatMap((s) => s.files.map((f) => f.path));
  assert.ok(paths.length > 5, "expected a non-trivial docs listing");

  // Everything advertised must render — the allowlist must not break the Docs tab.
  for (const p of paths) {
    const r = await get(`/api/docs/render?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 200, `listed doc failed to render: ${p}`);
  }

  // Real files under the kit that are NOT listed must be refused.
  for (const p of ["package.json", "VERSION", "CLAUDE.md", "test/cockpit-server.test.mjs"]) {
    const r = await get(`/api/docs/render?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 404, `unlisted kit file should not render: ${p}`);
  }
});

test("resists path traversal on the docs and asset endpoints", { skip: SKIP }, async () => {
  const payloads = [
    "../../../../etc/hosts", "../../etc/hosts", "/etc/hosts",
    "%2e%2e%2f%2e%2e%2fpackage.json", "....//etc/hosts",
  ];
  for (const p of payloads) {
    assert.equal((await get(`/api/docs/render?path=${p}`)).status, 404, `render: ${p}`);
    assert.equal((await get(`/api/docs/asset?path=${p}`)).status, 404, `asset: ${p}`);
  }
});

test("spec ids cannot contain a path separator", { skip: SKIP }, async () => {
  for (const id of ["..%2f..%2fetc%2fpasswd", "a%2f..%2f..%2fb", "%2e%2e%2f"]) {
    const r = await get(`/api/spec/${id}`);
    assert.equal(r.status, 400, `spec id ${id} should be rejected`);
  }
});

// ── Raw-HTML neutering ──────────────────────────────────────────────────────────
// The curated docs include agent-authored files (agents/*.md, skills/*/SKILL.md), so raw
// HTML in a rendered doc is attacker-supplied content, not just prose. sanitize.mjs keeps
// a token only when it matches a small anchored grammar exactly, and escapes it wholesale
// otherwise. Unit-tested directly (the module is dependency-free, so no SKIP), then the
// endpoint behaviour is pinned through a real render below.
import { neuterRawHtml } from "../cockpit/server/sanitize.mjs";

test("hostile raw HTML is escaped wholesale", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(2)">',
    '<a href="javascript:alert(3)">x</a>',
    '<a href="jav&#x09;ascript:alert(4)">x</a>', // entity-smuggled scheme → & is rejected in URLs
    '<a href="java\nscript:alert(5)">x</a>',     // whitespace-smuggled scheme
    '<a href="data:text/html,<script>">x</a>',
    '<a href="//attacker.example">x</a>',        // protocol-relative
    "<details open>x</details>",                  // valueless attribute → outside the grammar
    "<b>ok</b> then <img src=x onerror=alert(6)", // unclosed tag would swallow later markup
    "<style>*{display:none}</style>",
    "<!-- <script>alert(7)</script> -->",
    "<iframe src=\"https://x\"></iframe>",
  ];
  for (const t of hostile) {
    const out = neuterRawHtml(t);
    assert.ok(!/<[a-zA-Z!/]/.test(out), `must not survive as markup: ${t} → ${out}`);
  }
});

test("the raw HTML the shipped docs use is kept verbatim", () => {
  const legit = [
    '<p align="center">\n  <img src="./cockpit/asset/logo.png" alt="AI Maestro logo" width="160" />\n</p>',
    '<h1 align="center">AI Maestro</h1>',
    '<a href="#quickstart">Quickstart</a>',
    '<a href="./LICENSE"><code>MIT</code></a>',
    '<a href="https://example.com">docs</a>',
    "<details>\n<summary><b>More views</b> — light theme &amp; the roster</summary>",
    "<br/>",
    "</details>",
  ];
  for (const t of legit) {
    assert.equal(neuterRawHtml(t), t, `inert doc HTML must render, not escape: ${t}`);
  }
});

test("a rendered doc keeps its inert HTML and nothing executable", { skip: SKIP }, async () => {
  // README.md is the one shipped doc that uses raw HTML — its header must survive the
  // neutering (regression guard: the allowlist must not silently gut the flagship doc).
  const r = await get("/api/docs/render?path=README.md");
  assert.equal(r.status, 200);
  const { html } = await r.json();
  assert.match(html, /<h1 align="center">AI Maestro<\/h1>/, "README header must still render");
  assert.match(html, /<details>/, "the details gallery must still render");
  assert.ok(!/<script\b/i.test(html), "no script may reach the response");
});

test("serves doc images, but strips their ability to run script", { skip: SKIP }, async () => {
  // SVG is XML that can carry <script>, and it executes when opened directly rather than
  // via <img>. The endpoint stays open to SVG, so the response must deny it privileges.
  const r = await get("/api/docs/asset?path=cockpit/asset/logo.png");
  assert.equal(r.status, 200, "legitimate doc images must still be served");
  const csp = r.headers.get("content-security-policy");
  assert.ok(csp && /default-src 'none'/.test(csp) && /sandbox/.test(csp),
    `asset responses need a locking-down CSP, got: ${csp}`);
});

test("serves the long-form help guide, sandboxed and unable to escape the kit", { skip: SKIP }, async () => {
  // docs/help.html is HTML, so the Markdown docs browser could not list or render it and it
  // shipped with nothing pointing at it. It gets its own route — held to the same rules as an
  // .html report, since it is a document rendered in the cockpit's frame.
  const r = await get("/api/help/guide");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/, "the guide must not be able to run script in our origin");
  assert.match(await r.text(), /How AI Maestro works/);

  // The UI probes with HEAD before showing the tab; Express answers it from the same route.
  assert.equal((await fetch(`${ORIGIN}/api/help/guide`, { method: "HEAD" })).status, 200);

  // The route takes no filename — but the scope it resolves against comes from the query, so
  // an unknown project must not become a path to read from.
  const bogus = await get("/api/help/guide?project=" + encodeURIComponent("../../etc"));
  assert.ok(bogus.status >= 400, `an unknown scope must not resolve (got ${bogus.status})`);
});

test("the guide follows the console's theme, not the OS", { skip: SKIP }, async () => {
  // The frame is sandboxed with default-src 'none' and no script-src, so it can neither read
  // the parent nor run a line of JS to ask. Left alone it followed prefers-color-scheme and
  // ignored the console's toggle, so the two disagreed for anyone whose toggle differs from
  // their system setting. The document already carries :root[data-theme=…] blocks that outrank
  // its media query, so the served copy gets the attribute stamped on.
  // Matched against the <html> tag specifically: the document's own stylesheet contains
  // `:root[data-theme="dark"]` blocks, so a bare /data-theme/ would pass on the CSS alone and
  // prove nothing about the attribute that actually selects them.
  const htmlTag = (body) => /<html\b[^>]*>/i.exec(body)?.[0] ?? "";

  assert.match(htmlTag(await (await get("/api/help/guide?theme=dark")).text()),
    /\sdata-theme="dark"/, "dark must be stamped onto <html>");
  assert.match(htmlTag(await (await get("/api/help/guide?theme=light")).text()),
    /\sdata-theme="light"/);

  // No theme asked for: served untouched, so a direct visit still honours the OS.
  assert.doesNotMatch(htmlTag(await (await get("/api/help/guide")).text()), /data-theme/);

  // The value reaches an HTML attribute, so it is whitelisted rather than escaped. Anything
  // else must be ignored outright — not sanitised, not reflected.
  for (const bad of ['"><script>x</script>', "dark' onload='x", "DARK", "", "purple"]) {
    const body = await (await get("/api/help/guide?theme=" + encodeURIComponent(bad))).text();
    assert.doesNotMatch(htmlTag(body), /data-theme/, `"${bad}" must not reach the <html> tag`);
    assert.doesNotMatch(body, /<script>x<\/script>/, `"${bad}" must not inject markup anywhere`);
    assert.doesNotMatch(body, /onload=/i);
  }

  // Repeated params arrive as an array, which is not a string and must not be trusted.
  const arr = await (await get("/api/help/guide?theme=dark&theme=light")).text();
  assert.doesNotMatch(htmlTag(arr), /data-theme/, "an array-valued theme must be ignored");

  // A themed response varies by query, so it must not be cached as though it didn't.
  const themed = await get("/api/help/guide?theme=dark");
  assert.match(themed.headers.get("cache-control") ?? "", /no-store/);
});
