#!/usr/bin/env node
/**
 * validate-board.mjs — structural + logical integrity check for a Maestro board.
 *
 * Usage:
 *   node scripts/validate-board.mjs board/data.json [--agents ./agents]
 *
 * Loads the sibling archive.json (if present) so that dependencies on already-landed
 * tickets are recognised — a board stays valid after tickets are archived.
 *
 * Exit code 0 = valid, 1 = problems found. No third-party dependencies.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { validateBoard, agentFileToCode } from "./board-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const args = process.argv.slice(2);
const boardPath = args.find((a) => !a.startsWith("--")) ?? "board/data.json";
const agentsDir = (() => {
  const i = args.indexOf("--agents");
  return i !== -1 ? args[i + 1] : join(KIT_ROOT, "agents");
})();

function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return e.code === "ENOENT" ? fallback : e; }
}

function loadAgentCodes() {
  if (!existsSync(agentsDir)) return null;
  return new Set(
    readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => agentFileToCode(f.replace(/\.md$/, "")))
  );
}

function main() {
  if (!existsSync(boardPath)) {
    console.log(`  ✗  Board file not found: ${boardPath}`);
    return finish([`Board file not found: ${boardPath}`], []);
  }

  let board;
  try {
    board = JSON.parse(readFileSync(boardPath, "utf8"));
  } catch (e) {
    return finish([`Invalid JSON: ${e.message}`], []);
  }

  const archivePath = join(dirname(boardPath), "archive.json");
  const archive = readJSON(archivePath, { epics: [], tickets: [] });
  if (archive instanceof Error) {
    return finish([`Invalid JSON in ${archivePath}: ${archive.message}`], []);
  }

  // config.json lives one level up from board/ (the project dir); used for model-floor checks.
  const configPath = join(dirname(boardPath), "..", "config.json");
  const config = existsSync(configPath) ? readJSON(configPath, null) : null;

  const { errors, warnings, eligibleCount } = validateBoard(board, {
    archived: archive.tickets ?? [],
    archivedEpics: archive.epics ?? [],
    agentCodes: loadAgentCodes(),
    config: config instanceof Error ? null : config,
  });

  finish(errors, warnings, eligibleCount);
}

function finish(errors, warnings, eligibleCount) {
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  for (const e of errors) console.log(`  ✗  ${e}`);
  if (errors.length === 0) {
    console.log(`\n✓ Board valid. ${warnings.length} warning(s).`);
    if (eligibleCount != null) console.log(`  ${eligibleCount} ticket(s) eligible to run now.`);
    process.exit(0);
  } else {
    console.log(`\n✗ Board invalid: ${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }
}

main();
