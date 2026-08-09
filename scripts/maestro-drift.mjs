#!/usr/bin/env node
/**
 * maestro-drift.mjs — cross-project drift report.
 *
 * .claude/ must always be exactly what render/sync.mjs would generate — that is what makes
 * ai-maestro the source of truth instead of N diverging copies. Any hand-edited generated
 * file is a signal someone improved something locally and never sent it upstream. This walks
 * a registry of projects and reports, per project: the installed kit version vs the latest on
 * npm, and whether its generated files still match what its OWN installed kit would render
 * (drift from a hand-edit is reported separately from being behind on the kit version — an
 * up-to-date-but-edited project and an outdated-but-untouched one need different follow-up).
 * The output IS the promote-upstream worklist: for each drifted file, decide whether the edit
 * generalizes (upstream it to ai-maestro, see CONTRIBUTING.md) or was project-specific.
 *
 * Usage:
 *   node scripts/maestro-drift.mjs [--registry <file>] [--offline] [--strict]
 *
 *   --registry  path to a registry JSON file (default: ./maestro-registry.json)
 *   --offline   skip the npm "latest version" lookup (also used automatically when it fails)
 *   --strict    exit 1 if any project is drifted, behind, or not set up (for CI)
 *
 * Registry format:
 *   { "projects": [ { "name": "agrolense", "path": "~/source/agrolense" }, ... ] }
 *
 * "path" is a project's repo root; the project's kit is found at <path>/maestro/config.json
 * (the vendored-kit layout) or <path>/config.json (a kit-repo clone). "~" is expanded.
 *
 * No third-party dependencies.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { readRegistry, findKitDir } from "./registry.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(__dir, "..");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const registryPath = resolve(flag("registry") || "maestro-registry.json");
let projects;
try {
  ({ projects } = readRegistry(registryPath));
} catch (e) {
  if (e.code === "ENOREGISTRY") {
    console.error(`✗ No registry at ${registryPath}.

  Create one — a JSON file listing the projects to check:

    { "projects": [ { "name": "agrolense", "path": "~/source/agrolense" } ] }

  Then run: node scripts/maestro-drift.mjs --registry <file>`);
  } else {
    console.error(`✗ ${e.message}`);
  }
  process.exit(2);
}
if (!projects.length) {
  console.error(`✗ ${registryPath} lists no projects.`);
  process.exit(2);
}

const readVersion = (dir) =>
  existsSync(join(dir, "VERSION")) ? readFileSync(join(dir, "VERSION"), "utf8").trim() : null;

let latestVersion = null;
if (!has("offline")) {
  try {
    latestVersion = execFileSync("npm", ["view", "@mychiefmind/ai-maestro", "version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    latestVersion = null; // offline, package not published, npm missing, ... — report "unknown"
  }
}

function checkDrift(kitDir) {
  const syncScript = join(kitDir, "render", "sync.mjs");
  if (!existsSync(syncScript)) return { ok: false, reason: "no render/sync.mjs in this kit" };
  // Run the PROJECT's own vendored renderer against itself — drift here means "hand-edited
  // since the last render", independent of whether the kit version itself is behind latest.
  const r = spawnSync(process.execPath, [syncScript, "--project", kitDir, "--check"], {
    encoding: "utf8",
  });
  return { ok: r.status === 0, output: (r.stdout || "") + (r.stderr || "") };
}

const rows = [];
for (const { name, path: projectPath } of projects) {
  const kitDir = existsSync(projectPath) ? findKitDir(projectPath) : null;

  if (!kitDir) {
    rows.push({ name, status: "not set up", installed: "—", latest: latestVersion ?? "unknown", drifted: null });
    continue;
  }

  const installed = readVersion(kitDir) ?? "unknown";
  const behind = latestVersion && installed !== "unknown" && installed !== latestVersion;
  const drift = checkDrift(kitDir);
  rows.push({
    name,
    status: drift.ok ? "clean" : drift.reason ? drift.reason : "drifted",
    installed,
    latest: latestVersion ?? "unknown",
    behind,
    drifted: !drift.ok,
    detail: drift.output,
  });
}

console.log(`Registry: ${registryPath} (${projects.length} project${projects.length === 1 ? "" : "s"})\n`);
const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
for (const r of rows) {
  const versionCol = r.installed === "—" ? "—" : `v${r.installed}${r.behind ? ` (behind v${r.latest})` : ""}`;
  const statusCol = r.status === "clean" ? "✓ clean" : r.status === "not set up" ? "— not set up" : `✗ ${r.status}`;
  console.log(`  ${r.name.padEnd(nameWidth)}  ${versionCol.padEnd(28)}  ${statusCol}`);
  if (r.drifted && r.detail) {
    for (const line of r.detail.trim().split("\n")) console.log(`      ${line}`);
  }
}

if (!latestVersion && !has("offline")) {
  console.log(`\n(couldn't reach npm for the latest published version — treated as unknown)`);
}

const issues = rows.filter((r) => r.status === "not set up" || r.behind || r.drifted);
console.log(`\n${issues.length ? "✗" : "✓"} ${rows.length - issues.length}/${rows.length} clean and up to date.`);
if (issues.length) {
  console.log(`  ${issues.map((r) => r.name).join(", ")} need attention.`);
}

process.exit(has("strict") && issues.length ? 1 : 0);
