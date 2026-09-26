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

import { readFileSync, existsSync, readdirSync, realpathSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { validateBoard, agentFileToCode } from "./board-core.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import { planCompleteness, planIsGating, planCoverage } from "./plan-core.mjs";
import { assignLanes, parallelismLostToVagueness, laneCount } from "./lane-core.mjs";
import { eligibleTickets } from "./board-core.mjs";
import { validateSwarmConfig } from "./swarm-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const args = process.argv.slice(2);
const boardPath = args.find((a) => !a.startsWith("--")) ?? "board/data.json";
const agentsDirExplicit = args.indexOf("--agents") !== -1;
const agentsDir = (() => {
  const i = args.indexOf("--agents");
  return i !== -1 ? args[i + 1] : join(KIT_ROOT, "agents");
})();
const configArg = (() => {
  const i = args.indexOf("--config");
  return i !== -1 ? args[i + 1] : null;
})();

function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return e.code === "ENOENT" ? fallback : e; }
}

/**
 * The codes a ticket's `agent_plan` may legally reference (T-009).
 *
 * A code is only dispatchable if an agent FILE backs it, so the base set is the installed
 * agent files: `--agents <dir>` if given, else the project's rendered `.claude/agents/`
 * (beside config.json, honouring `outDir`), else the kit's `agents/`.
 *
 * The PROJECT'S ROSTER then narrows and orders that set. Dropping `devops` from the roster
 * means work must not be routed to devops even if the file is still installed; and a roster
 * entry with no file behind it is an error — it names an agent that cannot run. An installed
 * file the roster leaves out is only a warning. With no config or an empty roster the
 * directory scan is the whole answer, as before.
 *
 * Legacy roster names render/sync.mjs renames (`delivery-tpm` -> `tpm`) resolve to the new
 * file with a warning to rename, rather than an error.
 */
const LEGACY_ROSTER_NAMES = { "delivery-tpm": "tpm" };

/**
 * Where the installed agent files live, and whether that is the project's own rendered set
 * (only then is an off-roster file worth a warning — the kit catalogue always ships more
 * agents than a project adopts). Codex-only renders have `.codex/agents/*.toml`, same basenames.
 */
/** realpath when the path exists (so /tmp and /private/tmp compare equal), else the path as given. */
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

function installedAgentsDir(config, configPath) {
  const kit = join(KIT_ROOT, "agents");
  if (agentsDirExplicit) {
    const dir = resolve(agentsDir);
    return { dir, ext: ".md", rendered: realOrSelf(dir) !== realOrSelf(kit) };
  }
  if (config && configPath) {
    const out = resolve(dirname(configPath), typeof config.outDir === "string" ? config.outDir : ".");
    for (const [sub, ext] of [[".claude", ".md"], [".codex", ".toml"]]) {
      const rendered = join(out, sub, "agents");
      if (existsSync(rendered)) return { dir: rendered, ext, rendered: true };
    }
  }
  return { dir: kit, ext: ".md", rendered: false };
}

/** Map of code -> file name for every agent file in `dir`, or null if the dir is missing. */
function filesByCode(dir, ext = ".md") {
  if (!existsSync(dir)) return null;
  const map = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(ext)).sort()) {
    map.set(agentFileToCode(f.slice(0, -ext.length)), f);
  }
  return map;
}

/** Project-local agents render/sync.mjs overlays onto the kit's (its projAgentNames):
 * `custom/agents/` and, outside the kit itself, the legacy `<project>/agents/`. */
function projectOverlayCodes(configPath) {
  const codes = new Set();
  if (!configPath) return codes;
  const project = resolve(dirname(configPath));
  const dirs = [...(project === KIT_ROOT ? [] : [join(project, "agents")]), join(project, "custom", "agents")];
  for (const d of dirs) for (const code of filesByCode(d)?.keys() ?? []) codes.add(code);
  return codes;
}

