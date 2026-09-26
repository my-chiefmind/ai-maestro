/** Pure configuration helpers for the optional Maestro swarm policy. */

import { MAX_LANES } from "./lane-core.mjs";

export const DEFAULT_SWARM = Object.freeze({
  enabled: false,
  targetAgents: 10,
  waveMinutes: 30,
  autoMerge: false,
  timeoutsMinutes: Object.freeze({ xs: 60, s: 120, m: 240, l: 480 }),
});

export const SWARM_EXECUTION_CONTRACT = Object.freeze({
  coordinator: "invoking-swarm-session",
  dispatch: "direct-specialist-agents",
  spawnedCoordinator: false,
  stageAgents: Object.freeze({
    planning: "principal-engineer",
    implementation: "ticket-area-agent",
    qa: "qa",
    delivery: "principal-delivery",
    repair: "ticket-area-agent",
  }),
});

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function swarmPolicy(config = {}) {
  const saved = config?.orchestration?.swarm ?? {};
  return {
    ...DEFAULT_SWARM,
    ...saved,
    timeoutsMinutes: { ...DEFAULT_SWARM.timeoutsMinutes, ...(saved.timeoutsMinutes ?? {}) },
  };
}

export function validateSwarmConfig(config = {}) {
  const errors = [];
  const raw = config?.orchestration?.swarm;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    return ["orchestration.swarm must be an object."];
  }
  const policy = swarmPolicy(config);
  if (typeof policy.enabled !== "boolean") errors.push("orchestration.swarm.enabled must be boolean.");
  if (!integerIn(policy.targetAgents, 2, 64)) errors.push("orchestration.swarm.targetAgents must be an integer from 2 to 64.");
  if (!integerIn(policy.waveMinutes, 1, 1440)) errors.push("orchestration.swarm.waveMinutes must be an integer from 1 to 1440.");
  if (typeof policy.autoMerge !== "boolean") errors.push("orchestration.swarm.autoMerge must be boolean.");
  for (const size of ["xs", "s", "m", "l"]) {
    if (!integerIn(policy.timeoutsMinutes[size], 1, 10080)) {
      errors.push(`orchestration.swarm.timeoutsMinutes.${size} must be an integer from 1 to 10080.`);
    }
  }
  const worktrees = config?.orchestration?.maxWorktrees;
  if (worktrees != null && !integerIn(worktrees, 1, MAX_LANES)) {
    errors.push(`orchestration.maxWorktrees must be an integer from 1 to ${MAX_LANES}.`);
  }
  return errors;
}

export function updateSwarmConfig(config = {}, changes = {}) {
  const orchestration = { ...(config.orchestration ?? {}) };
  const current = swarmPolicy(config);
  const timeoutChanges = changes.timeoutsMinutes ?? {};
  const swarm = {
    ...current,
    ...changes,
    timeoutsMinutes: { ...current.timeoutsMinutes, ...timeoutChanges },
  };
  delete swarm.maxWorktrees;
  if (changes.maxWorktrees != null) orchestration.maxWorktrees = changes.maxWorktrees;
  orchestration.swarm = swarm;
  const updated = { ...config, orchestration };
  const errors = validateSwarmConfig(updated);
  if (errors.length) throw new Error(errors.join("\n"));
  return updated;
}

/**
 * Config cannot observe a host harness or hold a lock across a merge. Keep those values
 * unknown/unavailable so callers cannot mistake requested policy for live capacity or merge
 * authority. A future durable coordinator may supply measured capacity and an exclusive lease.
 */
export function swarmRuntimeStatus(config = {}) {
  const policy = swarmPolicy(config);
  return {
    ...SWARM_EXECUTION_CONTRACT,
    configuredTargetAgents: policy.targetAgents,
    observedHarnessCapacity: null,
    effectiveWorkerCapacity: null,
    capacityStatus: "requires-live-harness-observation",
    mergeLock: { available: false, kind: null },
    requestedAutoMerge: policy.autoMerge,
    effectiveAutoMerge: false,
    autoMergeBlocker: policy.autoMerge
      ? "No exclusive merge-lock primitive is available; automatic merge is fail-closed."
      : null,
  };
}
