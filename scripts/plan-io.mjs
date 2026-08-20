/**
 * plan-io.mjs — reading and writing board/plan.json safely.
 *
 * Same discipline as board-io.mjs, and deliberately the SAME LOCK: plan.json sits in the board
 * directory and `withBoardLock` guards that directory, not a single file. That matters because
 * the scope gate reads the plan and the board together — a run that took the board lock, read
 * a plan mid-write, and decided a ticket was out of scope would block real work for no reason.
 * One lock, one coherent view.
 *
 * Every write regenerates plan.md from plan.json in the same critical section, so the mirror
 * can never describe a plan that isn't on disk.
 *
 * No third-party dependencies.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { withBoardLock, boardVersion, writeAtomic, BoardConflictError } from "./board-io.mjs";
import { normalisePlan, validatePlan, renderPlanMd, emptyPlan } from "./plan-core.mjs";

export { BoardConflictError as PlanConflictError };

/**
 * Where the plan lives, given any board path (data.json, the board dir, or plan.json itself).
 * Callers pass whichever they happen to hold, and none of them should have to know the layout.
 */
export function planPaths(anyBoardPath) {
  const p = String(anyBoardPath ?? "board");
  const dir = p.endsWith(".json") ? dirname(p) : p;
  return { boardDir: dir, plan: join(dir, "plan.json"), md: join(dir, "plan.md"), data: join(dir, "data.json") };
}

/** Content version of the plan, for compare-and-swap. Opaque; only equality means anything. */
export function planVersion(planPath) {
  return boardVersion(planPath);
}

/**
 * Read a plan from disk, normalised. A missing plan reads as an empty one — a project that has
 * not planned yet is a normal state, not an error, and every caller then works with the same
 * shape whether or not the file exists.
 */
export function readPlan(planPath) {
  if (!existsSync(planPath)) return emptyPlan();
  const raw = readFileSync(planPath, "utf8");
  if (!raw.trim()) return emptyPlan();
  try {
    return normalisePlan(JSON.parse(raw));
  } catch (e) {
    // Never fall back to an empty plan on a parse error: the caller would "mutate" a blank
    // plan and write it, silently destroying every requirement in the file.
    throw new Error(`Invalid JSON in ${planPath}: ${e.message}. Fix the file before writing to it.`);
  }
}

/** Read the plan that belongs beside a board, without caring whether it exists. */
export function readPlanForBoard(anyBoardPath) {
  return readPlan(planPaths(anyBoardPath).plan);
}

/**
 * Read → mutate → validate → write plan.json, and re-render plan.md, under the board lock.
 *
 * `mutate` receives the plan as it is ON DISK RIGHT NOW, inside the lock. Callers express a
 * change ("add this requirement"), never a whole plan they read earlier — which is what makes
 * a cockpit tab and an agent writing at the same moment safe rather than last-write-wins.
 *
 * @param {object} p
 * @param {string} p.planPath
 * @param {(plan: any) => any} p.mutate      returns the next plan (or mutates and returns it)
 * @param {string} [p.expectVersion]         refuse the write if the plan moved on disk
 * @param {string} [p.projectName]           title for the rendered plan.md
 * @param {string} [p.op]                    label recorded in the lock file
 * @returns {{plan:any, version:string, changed:boolean, warnings:string[]}}
 */
export function mutatePlan({ planPath, mutate, expectVersion, projectName = "Project", op = "plan-write" }) {
  const dir = dirname(planPath);
  const mdPath = join(dir, "plan.md");

  return withBoardLock(dir, () => {
    const onDisk = planVersion(planPath);
    if (expectVersion != null && expectVersion !== onDisk) {
      throw new BoardConflictError(
        `The plan at ${planPath} changed on disk since you read it (expected ${expectVersion}, ` +
        `found ${onDisk}). Re-read it and reapply the change — writing now would silently drop ` +
        `whatever the other writer added.`,
        { expected: expectVersion, actual: onDisk, path: planPath },
      );
    }

    const current = readPlan(planPath);
    const next = normalisePlan(mutate(current) ?? current);

    const { errors, warnings } = validatePlan(next);
    if (errors.length) {
      throw new Error(
        `Refusing to write ${basename(planPath)} — the result would be an invalid plan:\n` +
        errors.map((e) => `  • ${e}`).join("\n"),
      );
    }

    const planText = JSON.stringify(next, null, 2) + "\n";
    const mdText = renderPlanMd(next, projectName);
    const planChanged = !existsSync(planPath) || readFileSync(planPath, "utf8") !== planText;
    const mdChanged = !existsSync(mdPath) || readFileSync(mdPath, "utf8") !== mdText;

    // plan.json first: it is the source of truth. If the process dies between the two writes,
    // a stale mirror is a cosmetic problem that the next write fixes, whereas a mirror
    // promising content that plan.json doesn't hold would be read as real.
    if (planChanged) writeAtomic(planPath, planText);
    if (mdChanged) writeAtomic(mdPath, mdText);

    return { plan: next, version: planVersion(planPath), changed: planChanged || mdChanged, warnings };
  }, { op });
}
