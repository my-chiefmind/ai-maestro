/** Supported, read-only usage API. Reports contain aggregates only and never filesystem paths. */
import { existsSync, readFileSync } from "fs";
import { resolveBoardPaths } from "./board-context.mjs";
import {
  buildUsageReport as buildReport, usageToCsv, totalTokens, DIMENSIONS,
  transcriptScanEnabled, rootsForBoard, opaqueProjectKey,
  USAGE_SLICE_SCHEMA, USAGE_SLICE_DIMENSIONS,
} from "./usage-core.mjs";
import {
  buildPortfolioUsage as buildPortfolio, discoverProjects, projectsFromRegistry,
  PORTFOLIO_DIMENSIONS,
} from "./usage-portfolio.mjs";
export {
  appendApplicationUsage, mapDeepSeekUsage,
  ApplicationUsageInputError, ApplicationUsageBoardError, ApplicationUsageConflictError,
  ApplicationUsageLockError, ApplicationUsageReadError, ApplicationUsageWriteError,
} from "./application-usage.mjs";

class UsageError extends Error {
  constructor(name, code, message, detail = {}) { super(message); this.name = name; this.code = code; Object.assign(this, detail); }
}
export class UsageInputError extends UsageError {
  constructor(message, detail = {}) { super("UsageInputError", "EUSAGEINPUT", message, detail); }
}
export class UsageReadError extends UsageError {
  constructor(message, detail = {}) { super("UsageReadError", "EUSAGEREAD", message, detail); }
}

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const assertKnown = (opts, known) => {
  if (!object(opts)) throw new UsageInputError("Usage options must be an object.");
  const unknown = Object.keys(opts).filter((k) => !known.has(k));
  if (unknown.length) throw new UsageInputError(`Unknown usage option: ${unknown.join(", ")}.`, { fields: unknown });
};

export function buildUsageReport(options = {}) {
  assertKnown(options, new Set(["boardPath", "dataPath", "archivePath", "configPath", "data", "archive", "config", "roots", "excludeRoots", "projectsDir", "codexHome", "cacheFile", "env", "useCache", "tuning"]));
  const paths = resolveBoardPaths(options);
  if (options.data === undefined && !existsSync(paths.dataPath)) throw new UsageReadError("Board data could not be read.", { source: "board" });
  const read = (path, fallback, required = false) => {
    if (!existsSync(path)) { if (required) throw new UsageReadError("Board data could not be read.", { source: "board" }); return fallback; }
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new UsageReadError("Usage input contains invalid JSON.", { source: "board" }); }
  };
  try {
    const data = options.data !== undefined ? options.data : read(paths.dataPath, null, true);
    const archive = options.archive !== undefined ? options.archive : read(paths.archivePath, { epics: [], tickets: [] });
    const config = options.config !== undefined ? options.config : read(paths.configPath, null);
    return buildReport({ ...options, boardDir: paths.boardDir, data, archive, config });
  }
  catch (error) { if (error instanceof UsageError) throw error;
    throw new UsageReadError("Usage report could not be built.", { cause: error instanceof Error ? error.name : "Error" }); }
}

export function buildPortfolioUsage(options = {}) {
  assertKnown(options, new Set(["projects", "projectsDir", "codexHome", "cacheFile", "env", "useCache", "config"]));
  if (!Array.isArray(options.projects)) throw new UsageInputError("projects must be an array.");
  for (const p of options.projects) {
    if (!object(p) || typeof p.name !== "string" || typeof p.path !== "string" || !(typeof p.kitDir === "string" || p.kitDir === null)) {
      throw new UsageInputError("Each project must have name, path, and kitDir fields.");
    }
  }
  try { return buildPortfolio(options); }
  catch (error) { throw new UsageReadError("Portfolio usage could not be built.", { cause: error instanceof Error ? error.name : "Error" }); }
}

export {
  usageToCsv, totalTokens, DIMENSIONS, PORTFOLIO_DIMENSIONS,
  transcriptScanEnabled, rootsForBoard, discoverProjects, projectsFromRegistry,
  opaqueProjectKey, USAGE_SLICE_SCHEMA, USAGE_SLICE_DIMENSIONS,
};
