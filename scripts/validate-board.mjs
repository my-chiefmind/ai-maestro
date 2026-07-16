#!/usr/bin/env node
/**
 * validate-board.mjs — structural + logical integrity check for a Maestro board.
 *
 * Usage:
 *   node scripts/validate-board.mjs board/data.json [--agents ./agents]
 *
 * Exit code 0 = valid, 1 = problems found. No third-party dependencies.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const args = process.argv.slice(2);
const boardPath = args.find((a) => !a.startsWith("--")) ?? "board/data.json";
const agentsDir = (() => {
  const i = args.indexOf("--agents");
  return i !== -1 ? args[i + 1] : join(KIT_ROOT, "agents");
})();

const STATUSES  = ["backlog", "todo", "in-progress", "review", "blocked", "done"];
const PRIORITY  = ["P0", "P1", "P2", "P3"];
const SWAG      = ["XS", "S", "M", "L", "XL"];
const MODELS    = ["haiku", "sonnet", "opus"];
const MODES     = ["single-agent", "multi-agent"];
const TERMINAL  = new Set(["qa", "pd", "merge"]); // gates appended automatically

const errors = [];
const warnings = [];
const err  = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function loadAgentCodes() {
  // An agent file agents/<code>.md defines agent code <code> (frontmatter name may differ).
  if (!existsSync(agentsDir)) return null;
  return new Set(
    readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
  );
}

// Map file basenames (backend-developer) to the short codes used in agent_plan (backend).
const CODE_ALIASES = {
  "backend-developer": "backend",
  "frontend-developer": "frontend",
  "principal-engineer": "pe",
  "principal-delivery": "pd",
};

function main() {
  if (!existsSync(boardPath)) {
    err(`Board file not found: ${boardPath}`);
    return report();
  }

  let board;
  try {
    board = JSON.parse(readFileSync(boardPath, "utf8"));
  } catch (e) {
    err(`Invalid JSON: ${e.message}`);
    return report();
  }

  if (!Array.isArray(board.epics))   err("Missing or non-array `epics`.");
  if (!Array.isArray(board.tickets)) err("Missing or non-array `tickets`.");
  if (errors.length) return report();

  // ── Epics ──
  const epicIds = new Set();
  for (const e of board.epics) {
    if (!e.id)   err(`Epic missing id: ${JSON.stringify(e).slice(0, 60)}`);
    if (!e.name) warn(`Epic ${e.id} missing name.`);
    if (epicIds.has(e.id)) err(`Duplicate epic id: ${e.id}`);
    epicIds.add(e.id);
  }

  // ── Known agent codes ──
  const fileCodes = loadAgentCodes();
  const knownCodes = fileCodes
    ? new Set([...fileCodes].map((c) => CODE_ALIASES[c] ?? c))
    : null;

  // ── Tickets ──
  const ticketIds = new Set();
  const deps = new Map(); // id -> [depends_on]
  const statusById = new Map();

  for (const t of board.tickets) {
    const id = t.id ?? "(no id)";
    if (!t.id)     err(`Ticket missing id: ${JSON.stringify(t).slice(0, 60)}`);
    if (ticketIds.has(t.id)) err(`Duplicate ticket id: ${t.id}`);
    ticketIds.add(t.id);
    statusById.set(t.id, t.status);

    if (!t.status || !STATUSES.includes(t.status)) err(`${id}: invalid status "${t.status}".`);
    if (t.priority && !PRIORITY.includes(t.priority)) err(`${id}: invalid priority "${t.priority}".`);
    if (t.swag && !SWAG.includes(t.swag)) err(`${id}: invalid swag "${t.swag}".`);
    if (t.model && !MODELS.includes(t.model)) err(`${id}: invalid model "${t.model}".`);
    else if (!t.model) warn(`${id}: no model set (will fall back to the area default).`);
    if (t.execution_mode && !MODES.includes(t.execution_mode)) err(`${id}: invalid execution_mode "${t.execution_mode}".`);

    if (t.epicId && !epicIds.has(t.epicId)) err(`${id}: epicId "${t.epicId}" does not exist.`);

    if (t.agent_plan) {
      if (!Array.isArray(t.agent_plan)) err(`${id}: agent_plan must be an array.`);
      else if (knownCodes) {
        for (const code of t.agent_plan) {
          if (!knownCodes.has(code) && !TERMINAL.has(code)) {
            err(`${id}: agent_plan references unknown agent "${code}".`);
          }
        }
      }
    }

    deps.set(t.id, Array.isArray(t.depends_on) ? t.depends_on : []);
  }

  // ── Dependency integrity ──
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (!ticketIds.has(d)) err(`${id}: depends_on "${d}" which does not exist.`);
    }
  }

  // ── Cycle detection ──
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...ticketIds].map((id) => [id, WHITE]));
  const stack = [];
  const visit = (id) => {
    color.set(id, GREY);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!ticketIds.has(d)) continue;
      if (color.get(d) === GREY) {
        const cyc = stack.slice(stack.indexOf(d)).concat(d).join(" → ");
        err(`Dependency cycle: ${cyc}`);
      } else if (color.get(d) === WHITE) {
        visit(d);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const id of ticketIds) if (color.get(id) === WHITE) visit(id);

  // ── Eligibility sanity ──
  const eligible = [...ticketIds].filter((id) => {
    const t = board.tickets.find((x) => x.id === id);
    return (
      t.status === "todo" &&
      !t.human_gate &&
      (deps.get(id) ?? []).every((d) => statusById.get(d) === "done")
    );
  });
  if (eligible.length === 0) {
    warn("No eligible `todo` ticket right now — the orchestrator will report idle.");
  }

  report(eligible.length);
}

function report(eligibleCount) {
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  for (const e of errors)   console.log(`  ✗  ${e}`);
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
