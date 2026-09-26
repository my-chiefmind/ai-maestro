/** Supported public API for versioned, targeted project-plan changes. */
import { resolve, dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { withBoardLock } from "./board-io.mjs";
import { planPaths, readPlan as readPlanFile, planVersion, mutatePlan, PlanConflictError, PlanValidationError } from "./plan-io.mjs";
import { applyPlanOperation, PlanInputError, PlanNotFoundError } from "./plan-operations.mjs";
import { crossInitiativeConflicts } from "./board-core.mjs";
import { BoardLockError } from "./board-errors.mjs";
export { PlanInputError, PlanNotFoundError, PlanConflictError, PlanValidationError };
export class PlanLockError extends BoardLockError {
  constructor(message, detail = {}) { super(message, detail); this.name = "PlanLockError"; this.code = "EPLANLOCK"; }
}

function lockErrors(fn) {
  try { return fn(); }
  catch (error) {
    if (error instanceof BoardLockError) throw new PlanLockError(error.message, { path: error.path, holder: error.holder, timeoutMs: error.timeoutMs });
    throw error;
  }
}

function pathOf(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new PlanInputError("Options must be an object.");
  const unknown = Object.keys(options).filter((key) => !["planPath", "boardPath", "operation", "params", "expectVersion", "projectName", "dryRun", "lockOptions", "allowBoardOrphans", "force"].includes(key));
  if (unknown.length) throw new PlanInputError(`Unknown plan option(s): ${unknown.join(", ")}.`);
  if (options.planPath !== undefined) {
    if (typeof options.planPath !== "string" || !options.planPath.trim() || !options.planPath.endsWith(".json")) throw new PlanInputError("planPath must name a JSON file.");
    return resolve(options.planPath);
  }
  if (options.boardPath !== undefined && (typeof options.boardPath !== "string" || !options.boardPath.trim())) throw new PlanInputError("boardPath must be a board path.");
  return resolve(planPaths(options.boardPath ?? "board/data.json").plan);
}
export function getPlanVersion(options = {}) {
  const path = pathOf(options);
  return lockErrors(() => withBoardLock(planPaths(path).boardDir, () => planVersion(path), { op: "plan-version", ...(options.lockOptions ?? {}) }));
}
export function readPlan(options = {}) {
  const path = pathOf(options);
  return lockErrors(() => withBoardLock(planPaths(path).boardDir, () => ({ plan: readPlanFile(path), version: planVersion(path) }), { op: "read-plan", ...(options.lockOptions ?? {}) }));
}
export function applyPlan(options = {}) {
  if (typeof options.operation !== "string") throw new PlanInputError("operation is required.");
  if (options.expectVersion != null && (typeof options.expectVersion !== "string" || !options.expectVersion)) throw new PlanInputError("expectVersion must be a non-empty string.");
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") throw new PlanInputError("dryRun must be a boolean.");
  if (options.force && options.operation !== "init") throw new PlanInputError("force only applies to init.");
  if (options.allowBoardOrphans && options.operation !== "removeItem") throw new PlanInputError("allowBoardOrphans only applies to removeItem.");
  const path = pathOf(options);
  return lockErrors(() => mutatePlan({ planPath: path, expectVersion: options.expectVersion, projectName: options.projectName, dryRun: options.dryRun, lockOptions: options.lockOptions, op: `plan-${options.operation}`, mutate: (plan) => {
    if (options.operation === "init" && existsSync(path) && !options.force) throw new PlanInputError(`A plan already exists at ${path}. Use maestro plan status to see it, or --force to reset it.`);
    const output = applyPlanOperation(plan, options.operation, options.params);
    const boardPath = join(dirname(path), "data.json");
    let board = null;
    try {
      if (existsSync(boardPath)) {
        const archivePath = join(dirname(path), "archive.json");
        const data = JSON.parse(readFileSync(boardPath, "utf8"));
        const archive = existsSync(archivePath) ? JSON.parse(readFileSync(archivePath, "utf8")) : {};
        board = { data, archivedEpics: archive.epics ?? [], archivedTickets: archive.tickets ?? [] };
      }
    } catch { /* an invalid board is the board validator's responsibility */ }
    if (options.operation === "removeInitiative") {
      const refs = output.result.references;
      if (board) {
        for (const epic of board.data.epics ?? []) if (epic.initiativeId === options.params.id) refs.push(`epic ${epic.id}`);
        for (const epic of board.archivedEpics) if (epic.initiativeId === options.params.id) refs.push(`archived epic ${epic.id}`);
      }
      if (refs.length) throw new PlanInputError(`${options.params.id} is still referenced by ${refs.length}: ${refs.join(", ")}. Reassign or clear them first. There is no --force.`);
    }
    if (board) {
      const conflicts = crossInitiativeConflicts(output.plan, board);
      if (conflicts.length) throw new PlanInputError(`Refusing to change ${options.params?.id ?? "plan"} — ${conflicts.length} board reference(s) would break and nothing has been written:\n${conflicts.map((item) => `  • ${item}`).join("\n")}`, { conflicts });
      if (options.operation === "removeItem") {
        const tickets = [...(board.data.tickets ?? []), ...board.archivedTickets];
        const traced = tickets.filter((ticket) => ticket.traces_to?.includes(options.params.id)).map((ticket) => ticket.id);
        if (traced.length && !options.allowBoardOrphans) throw new PlanInputError(`${options.params.id} is traced to by ${traced.join(", ")} — removing it puts those tickets out of scope. Re-trace them first, or pass --force.`, { traced });
        output.result.orphans = traced;
      }
    }
    return output;
  } }));
}
