import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { agentFileToCode, validateBoard as validateBoardCore } from "./board-core.mjs";
import { readPlanForBoard } from "./plan-io.mjs";
import { BoardInputError, BoardNotFoundError } from "./board-errors.mjs";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJSON(path, fallback, required = false) {
  if (!existsSync(path)) {
    if (required) throw new BoardNotFoundError(`Board file not found: ${path}.`, { path });
    return fallback;
  }
  const raw = readFileSync(path, "utf8");
  try { return JSON.parse(raw); }
  catch (error) {
    throw new BoardInputError(`Invalid JSON in ${path}: ${error.message}`, {
      path,
      source: path.endsWith("archive.json") ? "archive" : path.endsWith("data.json") ? "board" : "config",
      cause: error.message,
    });
  }
}

export function resolveBoardPaths({ boardPath, dataPath, archivePath, configPath } = {}) {
  const supplied = dataPath ?? boardPath ?? join(process.cwd(), "board", "data.json");
  const absolute = resolve(supplied);
  const data = absolute.endsWith(".json") ? absolute : join(absolute, "data.json");
  const boardDir = dirname(data);
  return {
    boardDir,
    dataPath: data,
    archivePath: resolve(archivePath ?? join(boardDir, "archive.json")),
    configPath: resolve(configPath ?? join(boardDir, "..", "config.json")),
  };
}

function codesFromDir(path) {
  if (!existsSync(path)) return null;
  const codes = readdirSync(path).filter((f) => f.endsWith(".md"))
    .map((f) => agentFileToCode(f.replace(/\.md$/, "")));
  return codes.length ? new Set(codes) : null;
}

/** Load all validation inputs. Call this only while holding the board-directory lock. */
export function loadBoardContext(options = {}, { requireData = true } = {}) {
  const paths = resolveBoardPaths(options);
  const data = readJSON(paths.dataPath, { epics: [], tickets: [] }, requireData);
  const archive = readJSON(paths.archivePath, { epics: [], tickets: [] });
  const config = readJSON(paths.configPath, null);
  let plan = null;
  try { plan = readPlanForBoard(paths.dataPath); }
  catch (error) { throw new BoardInputError(error.message, { path: join(paths.boardDir, "plan.json") }); }

  let agentCodes;
  if (options.agentsDir) agentCodes = codesFromDir(resolve(options.agentsDir));
  else if (Array.isArray(config?.roster) && config.roster.length) {
    agentCodes = new Set(config.roster.map((name) => agentFileToCode(String(name).replace(/\.md$/, ""))));
  } else agentCodes = codesFromDir(join(KIT_ROOT, "agents"));

  return { ...paths, data, archive, config, plan, agentCodes };
}

export function validateBoardContext({ data, archive, config, plan, agentCodes }) {
  return validateBoardCore(data, {
    archived: archive.tickets ?? [], archivedEpics: archive.epics ?? [], config, plan, agentCodes,
  });
}
