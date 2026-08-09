#!/usr/bin/env node
// @ts-check
/**
 * AI Maestro cockpit data service.
 *
 * Serves a single AI Maestro board and its neighbours (config, specs, rendered roster) and
 * writes board edits back in place with a timestamped backup. Every write is validated with
 * the same rules as the CLI (scripts/board-core.mjs) so the UI can't save a broken board,
 * and is guarded by an optimistic-concurrency version so a stale tab can't clobber changes
 * an agent made on disk.
 *
 * Board location resolves from (first that exists):
 *   1. --board <dir> / MAESTRO_BOARD_DIR
 *   2. ../board relative to this cockpit
 *   3. ./board (cwd)
 *
 * Endpoints (every one below also accepts ?project=<registry name> in portfolio mode,
 * scoping it to that project's board/kit dir; without it they address the single board
 * this service was started for, unchanged):
 *   GET  /api/board            -> { boardDir, project, epics, tickets, archived, archivedEpics, version }
 *   GET  /api/board/version    -> { version }                (cheap poll for auto-refresh)
 *   PUT  /api/board            -> { epics, tickets, version } (409 on stale version, 400 on invalid)
 *   GET  /api/config           -> { name, areas, planSteps, models, humanGates } | null
 *   GET  /api/roster           -> { agents: [...], skills: [...] }
 *   GET  /api/spec/:id         -> { id, content }
 *   PUT  /api/spec/:id         -> { ok }                     ({ content })
 *   GET  /api/docs             -> { sections: [{ key, label, files: [{ path, title }] }] }
 *   GET  /api/docs/render      -> { path, html }             (?path=<root-relative .md>)
 *   GET  /api/reports          -> { reports: [{ name, mtime, size }] }   (board/reports/)
 *   GET  /api/reports/render   -> { name, kind, html } for .md; sandboxed file for .html
 *
 * Portfolio mode (T-003; opt-in via --registry <file> / MAESTRO_REGISTRY):
 *   GET  /api/portfolio/boards -> { registry, boards: [...] } (each board dir read in place)
 *   GET  /api/portfolio/today  -> { week, projects: [...] }   (ready-to-run tickets per board)
 */

import express from "express";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync, rmSync,
} from "fs";
import { resolve, dirname, join, sep } from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";
import { validateBoard, MODELS, agentFileToCode } from "../../scripts/board-core.mjs";
import { neuterRawHtml } from "./sanitize.mjs";
import { findFreePort } from "./ports.mjs";
import { loadPortfolio, readPortfolioBoards, survey as portfolioSurvey } from "./portfolio.mjs";

// Raw HTML in a doc must not pass through to the UI's dangerouslySetInnerHTML untouched:
// the rendered set includes agent-authored files (agents/*.md, skills/*/SKILL.md), so it
// is script-injection surface, not just prose. See sanitize.mjs for the model.
marked.use({ renderer: { html: ({ text }) => neuterRawHtml(text) } });

/**
 * Board and config shapes are described loosely on purpose. `board/board.schema.json` and
 * `scripts/board-core.mjs` own that contract — restating it here would give us a second
 * definition free to drift from the one the validator actually enforces. These typedefs
 * cover only what this file reaches into.
 *
 * @typedef {Record<string, string>} Frontmatter  Parsed YAML frontmatter (flat string map).
 * @typedef {{ epics?: object[], tickets?: object[] }} BoardFile  data.json / archive.json.
 * @typedef {{
 *   project?: { name?: string, areas?: string[] },
 *   roster?: string[],
 *   humanGates?: unknown[],
 * }} MaestroConfig  The project's config.json, as far as the cockpit reads it.
 *
 * @typedef {{ key: string, label: string, files?: string[], dir?: string }} DocSectionDef
 * @typedef {{ path: string, title: string }} DocFile  A doc the UI may list and render.
 * @typedef {{ key: string, label: string, files: DocFile[] }} DocSection
 */

