import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_SWARM,
  SWARM_EXECUTION_CONTRACT,
  swarmPolicy,
  swarmRuntimeStatus,
  updateSwarmConfig,
  validateSwarmConfig,
} from "../scripts/swarm-core.mjs";

const cli = fileURLToPath(new URL("../scripts/swarm-config.mjs", import.meta.url));
const rootCli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));

function withConfig(run) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-swarm-test-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ githubActions: false }) + "\n");
  try { return run(config); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("swarm is disabled and conservative by default", () => {
  assert.deepEqual(swarmPolicy({}), {
    ...DEFAULT_SWARM,
    timeoutsMinutes: { xs: 60, s: 120, m: 240, l: 480 },
  });
});

test("updates preserve unrelated config and existing policy", () => {
  const source = {
    githubActions: false,
    orchestration: { serialFiles: ["contracts/**"], swarm: { autoMerge: true, targetAgents: 7 } },
  };
  const updated = updateSwarmConfig(source, { enabled: true, maxWorktrees: 5, waveMinutes: 20 });
  assert.equal(updated.githubActions, false);
  assert.deepEqual(updated.orchestration.serialFiles, ["contracts/**"]);
  assert.equal(updated.orchestration.maxWorktrees, 5);
  assert.equal(updated.orchestration.swarm.autoMerge, true);
  assert.equal(updated.orchestration.swarm.targetAgents, 7);
  assert.equal(updated.orchestration.swarm.waveMinutes, 20);
  assert.equal(source.orchestration.maxWorktrees, undefined);
});

test("runtime contract names the session coordinator and fails auto-merge closed", () => {
  const runtime = swarmRuntimeStatus({ orchestration: { swarm: { autoMerge: true } } });
  assert.equal(SWARM_EXECUTION_CONTRACT.coordinator, "invoking-swarm-session");
  assert.equal(runtime.spawnedCoordinator, false);
  assert.equal(runtime.stageAgents.qa, "qa");
  assert.equal(runtime.stageAgents.delivery, "principal-delivery");
  assert.equal(runtime.observedHarnessCapacity, null);
  assert.equal(runtime.effectiveWorkerCapacity, null);
  assert.equal(runtime.requestedAutoMerge, true);
  assert.equal(runtime.mergeLock.available, false);
  assert.equal(runtime.effectiveAutoMerge, false);
  assert.match(runtime.autoMergeBlocker, /merge-lock primitive/i);

  const manualMerge = swarmRuntimeStatus({});
  assert.equal(manualMerge.requestedAutoMerge, false);
  assert.equal(manualMerge.effectiveAutoMerge, false);
  assert.equal(manualMerge.autoMergeBlocker, null);
});

test("validates every configurable bound", () => {
  const invalid = updateSwarmConfig({}, { enabled: true });
  invalid.orchestration.maxWorktrees = 6;
  invalid.orchestration.swarm.targetAgents = 1;
  invalid.orchestration.swarm.waveMinutes = 0;
  invalid.orchestration.swarm.autoMerge = "yes";
  invalid.orchestration.swarm.timeoutsMinutes = { xs: 0, s: 0, m: 0, l: 0 };
  const errors = validateSwarmConfig(invalid);
  for (const field of ["maxWorktrees", "targetAgents", "waveMinutes", "autoMerge", "xs", "s", "m", "l"]) {
    assert.ok(errors.some((error) => error.includes(field)), `missing validation for ${field}`);
  }
});

test("top-level CLI dispatch enables, reports, and gracefully disables the pool", () => withConfig((configPath) => {
  const enabled = spawnSync(process.execPath, [
    rootCli, "swarm", "enable", "--config", configPath, "--agents", "10", "--worktrees", "5",
    "--wave-minutes", "15", "--auto-merge",
  ], { encoding: "utf8" });
  assert.equal(enabled.status, 0, enabled.stderr);
  let config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.githubActions, false);
  assert.equal(config.orchestration.maxWorktrees, 5);
  assert.equal(config.orchestration.swarm.enabled, true);
  assert.equal(config.orchestration.swarm.targetAgents, 10);
  assert.equal(config.orchestration.swarm.autoMerge, true);

  const status = spawnSync(process.execPath, [
    rootCli, "swarm", "status", "--config", configPath, "--json",
  ], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const reported = JSON.parse(status.stdout);
  assert.equal(reported.policy.waveMinutes, 15);
  assert.equal(reported.runtime.coordinator, "invoking-swarm-session");
  assert.equal(reported.runtime.effectiveAutoMerge, false);

  const disabled = spawnSync(process.execPath, [
    rootCli, "swarm", "disable", "--config", configPath,
  ], { encoding: "utf8" });
  assert.equal(disabled.status, 0, disabled.stderr);
  config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.orchestration.swarm.enabled, false);
  assert.equal(config.orchestration.swarm.autoMerge, true, "disable preserves the chosen merge policy");
}));

test("CLI rejects invalid limits and flag typos without modifying config", () => withConfig((configPath) => {
  const before = readFileSync(configPath, "utf8");
  for (const args of [
    ["enable", "--config", configPath, "--worktrees", "6"],
    ["enable", "--config", configPath, "--agentz", "10"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(readFileSync(configPath, "utf8"), before);
  }
}));
