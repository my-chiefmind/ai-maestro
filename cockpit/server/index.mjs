#!/usr/bin/env node
/**
 * Maestro cockpit data service.
 *
 * Serves a single Maestro board (board/data.json + board/archive.json) and writes edits
 * back in place, keeping a timestamped backup of every write.
 *
 * Board location resolves from (first that exists):
 *   1. --board <dir> / MAESTRO_BOARD_DIR
 *   2. ../board relative to this cockpit
 *   3. ./board (cwd)
 *
 * Endpoints:
 *   GET  /api/board   -> { epics, tickets, archived, archivedEpics }
 *   PUT  /api/board   -> { epics, tickets }   (writes data.json + a backup)
 */

import express from "express";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const COCKPIT = resolve(__dir, "..");
const PORT = process.env.PORT || 4600;

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
  // Fall back to the first candidate so the error message is useful.
  return resolve(candidates[0] ?? join(process.cwd(), "board"));
}

const BOARD_DIR = resolveBoardDir();
const DATA = join(BOARD_DIR, "data.json");
const ARCHIVE = join(BOARD_DIR, "archive.json");
const BACKUPS = join(BOARD_DIR, ".backups");

function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return fallback; }
}

// A deterministic-enough timestamp for backup filenames (no Date restriction here).
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const app = express();
app.use(express.json({ limit: "8mb" }));

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
  });
});

app.put("/api/board", (req, res) => {
  const { epics, tickets } = req.body ?? {};
  if (!Array.isArray(epics) || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Body must be { epics: [], tickets: [] }." });
  }
  try {
    if (existsSync(DATA)) {
      mkdirSync(BACKUPS, { recursive: true });
      copyFileSync(DATA, join(BACKUPS, `data.${stamp()}.json`));
    }
    writeFileSync(DATA, JSON.stringify({ epics, tickets }, null, 2) + "\n");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve the built UI in production (dist/), if present.
const DIST = join(COCKPIT, "dist");
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA fallback (Express 5: use a regex, not the bare "*" string).
  app.get(/.*/, (_req, res) => res.sendFile(join(DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Maestro cockpit data service on http://localhost:${PORT}`);
  console.log(`Board: ${BOARD_DIR}`);
  if (!existsSync(DATA)) console.log(`  ⚠ no data.json found there yet.`);
});