const __dir = dirname(fileURLToPath(import.meta.url));
const COCKPIT = resolve(__dir, "..");
const KIT_ROOT = resolve(COCKPIT, ".."); // the cockpit lives inside the kit
// The port every kit defaults to — and therefore the one two projects collide on. Whether
// we're allowed to move off it depends on who asked for it; see PINNED_PORT below.
const DEFAULT_PORT = 4600;
const PORT_SCAN_LIMIT = 20;
const MAX_BACKUPS = 20;

/** Narrow an unknown catch binding to something printable. */
const errMessage = (/** @type {unknown} */ e) =>
  e instanceof Error ? e.message : String(e);

// Containment check for any path built from request input. Uses `sep` rather than a
// hardcoded "/" because on Windows resolve() returns backslashes, so the "/" form never
// matched and every docs request 404'd there — failing closed, but failing.
// Generalized from the old isInsideKit (T-003): the boundary is the requesting scope's
// root — the kit root in single-board mode, a registry project's kit dir in portfolio mode.
// Portfolio mode widens which roots are legal; it must not widen whether paths are checked.
const isInside = (/** @type {string} */ root, /** @type {string} */ abs) =>
  abs === root || abs.startsWith(root + sep);

/**
 * Value of a `--flag <value>` argv pair.
 * @param {string} flag
 * @returns {string | null}
 */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] ?? null : null;
}

/** @returns {string} absolute path to the board directory */
function resolveBoardDir() {
  /** @type {string[]} */
  const candidates = [
    argValue("--board"),
    process.env.MAESTRO_BOARD_DIR,
    resolve(COCKPIT, "..", "board"),
    resolve(process.cwd(), "board"),
  ].flatMap((c) => (typeof c === "string" && c.length > 0 ? [c] : []));
  for (const c of candidates) {
    if (existsSync(join(resolve(c), "data.json"))) return resolve(c);
  }
  return resolve(candidates[0] ?? join(process.cwd(), "board"));
}

const BOARD_DIR = resolveBoardDir();

// Portfolio mode (T-003): opt-in only, via --registry or MAESTRO_REGISTRY — no default path,
// so single-board mode is unchanged when neither is set (AC2).
const REGISTRY_PATH = argValue("--registry") || process.env.MAESTRO_REGISTRY || null;

/**
 * Everything path-shaped the handlers need, derived once per scope instead of baked into
 * module constants — the generalization the T-003 write half needed. A scope is either the
 * default single-board one (below) or a registry entry resolved per-request by scopeOf().
 *
 * `root` doubles as the docs/asset containment boundary: the kit root in single-board mode,
 * the project's vendored kit dir (maestro/) in portfolio mode. Every path check that used
 * to be isInsideKit is now "inside this scope's root".
 *
 * @typedef {{
 *   name: string | null, boardDir: string, projectDir: string, root: string,
 *   data: string, archive: string, backups: string, specs: string, reports: string,
 *   config: string,
 * }} Scope
 */
/**
 * @param {string} boardDir
 * @param {string} root containment boundary for docs/assets/reports in this scope
 * @param {string | null} [name] registry name (null for the single-board default)
 * @returns {Scope}
 */
function scopeFor(boardDir, root, name = null) {
  const projectDir = resolve(boardDir, ".."); // config.json / .claude live one level up
  return {
    name, boardDir, projectDir, root,
    data: join(boardDir, "data.json"),
    archive: join(boardDir, "archive.json"),
    backups: join(boardDir, ".backups"),
    specs: join(boardDir, "specs"),
    reports: join(boardDir, "reports"),
    config: join(projectDir, "config.json"),
  };
}

const DEFAULT_SCOPE = scopeFor(BOARD_DIR, KIT_ROOT);

// Registry names are matched exactly; the path always comes from the registry file, never
// from the request. That keeps the registry as the write/read allowlist (T-003 §1) even now
// that every board/spec/docs/report endpoint accepts ?project=<name>.
/**
 * Resolve the scope a request addresses: the default single-board scope when no ?project=
 * is given (so single-board mode is byte-for-byte unchanged), else the named registry entry.
 * Writes the error response and returns null when the name can't be resolved.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Scope | null}
 */
