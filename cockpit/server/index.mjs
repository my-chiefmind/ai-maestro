#!/usr/bin/env node
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
 * Endpoints:
 *   GET  /api/board            -> { boardDir, epics, tickets, archived, archivedEpics, version }
 *   GET  /api/board/version    -> { version }                (cheap poll for auto-refresh)
 *   PUT  /api/board            -> { epics, tickets, version } (409 on stale version, 400 on invalid)
 *   GET  /api/config           -> { name, areas, planSteps, models, humanGates } | null
 *   GET  /api/roster           -> { agents: [...], skills: [...] }
 *   GET  /api/spec/:id         -> { id, content }
 *   PUT  /api/spec/:id         -> { ok }                     ({ content })
 *   GET  /api/docs             -> { sections: [{ key, label, files: [{ path, title }] }] }
 *   GET  /api/docs/render      -> { path, html }             (?path=<repo-relative .md>)
 */

import express from "express";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync, rmSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";
import { validateBoard, MODELS, agentFileToCode } from "../../scripts/board-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const COCKPIT = resolve(__dir, "..");
const KIT_ROOT = resolve(COCKPIT, ".."); // the cockpit lives inside the kit
const PORT = process.env.PORT || 4600;
const MAX_BACKUPS = 20;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

function resolveBoardDir() {
  const candidates = [
    argValue("--board"),
    process.env.MAESTRO_BOARD_DIR,
    resolve(COCKPIT, "..", "board"),
    resolve(process.cwd(), "board"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(resolve(c), "data.json"))) return resolve(c);
  }
  return resolve(candidates[0] ?? join(process.cwd(), "board"));
}

const BOARD_DIR = resolveBoardDir();
const PROJECT_DIR = resolve(BOARD_DIR, ".."); // config.json / .claude live one level up
const DATA = join(BOARD_DIR, "data.json");
const ARCHIVE = join(BOARD_DIR, "archive.json");
const BACKUPS = join(BOARD_DIR, ".backups");
const SPECS = join(BOARD_DIR, "specs");
const CONFIG = join(PROJECT_DIR, "config.json");

function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return fallback; }
}

