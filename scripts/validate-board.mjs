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
import { readPlanForBoard } from "./plan-io.mjs";
import { planCompleteness, planIsGating, planCoverage } from "./plan-core.mjs";
import { assignLanes, parallelismLostToVagueness, laneCount } from "./lane-core.mjs";
import { eligibleTickets } from "./board-core.mjs";

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
 * The codes a ticket's `agent_plan` may legally reference.
 *
 * The PROJECT'S ROSTER WINS. `config.json` lists the agents this project
 * actually runs, and a project narrows that list on purpose — dropping
 * `devops` from the roster means work must not be routed to devops. Reading
 * the kit's `agents/` directory instead answers a different question ("what
 * agents does the kit ship?") and gets both directions wrong:
 *
 *   - false NEGATIVE: a plan routed to an agent the project dropped passes
 *     validation, then has nowhere to run;
 *   - false POSITIVE: a project whose roster the kit doesn't ship fails
 *     validation on a perfectly good board.
 *
 * The cockpit already answers this correctly — see cockpit/server/index.mjs,
 * `config.roster.map(agentFileToCode)` — so before this fix the CLI and the UI
 * could disagree about whether the same board was valid. The directory scan
 * stays as the fallback for a board with no config beside it (and `--agents`
 * still overrides everything, for validating a board that lives elsewhere).
 */
function loadAgentCodes(config) {
  if (agentsDirExplicit) return codesFromDir();
  if (Array.isArray(config?.roster) && config.roster.length > 0) {
    return new Set(config.roster.map((name) => agentFileToCode(String(name).replace(/\.md$/, ""))));
  }
  return codesFromDir();
}

function codesFromDir() {
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

  const { errors, warnings, eligibleCount } = validateBoard(board, {
    archived: archive.tickets ?? [],
    archivedEpics: archive.epics ?? [],
    agentCodes: loadAgentCodes(config),
    config,
    plan,
  });

  const pre = [];
  if (configWarning) pre.push(configWarning);
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