function scopeOf(req, res) {
  const name = typeof req.query.project === "string" ? req.query.project : null;
  if (!name) return DEFAULT_SCOPE;
  if (!REGISTRY_PATH) {
    res.status(404).json({ error: "Portfolio mode is not configured — start with --registry <file> or MAESTRO_REGISTRY." });
    return null;
  }
  try {
    const portfolio = loadPortfolio(REGISTRY_PATH);
    const entry = portfolio?.find((/** @type {{ name: string, path: string, kitDir: string | null }} */ p) => p.name === name);
    if (!entry) {
      res.status(404).json({ error: `No project named "${name}" in the registry.` });
      return null;
    }
    if (!entry.kitDir) {
      res.status(404).json({ error: `Project "${name}" is registered but was never set up (no maestro kit dir).` });
      return null;
    }
    return scopeFor(join(entry.kitDir, "board"), entry.kitDir, name);
  } catch (e) {
    res.status(500).json({ error: `cannot read registry: ${errMessage(e)}` });
    return null;
  }
}

/**
 * Read and parse a JSON file, falling back on any error (missing, unreadable, malformed).
 * @template T
 * @param {string} p
 * @param {T} fallback
 * @returns {T}
 */
function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return fallback; }
}

// Cheap content version: mtime+size. Changes whenever the file is written (by us or an agent).
/** @param {Scope} scope */
function boardVersion(scope) {
  if (!existsSync(scope.data)) return "0-0";
  const s = statSync(scope.data);
  return `${Math.round(s.mtimeMs)}-${s.size}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// The agent codes this project knows about, derived from config.roster (used for validation
// and for the UI's agent_plan picker). Null when there's no config → skip the agent-code check.
/**
 * @param {Scope} scope
 * @returns {MaestroConfig | null}
 */
function loadConfig(scope) {
  return existsSync(scope.config) ? readJSON(scope.config, /** @type {MaestroConfig | null} */ (null)) : null;
}
/**
 * @param {MaestroConfig | null} config
 * @returns {string[] | null} agent codes the project's plans may use, or null if unknown
 */
function planStepsFromConfig(config) {
  if (!config?.roster) return null;
  const codes = config.roster.map(agentFileToCode).filter((c) => c !== "orchestrator");
  if (!codes.includes("merge")) codes.push("merge"); // the terminal land step
  return [...new Set(codes)];
}

/** @param {Scope} scope */
function pruneBackups(scope) {
  if (!existsSync(scope.backups)) return;
  const files = readdirSync(scope.backups).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    try { rmSync(join(scope.backups, f), { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Parse `name` and `description` out of a Markdown file's YAML frontmatter.
 * @param {string} text
 * @returns {Frontmatter} empty when the file has no frontmatter block
 */
function frontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const block = m?.[1];
  if (!block) return {};
  /** @type {Frontmatter} */
  const out = {};
  for (const line of block.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    // Both groups are non-optional in the pattern, so a match always has them; the guard
    // is what tells the checker that, and costs nothing at runtime.
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return out;
}

const app = express();

// ── Localhost-only guard ────────────────────────────────────────────────────────
// This service has no authentication: anything that can reach it can read the board,
// rewrite it, and read any doc in the kit. That is acceptable for a tool bound to the
// developer's own machine and not otherwise, so two things keep it there:
//
//   1. we listen on loopback (see app.listen at the bottom), so it is not exposed to
//      the local network; and
//   2. we check the Host header here, because binding loopback alone does NOT stop DNS
//      rebinding — a hostile page can point a name it controls at 127.0.0.1 and then
//      talk to us as same-origin, which sails past the browser's CORS check.
//
// Vite's dev proxy forwards the browser's Host (localhost:5273) unchanged, so matching
// on hostname and ignoring the port covers both the proxied and direct cases.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Hostname from a Host header, port and IPv6 brackets stripped.
 * @param {string} hostHeader
 * @returns {string | null} null when the header is absent or unparseable
 */
function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  const host = hostnameOf(req.headers.host ?? "");
  // No Host header, or one naming anything but loopback: refuse. Deliberately terse —
  // there is no legitimate caller here to help debug.
  if (!host || !LOCAL_HOSTS.has(host)) {
    return res.status(403).json({ error: "This service only accepts requests addressed to localhost." });
  }
  next();
});

app.use(express.json({ limit: "8mb" }));

// ── Board ──────────────────────────────────────────────────────────────────────
// All board/spec/config endpoints accept ?project=<registry name>. Absent, they address the
// single board this service was started for, exactly as before.
app.get("/api/board", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  if (!existsSync(scope.data)) {
    return res.status(404).json({ error: `No board/data.json at ${scope.boardDir}` });
  }
  const data = readJSON(scope.data, { epics: [], tickets: [] });
  const arch = readJSON(scope.archive, { epics: [], tickets: [] });
  res.json({
    boardDir: scope.boardDir,
    project: scope.name,
    epics: data.epics ?? [],
    tickets: data.tickets ?? [],
    archived: arch.tickets ?? [],
    archivedEpics: arch.epics ?? [],
    version: boardVersion(scope),
  });
});

app.get("/api/board/version", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  res.json({ version: boardVersion(scope) });
});

app.put("/api/board", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const { epics, tickets, version } = req.body ?? {};
  if (!Array.isArray(epics) || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Body must be { epics: [], tickets: [] }." });
  }

  // Optimistic concurrency: refuse to overwrite a board that changed since the client loaded.
  const current = boardVersion(scope);
  if (version != null && version !== current && existsSync(scope.data)) {
    const data = readJSON(scope.data, { epics: [], tickets: [] });
    const arch = readJSON(scope.archive, { epics: [], tickets: [] });
    return res.status(409).json({
      error: "The board changed on disk since you loaded it (an agent or another tab wrote it). Reloaded the latest — reapply your edit.",
      current: {
        boardDir: scope.boardDir,
        project: scope.name,
        epics: data.epics ?? [], tickets: data.tickets ?? [],
        archived: arch.tickets ?? [], archivedEpics: arch.epics ?? [],
        version: current,
      },
    });
  }

  // Same integrity rules as the CLI — the pretty UI cannot bypass them, and a portfolio
  // write is validated against ITS project's archive + config, not the local one's.
  const arch = readJSON(scope.archive, { epics: [], tickets: [] });
  const config = loadConfig(scope);
  const planSteps = planStepsFromConfig(config);
  const { errors } = validateBoard({ epics, tickets }, {
    archived: arch.tickets ?? [],
    archivedEpics: arch.epics ?? [],
    agentCodes: planSteps ? new Set(planSteps) : null,
    config,
  });
  if (errors.length) {
    return res.status(400).json({ error: `Board would be invalid:\n- ${errors.join("\n- ")}` });
  }

  try {
    if (existsSync(scope.data)) {
      mkdirSync(scope.backups, { recursive: true });
      copyFileSync(scope.data, join(scope.backups, `data.${stamp()}.json`));
      pruneBackups(scope);
    }
    writeFileSync(scope.data, JSON.stringify({ epics, tickets }, null, 2) + "\n");
    res.json({ ok: true, version: boardVersion(scope) });
  } catch (e) {
    res.status(500).json({ error: errMessage(e) });
  }
});

// ── Portfolio mode (T-003, read-only) — every board named in --registry/MAESTRO_REGISTRY ──
// Absent registry -> 404 with a clear reason, not an empty list: a portfolio tab that reads
// as "no projects" when the registry was simply never configured is worse than an explicit
// "portfolio mode isn't set up" (T-003 §1's "loud, not silent" rule, applied to the endpoint
// as well as to a malformed registry file).
app.get("/api/portfolio/boards", (_req, res) => {
  if (!REGISTRY_PATH) return res.status(404).json({ error: "Portfolio mode is not configured — start with --registry <file> or MAESTRO_REGISTRY." });
  try {
    const portfolio = loadPortfolio(REGISTRY_PATH);
    if (!portfolio) return res.status(404).json({ error: `No registry at ${REGISTRY_PATH}.` });
    res.json({ registry: REGISTRY_PATH, boards: readPortfolioBoards(portfolio) });
  } catch (e) {
    res.status(500).json({ error: `cannot read registry: ${errMessage(e)}` });
  }
});
app.get("/api/portfolio/today", (_req, res) => {
  if (!REGISTRY_PATH) return res.status(404).json({ error: "Portfolio mode is not configured — start with --registry <file> or MAESTRO_REGISTRY." });
  try {
    const portfolio = loadPortfolio(REGISTRY_PATH);
    if (!portfolio) return res.status(404).json({ error: `No registry at ${REGISTRY_PATH}.` });
    res.json(portfolioSurvey(portfolio));
  } catch (e) {
    res.status(500).json({ error: `cannot build survey: ${errMessage(e)}` });
  }
});

// ── Config (drives the UI's area / agent_plan / model pickers) ───────────────────
app.get("/api/config", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const config = loadConfig(scope);
  if (!config) return res.json(null);
  res.json({
    name: config.project?.name ?? null,
    areas: config.project?.areas ?? [],
    planSteps: planStepsFromConfig(config) ?? [],
    models: MODELS,
    humanGates: config.humanGates ?? [],
  });
});

// ── Roster (read-only view of the project's agents + skills) ─────────────────────
app.get("/api/roster", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  // Prefer the rendered project roster; fall back to the scope's kit-source roster.
  const agentsDir = existsSync(join(scope.projectDir, ".claude", "agents"))
    ? join(scope.projectDir, ".claude", "agents") : join(scope.root, "agents");
  const skillsRoot = existsSync(join(scope.projectDir, ".claude", "skills"))
    ? join(scope.projectDir, ".claude", "skills") : join(scope.root, "skills");

  const agents = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => {
        const fm = frontmatter(readFileSync(join(agentsDir, f), "utf8"));
        return { code: agentFileToCode(f.replace(/\.md$/, "")), name: fm.name || f.replace(/\.md$/, ""), description: fm.description || "" };
      })
    : [];
  const skills = existsSync(skillsRoot)
    ? readdirSync(skillsRoot).filter((d) => existsSync(join(skillsRoot, d, "SKILL.md"))).map((d) => {
        const fm = frontmatter(readFileSync(join(skillsRoot, d, "SKILL.md"), "utf8"));
        return { name: fm.name || d, description: fm.description || "" };
      })
    : [];
  res.json({ agents, skills });
});

// ── Specs (long-form ticket detail: board/specs/<id>.md) ─────────────────────────
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
app.get("/api/spec/:id", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const { id } = req.params;
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: "Invalid spec id." });
  const p = join(scope.specs, `${id}.md`);
  res.json({ id, content: existsSync(p) ? readFileSync(p, "utf8") : "" });
});
app.put("/api/spec/:id", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const { id } = req.params;
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: "Invalid spec id." });
  const content = String(req.body?.content ?? "");
  try {
    mkdirSync(scope.specs, { recursive: true });
    writeFileSync(join(scope.specs, `${id}.md`), content);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: errMessage(e) });
  }
});

// ── Docs browser — read the kit's guides + roster from the cockpit ───────────────
// Curated so the tab shows the docs worth reading, not every file. Rendered server-side
// with marked; read-only and path-allowlisted to the kit root (.md files only).
const DOC_SECTIONS = [
  { key: "guides", label: "Guides", files: ["README.md", "docs/GETTING-STARTED.md", "docs/METHOD.md", "docs/MODEL-ROUTING.md", "docs/AGENTS.md", "CONTRIBUTING.md"] },
  { key: "reference", label: "Reference", files: ["board/README.md", "render/README.md", "cockpit/README.md", "starters/README.md"] },
  { key: "agents", label: "Agents", dir: "agents" },
  { key: "skills", label: "Skills", dir: "skills" },
];

/**
 * Title = first Markdown heading, else the frontmatter name, else the filename.
 * @param {string} abs absolute path to read
 * @param {string} rel kit-relative path, used for the filename fallback
 * @returns {string}
 */
function docTitle(abs, rel) {
  try {
    const text = readFileSync(abs, "utf8");
    const h = /^#\s+(.+)$/m.exec(text)?.[1];
    if (h) return h.trim();
    const html = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1];
    if (html) return html.replace(/<[^>]+>/g, "").trim();
    const fm = /^---\s*\n[\s\S]*?\bname:\s*["']?([^"'\n]+)["']?/m.exec(text)?.[1];
    if (fm) return fm.trim();
  } catch { /* fall through */ }
  // split() on a non-empty string always yields at least one element, but pop() is typed
  // as possibly-undefined; `rel` is the sensible fallback and matches the intent.
  return rel.split("/").pop() ?? rel;
}

/**
 * @param {string} root the scope's doc root (kit root, or a project's vendored kit dir)
 * @param {DocSectionDef} section
 * @returns {DocFile[]} only files that exist, titled
 */
function sectionFiles(root, section) {
  let rels = [...(section.files ?? [])];
  if (section.dir) {
    const base = join(root, section.dir);
    if (existsSync(base)) {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(base, e.name, "SKILL.md"))) rels.push(`${section.dir}/${e.name}/SKILL.md`);
        else if (e.isFile() && e.name.endsWith(".md")) rels.push(`${section.dir}/${e.name}`);
      }
    }
    rels.sort();
  }
  return rels
    .filter((rel) => existsSync(join(root, rel)))
    .map((rel) => ({ path: rel, title: docTitle(join(root, rel), rel) }));
}

/**
 * The curated listing for one scope's root, empty sections dropped. A registry project's
 * vendored kit (maestro/) mirrors the kit layout — README, docs/, agents/, skills/ — so the
 * same curated set applies to every root (T-003 §4: the rendering was already solved; the
 * gap was N roots vs one).
 * @param {string} root
 * @returns {DocSection[]}
 */
function docSections(root) {
  return DOC_SECTIONS
    .map((s) => ({ key: s.key, label: s.label, files: sectionFiles(root, s) }))
    .filter((s) => s.files.length);
}

// The exact set /api/docs advertises — and therefore the only set /api/docs/render will
// render. Recomputed per request because the agents/ and skills/ sections are read from
// disk and change as the project is re-rendered.
const listedDocPaths = (/** @type {string} */ root) =>
  new Set(docSections(root).flatMap((s) => s.files.map((f) => f.path)));

app.get("/api/docs", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  res.json({ sections: docSections(scope.root) });
});

// Rewrite relative <img src> in rendered docs to the image endpoint below. A doc's image
// links are relative to the doc's own folder (e.g. README's "./cockpit/asset/logo.png"),
// which the browser can't resolve from the SPA — so map each to /api/docs/asset?path=<rel>.
// External (http/https/protocol-relative), data:, and already-absolute-api srcs are left alone.
/**
 * @param {string} html rendered doc HTML
 * @param {string} docRel root-relative path of the doc, so relative srcs resolve correctly
 * @param {string | null} project registry name, carried into asset URLs so the image is
 *   fetched from the same scope the doc was rendered from
 * @returns {string}
 */
function rewriteDocImages(html, docRel, project) {
  const docDir = dirname(docRel);
  const scopeQS = project ? `&project=${encodeURIComponent(project)}` : "";
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (m, pre, src, post) => {
    if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:") || src.startsWith("/api/")) return m;
    const rel = join(docDir, src).replace(/^(\.\/)+/, ""); // resolve ../ and ./ against the doc
    return `${pre}/api/docs/asset?path=${encodeURIComponent(rel)}${scopeQS}${post}`;
  });
}

// Renders to HTML that the UI injects with dangerouslySetInnerHTML, and `marked` does no
// sanitising (it dropped its sanitizer years ago), so whatever markdown this reads becomes
// script in the cockpit's origin. Which files it will read therefore matters a lot.
//
// It used to accept ANY .md under the kit root. That included board/specs/*.md — files
// this same service writes on request via PUT /api/spec/:id, and that agents author. So
// "write a spec, then ask for it to be rendered" was a way to run script here, and from
// there rewrite the board that agents act on.
//
// Now it serves only the curated set /api/docs already lists (the UI never asks for
// anything else — it renders paths straight out of that response). Specs are not in it.
// And since the curated set still includes agent-authored files (agents/, skills/), raw
// HTML in any rendered doc is neutered before it reaches the response: kept verbatim only
// when it matches sanitize.mjs's allowlist exactly, escaped wholesale otherwise (wired
// into marked at the top of this file).
app.get("/api/docs/render", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const rel = String(req.query.path || "");
  if (!listedDocPaths(scope.root).has(rel)) return res.status(404).json({ error: "not found" });
  const abs = resolve(join(scope.root, rel));
  // Belt and braces: the listing is built from the scope root, so this should never fail —
  // but the check is cheap and keeps the guarantee local to the handler that reads the file.
  if (!isInside(scope.root, abs) || !abs.endsWith(".md") || !existsSync(abs)) {
    return res.status(404).json({ error: "not found" });
  }
  try {
    // `async: false` pins the synchronous overload — marked's return type is
    // string | Promise<string>, and the response builds the HTML inline.
    const html = marked.parse(readFileSync(abs, "utf8"), { async: false });
    res.json({ path: rel, html: rewriteDocImages(html, rel, scope.name) });
  } catch (e) {
    res.status(500).json({ error: errMessage(e) });
  }
});

// Serve images referenced by the docs — path-allowlisted to the scope root, image extensions only.
app.get("/api/docs/asset", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const rel = String(req.query.path || "");
  const abs = resolve(join(scope.root, rel));
  if (!isInside(scope.root, abs) || !/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(abs) || !existsSync(abs)) {
    return res.status(404).end();
  }
  // SVG is XML that may carry <script>, and it executes if the file is opened directly
  // rather than via <img>. This endpoint stays open to SVG because docs legitimately use
  // it, so deny the asset any privileges of its own instead.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(abs);
});

// ── Reports (T-003 §5) — generated files under board/reports/, served in place ─────────
// Read-only. Names are validated against a strict basename pattern (no separators, so no
// traversal) AND must exist inside the scope's reports dir. Generated HTML is agent-authored
// content, so it never runs in the cockpit's origin: it ships with the same neutering CSP
// sandbox the asset endpoint uses. Markdown reports render through the same neutered marked
// pipeline as docs.
const SAFE_REPORT = /^[A-Za-z0-9._-]+\.(html|md)$/;

/** @param {Scope} scope */
function listReports(scope) {
  if (!existsSync(scope.reports)) return [];
  return readdirSync(scope.reports)
    .filter((f) => SAFE_REPORT.test(f))
    .sort()
    .map((f) => {
      const s = statSync(join(scope.reports, f));
      return { name: f, mtime: s.mtimeMs, size: s.size };
    });
}

app.get("/api/reports", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  res.json({ reports: listReports(scope) });
});

app.get("/api/reports/render", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const name = String(req.query.name || "");
  if (!SAFE_REPORT.test(name)) return res.status(400).json({ error: "Invalid report name." });
  const abs = join(scope.reports, name);
  if (!isInside(scope.reports, abs) || !existsSync(abs)) return res.status(404).json({ error: "not found" });
  if (name.endsWith(".md")) {
    try {
      const html = marked.parse(readFileSync(abs, "utf8"), { async: false });
      return res.json({ name, kind: "md", html });
    } catch (e) {
      return res.status(500).json({ error: errMessage(e) });
    }
  }
  // .html: serve the file itself, sandboxed. The UI shows it in an <iframe> pointed here.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.sendFile(abs);
});

// ── The long-form help page ──────────────────────────────────────────────────
// docs/help.html is the "how this all works" guide. It is HTML, and the docs browser above
// renders Markdown only (path-allowlisted, .md), so it had nowhere to be reached from and
// shipped unreferenced. Served here on its own route, under the same sandbox the .html
// reports use — it is a document, not an app, and nothing in it should run in our origin.
//
// Scope-aware like every other read: a portfolio project's vendored maestro/ has its own copy
// at the same relative path, so the help you read matches the kit version you are running.
const HELP_DOC = join("docs", "help.html");
app.get("/api/help/guide", (req, res) => {
  const scope = scopeOf(req, res);
  if (!scope) return;
  const abs = join(scope.root, HELP_DOC);
  if (!isInside(scope.root, abs) || !existsSync(abs)) {
    return res.status(404).json({ error: `No ${HELP_DOC} in this kit.` });
  }
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.sendFile(abs);
});

// Serve the built UI in production (dist/), if present.
const DIST = join(COCKPIT, "dist");
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/.*/, (_req, res) => res.sendFile(join(DIST, "index.html")));
}

// Loopback only. `app.listen(PORT)` binds 0.0.0.0, which put an unauthenticated read/write
// API on every interface — reachable by anyone sharing the network. Override only if you
// know why you need it (container port-forwarding is the usual reason).
const HOST = process.env.MAESTRO_HOST || "127.0.0.1";

// A port someone asked for by name is a promise we have to keep: `server/dev.mjs` probes a
// free port, points Vite's proxy at exactly that number, and then pins it here. Drifting to
// the next one would leave the UI proxying to nothing — worse than not starting. So an
// explicit PORT / --port binds or fails, and only the bare default is free to move.
// Two knobs, deliberately different:
//   PORT     — where to START looking. Still moves if that one is taken.
//   --port   — bind exactly this or fail.
// `--port` exists for the one caller that genuinely can't tolerate drift: server/dev.mjs
// probes a free port, tells Vite to proxy to that exact number, and only then starts the
// service. A service that quietly moved would leave the UI proxying into nothing. Everyone
// else wants PORT, which is a preference rather than a demand.
const PINNED_PORT = argValue("--port");
// Number(), not the raw string: listen() accepts both, and a non-numeric value silently
// became a named pipe instead of a port. Reject it here where we can say why.
for (const [label, value] of [["--port", PINNED_PORT], ["PORT", process.env.PORT]]) {
  if (value && !/^\d+$/.test(value.trim())) {
    console.error(`✗ ${label}="${value}" is not a port number. Use e.g. PORT=4700 npm run board`);
    process.exit(1);
  }
}
const PORT_BASE = Number(process.env.PORT) || DEFAULT_PORT;
const PORT = PINNED_PORT
  ? Number(PINNED_PORT)
  : await findFreePort(PORT_BASE, [HOST], PORT_SCAN_LIMIT);

const server = app.listen(PORT, HOST, () => {
  console.log(`AI Maestro cockpit data service on http://localhost:${PORT}`);
  if (!PINNED_PORT && PORT !== PORT_BASE) {
    console.log(`  (${PORT_BASE} was busy — another project's board, most likely.)`);
  }
  if (!LOCAL_HOSTS.has(HOST)) {
    console.log(`  ⚠ MAESTRO_HOST=${HOST} — this API has no authentication and is now`);
    console.log(`    reachable beyond this machine. Requests must still be addressed to localhost.`);
  }
  console.log(`Board: ${BOARD_DIR}`);
  if (!existsSync(DEFAULT_SCOPE.data)) console.log(`  ⚠ no data.json found there yet.`);
  if (REGISTRY_PATH) console.log(`Portfolio registry: ${REGISTRY_PATH}`);
});

// Express calls the listen callback before the bind result is known, so a port clash still
// prints the banner above — then the socket dies, the event loop drains, and the process
// exits 0. `concurrently -k` reads that as a clean exit and takes vite down with it, so the
// board vanishes with no error at all. Turn the bind failure back into a real error.
//
// Reaching here with an unpinned port means we lost a race: findFreePort saw the port free,
// then something else grabbed it in the moment before we bound. Rare, and not worth a retry
// loop — saying so plainly beats a silent exit.
server.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
  if (err.code === "EADDRINUSE" && PINNED_PORT) {
    console.error(`✗ Port ${PORT} is already in use, so the board can't start.`);
    console.error(`  --port pins a port exactly, so it won't fall back to a free one.`);
    console.error(`  Find what's holding it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`  Or drop --port and let the board pick its own port.`);
  } else if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} was taken by another process a moment after we checked it.`);
    console.error(`  Just start the board again.`);
  } else {
    console.error(`✗ The cockpit data service could not start: ${errMessage(err)}`);
  }
  process.exit(1);
});
