/**
 * Supported public API for reading and applying targeted Maestro board changes.
 * Callers provide a board directory or data.json path; no whole-board replacement is exposed.
 */
import { withBoardLock, mutateBoard, boardVersion } from "./board-io.mjs";
import { join } from "node:path";
import { loadBoardContext, resolveBoardPaths, validateBoardContext } from "./board-context.mjs";
import {
  validateBoard, ticketEligibilityVerdict, ELIGIBILITY_REASON_CODES, isSafeEligibilityReference,
} from "./board-core.mjs";
import { BoardInputError, BoardLockError, BoardNotFoundError } from "./board-errors.mjs";
import {
  createTicketOperation, editTicketOperation, setTicketStatusOperation, setTicketEpicOperation,
  createEpicOperation, editEpicOperation, archiveTicketOperation, dropTicketOperation,
} from "./board-operations.mjs";

export { validateBoard };
export { ELIGIBILITY_REASON_CODES };
export {
  BoardInputError, BoardNotFoundError, BoardDuplicateError, BoardValidationError,
  BoardConflictError, BoardLockError,
} from "./board-errors.mjs";

export function getBoardVersion(options = {}) {
  const paths = resolveBoardPaths(options);
  return withBoardLock(paths.boardDir, () => boardVersion(paths.dataPath), {
    op: "read-version", ...(options.lockOptions ?? {}),
  });
}

export function readBoard(options = {}) {
  const paths = resolveBoardPaths(options);
  return withBoardLock(paths.boardDir, () => {
    const context = loadBoardContext(options);
    const verdict = validateBoardContext(context);
    return {
      data: context.data, archive: context.archive, config: context.config, plan: context.plan,
      version: boardVersion(paths.dataPath), archiveVersion: boardVersion(paths.archivePath),
      errors: verdict.errors, warnings: verdict.warnings,
    };
  }, { op: "read-board", ...(options.lockOptions ?? {}) });
}

function eligibilitySnapshot(options = {}) {
  const paths = resolveBoardPaths(options);
  try {
    return withBoardLock(paths.boardDir, () => {
      const context = loadBoardContext(options);
      const verdicts = (context.data.tickets ?? []).map((ticket) => ticketEligibilityVerdict(ticket, {
        data: context.data,
        archivedTickets: context.archive.tickets ?? [],
        archivedEpics: context.archive.epics ?? [],
        plan: context.plan,
      }));
      return {
        verdicts,
        version: boardVersion(paths.dataPath),
        archiveVersion: boardVersion(paths.archivePath),
        planVersion: boardVersion(join(paths.boardDir, "plan.json")),
      };
    }, { op: "read-eligibility", ...(options.lockOptions ?? {}) });
  } catch (error) {
    if (!(error instanceof BoardLockError)) throw error;
    const holder = error.holder && typeof error.holder === "object"
      ? { pid: error.holder.pid, at: error.holder.at }
      : null;
    throw new BoardLockError(`Timed out after ${error.timeoutMs}ms waiting for the board lock.`, {
      holder, timeoutMs: error.timeoutMs,
    });
  }
}

