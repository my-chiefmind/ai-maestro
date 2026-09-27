// @ts-check
/**
 * Merge AI Maestro's usage-recording hooks into a Claude Code `.claude/settings.json` object.
 *
 * Maestro-owned hook commands end with the marker comment MAESTRO_HOOK_MARKER, which is how a
 * re-sync finds (and replaces or removes) exactly its own entries. User entries are never
 * modified, removed or reordered; ours are appended after them. Pure: returns a new object.
 */
import { HOOK_TIMEOUT_S } from "./usage-hook.mjs";

export const MAESTRO_HOOK_MARKER = "# ai-maestro:usage-hook";
export const USAGE_HOOK_EVENTS = ["Stop", "SubagentStop", "SessionEnd"];

/** Shell-quote for POSIX sh, keeping $CLAUDE_PROJECT_DIR expandable. */
const dq = (/** @type {string} */ s) => `"${s.replace(/(["\\`])/g, "\\$1")}"`;

/**
 * The hook command. `scriptRel` / `boardRel` are posix paths relative to the project root
 * that Claude Code exposes as $CLAUDE_PROJECT_DIR.
 * @param {string} scriptRel @param {string} boardRel
 */
export function usageHookCommand(scriptRel, boardRel) {
  return `node ${dq(`$CLAUDE_PROJECT_DIR/${scriptRel}`)} --board ${dq(`$CLAUDE_PROJECT_DIR/${boardRel}`)} >/dev/null 2>&1 || true ${MAESTRO_HOOK_MARKER}`;
}

/** @param {any} h */
const isOurs = (h) => typeof h?.command === "string" && h.command.includes(MAESTRO_HOOK_MARKER);
/** @param {any} v */
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {any} settings existing parsed settings (or undefined)
 * @param {{ enabled: boolean, command?: string }} opts
 * @returns {any} merged settings
 */
export function mergeUsageHooks(settings, opts) {
  const out = object(settings) ? structuredClone(settings) : {};
  const hooks = object(out.hooks) ? out.hooks : {};
  for (const event of USAGE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    /** @type {any[]} */ const kept = [];
    for (const g of groups) {
      if (!object(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      if (!g.hooks.some(isOurs)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isOurs(h));
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (opts.enabled && opts.command) {
      kept.push({ hooks: [{ type: "command", command: opts.command, timeout: HOOK_TIMEOUT_S }] });
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (Object.keys(hooks).length) out.hooks = hooks; else delete out.hooks;
  return out;
}