// Cheap content version: mtime+size. Changes whenever the file is written (by us or an agent).
function boardVersion() {
  if (!existsSync(DATA)) return "0-0";
  const s = statSync(DATA);
  return `${Math.round(s.mtimeMs)}-${s.size}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// The agent codes this project knows about, derived from config.roster (used for validation
// and for the UI's agent_plan picker). Null when there's no config → skip the agent-code check.
function loadConfig() {
  return existsSync(CONFIG) ? readJSON(CONFIG, null) : null;
}
function planStepsFromConfig(config) {
  if (!config?.roster) return null;
  const codes = config.roster.map(agentFileToCode).filter((c) => c !== "orchestrator");
  if (!codes.includes("merge")) codes.push("merge"); // the terminal land step
  return [...new Set(codes)];
}

function pruneBackups() {
  if (!existsSync(BACKUPS)) return;
  const files = readdirSync(BACKUPS).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    try { rmSync(join(BACKUPS, f), { force: true }); } catch { /* best effort */ }
  }
}

// Parse `name` and `description` out of a Markdown file's YAML frontmatter.
function frontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const app = express();
app.use(express.json({ limit: "8mb" }));

// ── Board ──────────────────────────────────────────────────────────────────────
app.get("/api/board", (_req, res) => {
  if (!existsSync(DATA)) {
    return res.status(404).json({ error: `No board/data.json at ${BOARD_DIR}` });
  }
  const data = readJSON(DATA, { epics: [], tickets: [] });
  const arch = readJSON(ARCHIVE, { epics: [], tickets: [] });
  res.json({
    boardDir: BOARD_DIR,
    epics: data.epics ?? [],
    tickets: data.tickets ?? [],
    archived: arch.tickets ?? [],
    archivedEpics: arch.epics ?? [],
    version: boardVersion(),
  });
});

app.get("/api/board/version", (_req, res) => res.json({ version: boardVersion() }));

app.put("/api/board", (req, res) => {
  const { epics, tickets, version } = req.body ?? {};
  if (!Array.isArray(epics) || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Body must be { epics: [], tickets: [] }." });
  }

  // Optimistic concurrency: refuse to overwrite a board that changed since the client loaded.
  const current = boardVersion();
  if (version != null && version !== current && existsSync(DATA)) {
    const data = readJSON(DATA, { epics: [], tickets: [] });
    const arch = readJSON(ARCHIVE, { epics: [], tickets: [] });
    return res.status(409).json({
      error: "The board changed on disk since you loaded it (an agent or another tab wrote it). Reloaded the latest — reapply your edit.",
      current: {
        boardDir: BOARD_DIR,
        epics: data.epics ?? [], tickets: data.tickets ?? [],
        archived: arch.tickets ?? [], archivedEpics: arch.epics ?? [],
        version: current,
      },
    });
  }

  // Same integrity rules as the CLI — the pretty UI cannot bypass them.
  const arch = readJSON(ARCHIVE, { epics: [], tickets: [] });
  const config = loadConfig();
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
    if (existsSync(DATA)) {
      mkdirSync(BACKUPS, { recursive: true });
      copyFileSync(DATA, join(BACKUPS, `data.${stamp()}.json`));
      pruneBackups();
    }
    writeFileSync(DATA, JSON.stringify({ epics, tickets }, null, 2) + "\n");
    res.json({ ok: true, version: boardVersion() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── Config (drives the UI's area / agent_plan / model pickers) ───────────────────
app.get("/api/config", (_req, res) => {
  const config = loadConfig();
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
app.get("/api/roster", (_req, res) => {
  // Prefer the rendered project roster; fall back to the kit's source roster.
  const agentsDir = existsSync(join(PROJECT_DIR, ".claude", "agents"))
    ? join(PROJECT_DIR, ".claude", "agents") : join(KIT_ROOT, "agents");
  const skillsRoot = existsSync(join(PROJECT_DIR, ".claude", "skills"))
    ? join(PROJECT_DIR, ".claude", "skills") : join(KIT_ROOT, "skills");

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
  const { id } = req.params;
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: "Invalid spec id." });
  const p = join(SPECS, `${id}.md`);
  res.json({ id, content: existsSync(p) ? readFileSync(p, "utf8") : "" });
});
app.put("/api/spec/:id", (req, res) => {
  const { id } = req.params;
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: "Invalid spec id." });
  const content = String(req.body?.content ?? "");
  try {
    mkdirSync(SPECS, { recursive: true });
    writeFileSync(join(SPECS, `${id}.md`), content);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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

// Title = first Markdown heading, else the frontmatter name, else the filename.
function docTitle(abs, rel) {
  try {
    const text = readFileSync(abs, "utf8");
    const h = /^#\s+(.+)$/m.exec(text);
    if (h) return h[1].trim();
    const html = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
    if (html) return html[1].replace(/<[^>]+>/g, "").trim();
    const fm = /^---\s*\n[\s\S]*?\bname:\s*["']?([^"'\n]+)["']?/m.exec(text);
    if (fm) return fm[1].trim();
  } catch { /* fall through */ }
  return rel.split("/").pop();
}

function sectionFiles(section) {
  let rels = section.files ?? [];
  if (section.dir) {
    const base = join(KIT_ROOT, section.dir);
    if (existsSync(base)) {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(base, e.name, "SKILL.md"))) rels.push(`${section.dir}/${e.name}/SKILL.md`);
        else if (e.isFile() && e.name.endsWith(".md")) rels.push(`${section.dir}/${e.name}`);
      }
    }
    rels.sort();
  }
  return rels
    .filter((rel) => existsSync(join(KIT_ROOT, rel)))
    .map((rel) => ({ path: rel, title: docTitle(join(KIT_ROOT, rel), rel) }));
}

app.get("/api/docs", (_req, res) => {
  const sections = DOC_SECTIONS
    .map((s) => ({ key: s.key, label: s.label, files: sectionFiles(s) }))
    .filter((s) => s.files.length);
  res.json({ sections });
});

// Rewrite relative <img src> in rendered docs to the image endpoint below. A doc's image
// links are relative to the doc's own folder (e.g. README's "./cockpit/asset/logo.png"),
// which the browser can't resolve from the SPA — so map each to /api/docs/asset?path=<rel>.
// External (http/https/protocol-relative), data:, and already-absolute-api srcs are left alone.
function rewriteDocImages(html, docRel) {
  const docDir = dirname(docRel);
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (m, pre, src, post) => {
    if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:") || src.startsWith("/api/")) return m;
    const rel = join(docDir, src).replace(/^(\.\/)+/, ""); // resolve ../ and ./ against the doc
    return `${pre}/api/docs/asset?path=${encodeURIComponent(rel)}${post}`;
  });
}

app.get("/api/docs/render", (req, res) => {
  const rel = String(req.query.path || "");
  const abs = resolve(join(KIT_ROOT, rel));
  // Path-allowlist: must resolve inside the kit and be a Markdown file that exists.
  if (!abs.startsWith(KIT_ROOT + "/") || !abs.endsWith(".md") || !existsSync(abs)) {
    return res.status(404).json({ error: "not found" });
  }
  try {
    res.json({ path: rel, html: rewriteDocImages(marked.parse(readFileSync(abs, "utf8")), rel) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve images referenced by the docs — path-allowlisted to the kit, image extensions only.
app.get("/api/docs/asset", (req, res) => {
  const rel = String(req.query.path || "");
  const abs = resolve(join(KIT_ROOT, rel));
  if (!abs.startsWith(KIT_ROOT + "/") || !/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(abs) || !existsSync(abs)) {
    return res.status(404).end();
  }
  res.sendFile(abs);
});

// Serve the built UI in production (dist/), if present.
const DIST = join(COCKPIT, "dist");
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/.*/, (_req, res) => res.sendFile(join(DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`AI Maestro cockpit data service on http://localhost:${PORT}`);
  console.log(`Board: ${BOARD_DIR}`);
  if (!existsSync(DATA)) console.log(`  ⚠ no data.json found there yet.`);
});