function validateEligibilityOptions(options, single) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new BoardInputError("Eligibility options must be an object.");
  }
  const allowed = new Set([
    "boardPath", "dataPath", "archivePath", "configPath", "agentsDir", "lockOptions",
    ...(single ? ["id"] : []),
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BoardInputError(`Unknown eligibility option(s): ${unknown.join(", ")}.`);
}

/** Locked eligibility verdicts for every active ticket, preserving active-board order. */
export function listTicketEligibility(options = {}) {
  validateEligibilityOptions(options, false);
  return eligibilitySnapshot(options);
}

/** Locked eligibility verdict for one active ticket. */
export function getTicketEligibility(options = {}) {
  validateEligibilityOptions(options, true);
  if (!isSafeEligibilityReference(options.id)) {
    throw new BoardNotFoundError("Ticket id is required.");
  }
  const snapshot = eligibilitySnapshot(options);
  const verdict = snapshot.verdicts.find((row) => row.ticketId === options.id);
  if (!verdict) throw new BoardNotFoundError(`Ticket ${options.id} was not found.`, { id: options.id });
  const { verdicts: _ignored, ...versions } = snapshot;
  return { verdict, ...versions };
}

function validateClaimOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new BoardInputError("Claim options must be an object.");
  }
  const allowed = new Set([
    "boardPath", "dataPath", "archivePath", "configPath", "agentsDir", "lockOptions",
    "id", "coordination", "expectVersion", "expectArchiveVersion", "expectPlanVersion", "dryRun",
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BoardInputError(`Unknown claim option(s): ${unknown.join(", ")}.`);
  if (!isSafeEligibilityReference(options.id)) throw new BoardNotFoundError("Ticket id is required.");
  const expected = [options.expectVersion, options.expectArchiveVersion, options.expectPlanVersion];
  if (expected.some((value) => value != null) && !expected.every((value) => typeof value === "string" && value)) {
    throw new BoardInputError("Claim snapshot requires board, archive, and plan versions together.");
  }
  if (options.coordination != null) {
    if (typeof options.coordination !== "object" || Array.isArray(options.coordination)) {
      throw new BoardInputError("Claim coordination must be an object.");
    }
    const allowedCoordination = new Set(["execution_mode", "agent_plan", "currentAgent", "nextAgent"]);
    const unknownCoordination = Object.keys(options.coordination).filter((key) => !allowedCoordination.has(key));
    if (unknownCoordination.length) {
      throw new BoardInputError(`Unknown claim coordination field(s): ${unknownCoordination.join(", ")}.`);
    }
  }
}

/**
 * Atomically claim one eligible ticket. The current board, archive and plan are loaded and
 * judged while the shared board lock is held. Optional snapshot versions are a three-file CAS:
 * a change to any eligibility input fails closed instead of claiming from a mixed generation.
 */
export function claimTicket(options = {}) {
  validateClaimOptions(options);
  const paths = resolveBoardPaths(options);
  const planPath = join(paths.boardDir, "plan.json");
  return mutateBoard({
    dataPath: paths.dataPath,
    archivePath: paths.archivePath,
    dryRun: options.dryRun === true,
    op: "claim-ticket",
    lockOptions: options.lockOptions,
    mutate: ({ data, archive }) => {
      const context = { ...loadBoardContext(options), data, archive };
      const ticket = (data.tickets ?? []).find((row) => row?.id === options.id);
      if (!ticket) throw new BoardNotFoundError("Ticket was not found on the active board.", { kind: "ticket" });
      const verdict = ticketEligibilityVerdict(ticket, {
        data, archivedTickets: archive.tickets ?? [], archivedEpics: archive.epics ?? [], plan: context.plan,
      });
      const versions = {
        version: boardVersion(paths.dataPath),
        archiveVersion: boardVersion(paths.archivePath),
        planVersion: boardVersion(planPath),
      };
      const expected = {
        version: options.expectVersion,
        archiveVersion: options.expectArchiveVersion,
        planVersion: options.expectPlanVersion,
      };
      const conflicts = Object.keys(versions)
        .filter((key) => expected[key] != null && expected[key] !== versions[key])
        .map((key) => ({ source: key === "version" ? "board" : key === "archiveVersion" ? "archive" : "plan" }));
      if (!verdict.eligible || conflicts.length) {
        return { write: false, result: { claimed: false, verdict, conflicts } };
      }
      const changed = setTicketStatusOperation(context, {
        id: options.id, status: "in-progress", coordination: options.coordination ?? {},
      });
      return {
        data: changed.data,
        result: { claimed: true, verdict, conflicts: [], transition: changed.result },
      };
    },
    validate: ({ data, archive }) => {
      const context = { ...loadBoardContext(options), data, archive };
      return validateBoardContext(context);
    },
  });
}

function runOperation(options, operation, operationName) {
  const paths = resolveBoardPaths(options);
  return mutateBoard({
    dataPath: paths.dataPath,
    archivePath: paths.archivePath,
    expectVersion: options.expectVersion,
    dryRun: options.dryRun === true,
    op: operationName,
    lockOptions: options.lockOptions,
    mutate: ({ data, archive }) => {
      const context = { ...loadBoardContext(options), data, archive };
      return operation(context, options);
    },
    validate: ({ data, archive }) => {
      const context = { ...loadBoardContext(options), data, archive };
      return validateBoardContext(context);
    },
  });
}

export const createTicket = (options = {}) => runOperation(options, createTicketOperation, "create-ticket");
export const editTicket = (options = {}) => runOperation(options, editTicketOperation, "edit-ticket");
export const setTicketStatus = (options = {}) => runOperation(options, setTicketStatusOperation, "set-ticket-status");
export const setTicketEpic = (options = {}) => runOperation(options, setTicketEpicOperation, "set-ticket-epic");
export const createEpic = (options = {}) => runOperation(options, createEpicOperation, "create-epic");
export const editEpic = (options = {}) => runOperation(options, editEpicOperation, "edit-epic");
export const archiveTicket = (options = {}) => runOperation(options, archiveTicketOperation, "archive-ticket");
export const dropTicket = (options = {}) => runOperation(options, dropTicketOperation, "drop-ticket");
