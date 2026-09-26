#!/usr/bin/env node
// @ts-check
/** Privacy-safe Codex JSONL and rollout usage parsing. No prompt or response text escapes. */
import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

export const DEFAULT_CODEX_HOME = join(homedir(), ".codex");

/** @typedef {{input:number,output:number,cacheRead:number,cacheWrite:number,thinking:number}} CodexUsage */

const n = (/** @type {any} */ v) => Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Codex input_tokens includes cached and cache-write input. Maestro stores disjoint bins.
 * Invalid/incomplete counters are unavailable, never a provider-stamped row of zeroes.
 * @param {any} raw
 */
export function normaliseCodexUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const inputTotal = n(raw.input_tokens ?? raw.inputTokens);
  const cacheRead = n(raw.cached_input_tokens ?? raw.cachedInputTokens);
  const cacheWrite = n(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens);
  const output = n(raw.output_tokens ?? raw.outputTokens);
  const thinking = n(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens);
  const total = raw.total_tokens ?? raw.totalTokens;
  if ([inputTotal, cacheRead, cacheWrite, output, thinking, n(total)].some((v) => v === null)) return null;
  const input = /** @type {number} */ (inputTotal) - /** @type {number} */ (cacheRead) - /** @type {number} */ (cacheWrite);
  if (input < 0) return null;
  if (total !== inputTotal + output) return null;
  return { input, output, cacheRead, cacheWrite, thinking };
}

/** Parse `codex exec --json`; final output is only the last completed agent message. */
/** @param {string} text */
export function parseCodexExecJsonl(text) {
  let sessionId = null, finalAnswer = "", usage = null, error = null, modelId = null, provider = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type === "thread.started") {
      if (typeof rec.thread_id === "string") sessionId = rec.thread_id;
      if (typeof rec.model === "string") modelId = rec.model;
      if (typeof rec.provider === "string") provider = rec.provider;
    }
    if (rec?.type === "item.completed" && rec.item?.type === "agent_message" && typeof rec.item.text === "string") finalAnswer = rec.item.text;
    if (rec?.type === "turn.completed") usage = normaliseCodexUsage(rec.usage);
    if (rec?.type === "turn.failed") error = typeof rec.error?.message === "string" ? rec.error.message : "Codex turn failed";
    if (rec?.type === "error") error = typeof rec.message === "string" ? rec.message : "Codex execution failed";
  }
  return { sessionId, stdout: finalAnswer, usage, error, modelId, provider };
}

const TICKET_RE = /\b[A-Za-z][A-Za-z0-9]{0,7}-\d{1,5}\b/g;
const ID = "([A-Za-z][A-Za-z0-9]{0,7}-\\d{1,5})";
const COMMAND_PATTERNS = [
  { verb: "set-status", re: new RegExp(`(?:board-write\\.mjs\\b[^\\n]*?\\bset-status|\\bmaestro\\s+ticket\\s+set-status)\\s+${ID}`, "g") },
  { verb: "archive", re: new RegExp(`(?:board-write\\.mjs\\b[^\\n]*?\\barchive|\\bmaestro\\s+ticket\\s+archive)\\s+${ID}`, "g") },
  { verb: "block", re: new RegExp(`board-write\\.mjs\\b[^\\n]*?\\bblock\\s+${ID}`, "g") },
  { verb: "run", re: new RegExp(`\\bmaestro\\s+run\\s+${ID}`, "g") },
];
const mentions = (/** @type {string} */ s) => [...new Set(String(s).match(TICKET_RE) || [])].slice(0, 16);
const commands = (/** @type {string} */ s) => COMMAND_PATTERNS.flatMap(({ verb, re }) => {
  re.lastIndex = 0; const out = []; let m;
  while ((m = re.exec(s)) !== null) if (m[1]) out.push({ verb, id: m[1] });
  return out;
});

function safeEvidence(/** @type {any} */ rec) {
  if (rec?.type === "event_msg" && rec.payload?.type === "user_message") return String(rec.payload.message || "");
  if (rec?.type !== "response_item") return "";
  const p = rec.payload || {};
  if (["function_call", "custom_tool_call"].includes(p.type)) return String(p.arguments || p.input || "");
  return "";
}

/**
 * Distil one Codex rollout. Per-response records win; cumulative token_count is fallback only.
 * @param {string} filePath
 */
