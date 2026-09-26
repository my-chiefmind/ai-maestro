/**
 * Repair root package.json scripts that earlier kit versions told projects to write.
 *
 * Older setups wired the project's own `npm run sync|validate|check` (and so a pre-commit
 * hook that calls `npm run check`) to the `ai-maestro` bin in node_modules. `update` refreshes
 * the VENDORED kit and re-renders with it, but leaves node_modules alone — so the next commit
 * checks the freshly rendered files with an older renderer, reports them out of date, and the
 * hook fails. The current form runs the vendored kit directly, so it always matches.
 *
 * Only exact, known-old values are replaced; any script the user wrote themselves is left as is.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function knownOldScripts(k) {
  const sync = `node ${k}/render/sync.mjs --project ${k}`;
  const validate = `node ${k}/scripts/validate-board.mjs ${k}/board/data.json`;
  const map = {};
  for (const bin of ["ai-maestro", "maestro", "npx ai-maestro", "npx maestro"]) {
    const oSync = `${bin} sync --project ${k}`;
    const oValidate = `${bin} validate ${k}/board/data.json`;
    map[oSync] = sync;
    map[oValidate] = validate;
    map[`${oSync} --check && ${oValidate}`] = `${sync} --check && ${validate}`;
  }
  return map;
}

/** Pure: returns { scripts, changes[] } with known-old values swapped for current ones. */
export function repairScripts(scripts, kitRel) {
  const map = knownOldScripts(kitRel);
  const out = { ...scripts };
  const changes = [];
  for (const [name, value] of Object.entries(scripts || {})) {
    if (typeof value === "string" && Object.hasOwn(map, value.trim())) {
      out[name] = map[value.trim()];
      changes.push({ name, from: value, to: out[name] });
    }
  }
  return { scripts: out, changes };
}

/** Rewrite <root>/package.json in place when needed; returns the changes made. */
export function repairRootPackageScripts(root, kitRel) {
  const p = join(root, "package.json");
  if (!existsSync(p) || !kitRel || kitRel.startsWith("..")) return [];
  let text, pkg;
  try {
    text = readFileSync(p, "utf8");
    pkg = JSON.parse(text);
  } catch {
    return []; // unreadable package.json — not ours to fix
  }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
  const { scripts, changes } = repairScripts(pkg.scripts, kitRel);
  if (!changes.length) return [];
  pkg.scripts = scripts;
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  writeFileSync(p, JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  return changes;
}
