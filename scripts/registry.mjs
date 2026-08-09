/**
 * registry.mjs — shared registry-file reading for tools that operate across many projects
 * (`maestro drift`, `maestro update --all`, `sync.mjs --all`, the cockpit's portfolio mode).
 * One project list, one format, read the same way everywhere, so a project only has to be
 * listed once to be covered by all of them.
 *
 * Format (schemas/maestro-registry.schema.json):
 *
 *   {
 *     "projects": [
 *       { "name": "agrolense", "path": "~/source/agrolense" },
 *       { "name": "legacy",    "path": "~/src/legacy", "status": "parked" },
 *       { "name": "platform",  "path": "~/src/platform", "kind": "ops" },
 *       { "registry": "../other-group/maestro-registry.json" }
 *     ]
 *   }
 *
 * - `path` is a project's repo root; "~" is expanded.
 * - `status` is `active` (default) or `parked`. Parked projects are visible in the file but
 *   skipped by every consumer unless one explicitly asks for them — the point is to record
 *   that a repo exists and is deliberately not being worked, rather than delete the entry and
 *   lose that fact.
 * - `kind` is `product` (default) or `ops`, distinguishing a shipping product from
 *   portfolio-level tooling that has no delivery pipeline of its own.
 * - An entry with `registry` instead of `path` pulls in another registry file, resolved
 *   relative to the file it appears in. That is how a group of groups is expressed: each group
 *   keeps its own registry, and the parent lists them. Cycles are detected and reported.
 *
 * A flat `{ name, path }` list — the original format — keeps working untouched.
 *
 * No third-party dependencies.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export const STATUSES = new Set(["active", "parked"]);
export const KINDS = new Set(["product", "ops"]);
/** Keep in step with schemas/maestro-registry.schema.json — it declares the same set closed. */
export const ENTRY_KEYS = new Set(["name", "path", "registry", "status", "kind", "note"]);

export function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Read a registry file and every registry it includes.
 *
 * Throws (ENOREGISTRY / EBADJSON / EBADREGISTRY / ECYCLE / EDUPNAME) rather than returning a
 * fallback — a missing or broken registry must never read as "zero projects", which would
 * render as "there is no work anywhere" instead of "the list failed to load". Same reasoning
 * the cockpit applies to its board allowlist (see board/specs/T-003.md §1).
 *
 * @param {string} registryPath
 * @param {{ includeParked?: boolean }} [opts]
 * @returns {{ projects: Array<{name: string, path: string, status: string, kind: string, source: string}> }}
 */
export function readRegistry(registryPath, opts = {}) {
  const { includeParked = false } = opts;
  const projects = [];
  const byName = new Map();

  /** @param {string} file @param {string[]} chain registries currently being read, for cycles */
  function load(file, chain) {
    const abs = resolve(expandHome(file));
    if (chain.includes(abs)) {
      fail("ECYCLE", `Registry cycle: ${[...chain, abs].map((p) => `\n    ${p}`).join(" →")}`);
    }
    if (!existsSync(abs)) fail("ENOREGISTRY", `No registry at ${abs}`);

    let raw;
    try {
      raw = JSON.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      fail("EBADJSON", `${abs} is not valid JSON: ${e.message}`);
    }
    if (raw.projects !== undefined && !Array.isArray(raw.projects)) {
      fail("EBADREGISTRY", `${abs}: "projects" must be an array.`);
    }

    const here = [...chain, abs];
    for (const [i, entry] of (raw.projects ?? []).entries()) {
      const where = `${abs} → projects[${i}]`;
      if (entry === null || typeof entry !== "object") fail("EBADREGISTRY", `${where}: must be an object.`);

      // The schema declares additionalProperties:false, so an unknown key is a typo, and the
      // typos that matter are the ones on keys that EXCLUDE work: "stauts": "parked" read as a
      // silently active project, and the sweep the field exists to prevent ran anyway.
      const unknown = Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k));
      if (unknown.length) {
        fail(
          "EBADREGISTRY",
          `${where}: unknown key(s) ${unknown.map((k) => `"${k}"`).join(", ")} — ` +
            `an entry takes ${[...ENTRY_KEYS].join(", ")}. Put free text in "note".`
        );
      }

      // A nested registry: a group of groups. Resolved relative to the file naming it, so a
      // registry can be moved with its siblings without every path being rewritten.
      if (entry.registry !== undefined) {
        if (entry.path !== undefined) {
          fail("EBADREGISTRY", `${where}: has both "registry" and "path" — an entry is one or the other.`);
        }
        if (typeof entry.registry !== "string" || !entry.registry.trim()) {
          fail("EBADREGISTRY", `${where}: "registry" must be a non-empty string.`);
        }
        const nested = entry.registry.startsWith("~")
          ? expandHome(entry.registry)
          : resolve(dirname(abs), entry.registry);
        load(nested, here);
        continue;
      }

      if (typeof entry.path !== "string" || !entry.path.trim()) {
        fail("EBADREGISTRY", `${where}: needs a "path" (a project's repo root) or a "registry".`);
      }
      const status = entry.status ?? "active";
      const kind = entry.kind ?? "product";
      if (!STATUSES.has(status)) {
        fail("EBADREGISTRY", `${where}: status "${status}" is not one of ${[...STATUSES].join(", ")}.`);
      }
      if (!KINDS.has(kind)) {
        fail("EBADREGISTRY", `${where}: kind "${kind}" is not one of ${[...KINDS].join(", ")}.`);
      }

      const name = entry.name ?? entry.path;
      // Consumers key on name — the cockpit matches it exactly to pick which board a write
      // lands on — so two projects sharing one is an ambiguity that must not be resolved by
      // whichever registry happened to load first.
      const clash = byName.get(name);
      if (clash) {
        fail("EDUPNAME", `Duplicate project name "${name}": ${clash.source} and ${abs}.`);
      }
      const project = { name, path: resolve(expandHome(entry.path)), status, kind, source: abs };
      byName.set(name, project);
      if (status !== "parked" || includeParked) projects.push(project);
    }
  }

  load(registryPath, []);
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