export function distillCodexRollout(filePath) {
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch { return []; }
  let sessionId = basename(filePath, ".jsonl"), cwd = "", branch = null, model = "unknown", provider = "unknown";
  let currentMentions = /** @type {string[]} */ ([]), currentCommands = /** @type {Array<{verb:string,id:string}>} */ ([]);
  const responseSeen = new Set();
  const direct = [], cumulative = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(rec?.timestamp || "");
    if (rec?.type === "session_meta") {
      const p = rec.payload || {};
      sessionId = p.session_id || p.id || sessionId; cwd = typeof p.cwd === "string" ? p.cwd : cwd;
      provider = typeof p.model_provider === "string" ? p.model_provider : provider;
      branch = typeof p.git?.branch === "string" ? p.git.branch : branch;
    } else if (rec?.type === "turn_context") {
      const p = rec.payload || {};
      cwd = typeof p.cwd === "string" ? p.cwd : cwd; model = typeof p.model === "string" ? p.model : model;
    }
    const evidence = safeEvidence(rec);
    if (evidence) { currentMentions = mentions(evidence); currentCommands = commands(evidence); }
    if (!Number.isFinite(ts)) continue;
    if (rec?.type === "token_usage_record") {
      const p = rec.payload || {}; const responseId = p.response_id;
      const usage = normaliseCodexUsage(p.usage);
      if (usage && typeof responseId === "string" && !responseSeen.has(responseId)) {
        responseSeen.add(responseId);
        direct.push({ ts, kind: "turn", cwd, branch, sessionId, agentId: null, agentType: null,
          runtime: "codex", provider, model, usage, responseId, mentions: currentMentions, commands: currentCommands });
      }
    } else if (rec?.type === "event_msg" && rec.payload?.type === "token_count") {
      const raw = rec.payload?.info?.total_token_usage;
      const usage = normaliseCodexUsage(raw);
      if (usage) cumulative.push({ ts, usage, cwd, branch, sessionId, provider, model, mentions: currentMentions, commands: currentCommands });
    }
  }
  if (direct.length) return direct;
  /** @type {CodexUsage | null} */ let prev = null;
  return cumulative.flatMap((e) => {
    let usage;
    if (!prev) usage = e.usage;
    else {
      const previous = prev;
      const keys = /** @type {Array<keyof CodexUsage>} */ (["input", "output", "cacheRead", "cacheWrite", "thinking"]);
      const regressed = keys.some((k) => e.usage[k] < previous[k]);
      usage = regressed ? e.usage : /** @type {CodexUsage} */ (Object.fromEntries(keys.map((k) => [k, e.usage[k] - previous[k]])));
    }
    prev = e.usage;
    if (Object.values(usage).every((v) => v === 0)) return [];
    const responseId = `cumulative:${e.ts}:${usage.input}:${usage.cacheRead}:${usage.cacheWrite}:${usage.output}:${usage.thinking}`;
    return [{ ...e, kind: "turn", agentId: null, agentType: null, runtime: "codex", responseId, usage }];
  });
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  if (!existsSync(dir)) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** Enumerate active and archived rollout files; caller owns opt-in and root filtering. */
/** @param {string} [codexHome] @param {string[] | null} [roots] */
export function codexRolloutFiles(codexHome = DEFAULT_CODEX_HOME, roots = null) {
  /** @type {string[]} */ const out = [];
  walk(join(codexHome, "sessions"), out); walk(join(codexHome, "archived_sessions"), out);
  if (!Array.isArray(roots) || !roots.length) return out.sort();
  return out.filter((p) => {
    let head; try { head = readFileSync(p, "utf8").split("\n", 1)[0]; } catch { return false; }
    let rec; try { rec = JSON.parse(head || ""); } catch { return false; }
    const cwd = rec?.type === "session_meta" && typeof rec.payload?.cwd === "string" ? rec.payload.cwd : "";
    return roots.some((r) => cwd === r || cwd.startsWith(`${r}/`));
  }).sort();
}

/** Resolve metadata for an exact exec session without retaining transcript content. */
/** @param {string} sessionId @param {string} [codexHome] */
export function metadataForCodexSession(sessionId, codexHome = DEFAULT_CODEX_HOME) {
  const files = codexRolloutFiles(codexHome);
  const named = files.filter((p) => basename(p).includes(sessionId));
  for (const p of named.length ? named : files) {
    let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    let first; try { first = JSON.parse(lines[0] || ""); } catch { continue; }
    const meta = first?.type === "session_meta" ? first.payload : null;
    if (!meta || (meta.session_id !== sessionId && meta.id !== sessionId)) continue;
    let modelId = null;
    for (const line of lines.slice(1)) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type === "turn_context" && typeof rec.payload?.model === "string") modelId = rec.payload.model;
    }
    return { modelId: modelId || (typeof meta.model === "string" ? meta.model : null), provider: typeof meta.model_provider === "string" ? meta.model_provider : null };
  }
  return { modelId: null, provider: null };
}
