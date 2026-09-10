#!/usr/bin/env node
/** Enable, disable, or inspect Maestro's optional swarm policy. */

import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { writeAtomic } from "./board-io.mjs";
import { swarmPolicy, swarmRuntimeStatus, updateSwarmConfig, validateSwarmConfig } from "./swarm-core.mjs";

const argv = process.argv.slice(2);
const op = argv[0];
const has = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const JSON_OUT = has("json");

function fail(message, code = 2) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(code);
}

const VALUE_FLAGS = new Set([
  "config", "agents", "worktrees", "wave-minutes",
  "timeout-xs", "timeout-s", "timeout-m", "timeout-l",
]);
const BOOLEAN_FLAGS = new Set(["auto-merge", "no-auto-merge", "json"]);
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) fail(`Unexpected argument "${arg}".`);
  const name = arg.slice(2);
  if (BOOLEAN_FLAGS.has(name)) continue;
  if (!VALUE_FLAGS.has(name)) fail(`Unknown flag "${arg}".`);
  if (argv[i + 1] == null || argv[i + 1].startsWith("--")) fail(`${arg} needs a value.`);
  i++;
}

const asInt = (name) => {
  const raw = value(name);
  if (raw == null || raw.startsWith("--") || !/^\d+$/.test(raw)) fail(`--${name} needs an integer.`);
  return Number(raw);
};

function usage() {
  process.stdout.write(`
  maestro swarm — configure the optional continuous delivery pool

    maestro swarm enable [--agents 10] [--worktrees 5] [--wave-minutes 30]
                         [--auto-merge | --no-auto-merge]
    maestro swarm disable
    maestro swarm status [--json]

  Flags: --config <path> --timeout-xs <min> --timeout-s <min>
         --timeout-m <min> --timeout-l <min>

  Enabling records policy only. Invoke the rendered swarm skill to run the pool.
`);
  process.exit(op ? 1 : 0);
}

if (!op || ["help", "--help", "-h"].includes(op)) usage();
if (!["enable", "disable", "status"].includes(op)) fail(`Unknown op "${op}". Known: enable, disable, status.`);
if (has("auto-merge") && has("no-auto-merge")) fail("Choose only one of --auto-merge and --no-auto-merge.");

const explicitConfig = value("config");
const defaultConfig = existsSync(join(process.cwd(), "maestro", "config.json"))
  ? join(process.cwd(), "maestro", "config.json")
  : join(process.cwd(), "config.json");
const configPath = resolve(explicitConfig ?? defaultConfig);
if (!existsSync(configPath)) fail(`Config file not found: ${configPath}. Pass --config <path>.`);

let config;
try { config = JSON.parse(readFileSync(configPath, "utf8")); }
catch { fail(`${configPath} is not valid JSON.`); }

const currentErrors = validateSwarmConfig(config);
if (op === "status") {
  const result = {
    ok: currentErrors.length === 0,
    config: configPath,
    maxWorktrees: config?.orchestration?.maxWorktrees ?? 3,
    policy: swarmPolicy(config),
    runtime: swarmRuntimeStatus(config),
    errors: currentErrors,
  };
  if (JSON_OUT) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    const p = result.policy;
    process.stdout.write(`
  Swarm: ${p.enabled ? "enabled" : "disabled"}
  Target agents: ${p.targetAgents} workers plus one coordinator
  Worktree lanes: ${result.maxWorktrees}
  Wave interval: ${p.waveMinutes} minutes
  Coordinator: invoking /swarm session (dispatches specialist agents directly)
  Harness capacity: observe from the active harness at run time
  Auto-merge: ${result.runtime.effectiveAutoMerge ? "enabled after QA + delivery" : p.autoMerge ? "requested, but blocked — no exclusive merge lock" : "disabled"}
  Stale deadlines: XS ${p.timeoutsMinutes.xs}m · S ${p.timeoutsMinutes.s}m · M ${p.timeoutsMinutes.m}m · L ${p.timeoutsMinutes.l}m
  Config: ${configPath}
${currentErrors.length ? `  Errors: ${currentErrors.join("; ")}\n` : ""}`);
  }
  process.exit(currentErrors.length ? 1 : 0);
}

const changes = { enabled: op === "enable" };
if (value("agents") != null) changes.targetAgents = asInt("agents");
if (value("worktrees") != null) changes.maxWorktrees = asInt("worktrees");
if (value("wave-minutes") != null) changes.waveMinutes = asInt("wave-minutes");
if (has("auto-merge")) changes.autoMerge = true;
if (has("no-auto-merge")) changes.autoMerge = false;
const timeoutsMinutes = {};
for (const size of ["xs", "s", "m", "l"]) {
  const flag = `timeout-${size}`;
  if (value(flag) != null) timeoutsMinutes[size] = asInt(flag);
}
if (Object.keys(timeoutsMinutes).length) changes.timeoutsMinutes = timeoutsMinutes;

let updated;
try { updated = updateSwarmConfig(config, changes); }
catch (error) { fail(error.message); }
writeAtomic(configPath, JSON.stringify(updated, null, 2) + "\n");

const p = swarmPolicy(updated);
process.stdout.write(`
  ✓ Swarm ${p.enabled ? "enabled" : "disabled"} in ${configPath}.
  ${p.enabled ? `Target ${p.targetAgents} worker agents plus one coordinator across at most ${updated.orchestration.maxWorktrees ?? 3} worktree lanes; auto-merge ${p.autoMerge ? "requested but fail-closed until an exclusive merge lock exists" : "off"}.` : "No new work will be dispatched; active work should checkpoint gracefully."}
  Run Maestro sync so generated runtime skills match the configuration.

`);
