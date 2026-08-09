/**
 * registry.mjs — shared registry-file reading for tools that operate across many projects
 * (`maestro drift`, `sync.mjs --all`, the cockpit's portfolio mode). One project list, one
 * format, read the same way everywhere, so a project only has to be listed once to be covered
 * by all three.
 *
 * Format:
 *   { "projects": [ { "name": "agrolense", "path": "~/source/agrolense" } ] }
 *
 * "path" is a project's repo root; "~" is expanded. No third-party dependencies.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Throws (code ENOREGISTRY / EBADJSON) rather than returning a fallback — a missing or
 * broken registry must never read as "zero projects", the same reasoning root cockpit's
 * boards.mjs applies to projects.json (see board/specs/T-003.md §1). */
export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    const err = new Error(`No registry at ${registryPath}`);
    err.code = "ENOREGISTRY";
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (e) {
    const err = new Error(`${registryPath} is not valid JSON: ${e.message}`);
    err.code = "EBADJSON";
    throw err;
  }
  const projects = (raw.projects ?? []).map((p) => ({
    name: p.name ?? p.path,
    path: resolve(expandHome(p.path)),
  }));
  return { projects };
}

// The kit a project actually has installed — vendored (<path>/maestro) or a clone (<path>
// itself, e.g. the "git clone ai-maestro as maestro/" flow). Vendored wins when both somehow
// exist, since that's what setup/update produce. Returns null when the project isn't set up.
export function findKitDir(projectPath) {
  const vendored = join(projectPath, "maestro");
  if (existsSync(join(vendored, "config.json"))) return vendored;
  if (existsSync(join(projectPath, "config.json"))) return projectPath;
  return null;
}