function loadAgentCodes(config, configPath) {
  const { dir, ext, rendered } = installedAgentsDir(config, configPath);
  const installed = filesByCode(dir, ext);
  const overlay = projectOverlayCodes(configPath);
  const errors = [];
  const warnings = [];
  if (!Array.isArray(config?.roster) || config.roster.length === 0) {
    return { codes: installed ? new Set(installed.keys()) : null, errors, warnings };
  }
  if (!installed && overlay.size === 0) {
    errors.push(`No installed agents directory at ${dir} — cannot check the roster against agent files.`);
    return { codes: new Set(), errors, warnings };
  }
  const codes = new Set();
  for (const entry of config.roster) {
    let name = String(entry).replace(/\.md$/, "");
    if (LEGACY_ROSTER_NAMES[name]) {
      warnings.push(`config.roster: "${name}" is a legacy name — rename it to "${LEGACY_ROSTER_NAMES[name]}".`);
      name = LEGACY_ROSTER_NAMES[name];
    }
    const code = agentFileToCode(name);
    if (!installed?.has(code) && !overlay.has(code)) {
      errors.push(`config.roster: "${entry}" has no installed agent file (${name}${ext}) in ${dir} — it cannot be dispatched.`);
      continue;
    }
    codes.add(code);
  }
  if (rendered && installed) for (const [code, file] of installed) {
    if (!codes.has(code)) warnings.push(`Installed agent file ${file} (${dir}) is not on the roster — it will not be dispatched.`);
  }
  return { codes, errors, warnings };
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

  // config.json lives one level up from board/ (the project dir) by default; used for
  // model-floor and human-gate checks. --config overrides, for a board that keeps config
  // elsewhere (or, per kit-075 §2a, under a different filename like lense.config.json).
  const configPath = configArg ?? join(dirname(boardPath), "..", "config.json");
  const configExists = existsSync(configPath);
  const configRaw = configExists ? readJSON(configPath, null) : null;
  const config = configRaw instanceof Error ? null : configRaw;

  // A missing or unparsable config used to make the model-floor and human-gate checks a
  // silent no-op — a green board that was actually running unchecked. Loud now: the checks
  // still don't run (there's nothing to check them against), but the board says so.
  const configWarning = !configExists
    ? `No config.json at ${configPath} — model-floor and human-gate checks are skipped. Pass --config <path> if it lives elsewhere.`
    : configRaw instanceof Error
      ? `${configPath} is not valid JSON (${configRaw.message}) — model-floor and human-gate checks are skipped.`
      : null;

  // The plan sits beside the board. A missing one reads as an empty plan, which turns the scope
  // gate off rather than failing the board — a project that hasn't planned yet is a normal state.
  let plan = null;
  let planError = null;
  try { plan = readPlanForBoard(boardPath); } catch (e) { planError = e.message; }

  const agents = loadAgentCodes(config, configExists ? configPath : null);
  const { errors, warnings, eligibleCount } = validateBoard(board, {
    archived: archive.tickets ?? [],
    archivedEpics: archive.epics ?? [],
    agentCodes: agents.codes,
    config,
    plan,
  });
  errors.unshift(...agents.errors);
  if (config) errors.push(...validateSwarmConfig(config));

  const pre = [];
  if (configWarning) pre.push(configWarning);
  pre.push(...agents.warnings);
  if (planError) pre.push(`${planError} — the scope gate is skipped until it parses.`);

  finish(errors, [...pre, ...warnings], eligibleCount, plan, board, archive, config);
}

function finish(errors, warnings, eligibleCount, plan, board, archive, config) {
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  for (const e of errors) console.log(`  ✗  ${e}`);
  if (errors.length === 0) {
    console.log(`\n✓ Board valid. ${warnings.length} warning(s).`);
    if (eligibleCount != null) console.log(`  ${eligibleCount} ticket(s) eligible to run now.`);
    // The plan line is the one that answers "are we building the right thing?" — printed here
    // so it lands in the same place people already look for "is the board OK?".
    if (plan) {
      if (!planIsGating(plan)) {
        console.log(`  No project plan yet — the scope gate is off. Run /plan-update to write one.`);
      } else {
        const c = planCompleteness(plan);
        const uncovered = planCoverage(plan, board?.tickets ?? [], archive?.tickets ?? []).filter((r) => !r.tickets.length);
        console.log(`  Plan ${c.percent}% complete${c.requiredGaps.length ? `, ${c.requiredGaps.length} required gap(s) open` : ""}.`);
        if (uncovered.length) {
          console.log(`  ${uncovered.length} plan item(s) with no ticket: ${uncovered.map((r) => r.id).join(", ")}`);
        }
      }
    }

    // Parallelism is a property of the board, so it belongs in the board's report — but it is
    // never a warning: a board where nothing can run in parallel is correct, just slower.
    if (board && config) {
      const ready = eligibleTickets(board, archive?.tickets ?? [], { plan, archivedEpics: archive?.epics ?? [] });
      if (ready.length > 1) {
        const { lanes } = assignLanes(ready, config);
        const startable = lanes.filter((l) => !l.exclusive).length;
        const lost = parallelismLostToVagueness(ready, config);
        console.log(`  ${startable} of ${laneCount(config)} lane(s) would start in parallel.` +
          (lost.length ? ` ${lost.length} pair(s) held back only by undeclared \`touches\` — see 'maestro lanes plan'.` : ""));
      }
    }
    process.exit(0);
  } else {
    console.log(`\n✗ Board invalid: ${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }
}

main();
