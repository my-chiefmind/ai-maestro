#!/usr/bin/env node
// @ts-check
/**
 * usage-scan.mjs — read Claude Code's local session transcripts into a privacy-safe event
 * stream that the attribution engine (scripts/usage-attribute.mjs) can assign to tickets.
 *
 * AI Maestro does not run models itself: it conducts Claude Code (and Codex) against a board.
 * So "how long did T-029 take and what did it cost in tokens" has to be reconstructed from
 * what those tools already write down. Claude Code logs one JSONL per session under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, plus one per subagent under
 * `<session-id>/subagents/agent-*.jsonl` with an `agent-*.meta.json` naming its `agentType`.
 * Every assistant turn carries `timestamp`, `message.model` and a `usage` block.
 *
 * PRIVACY IS THE POINT OF THIS FILE. A transcript is the most sensitive thing on the disk —
 * prompts, source code, command output, and whatever a tool result dragged in. This scanner
 * therefore never retains any of it. From each record it keeps only:
 *   - the timestamp, the model id, the token counts, the git branch, the session/agent id;
 *   - ticket-shaped identifiers (`T-123`) matched by regex, as bare ids;
 *   - board-mutating commands recognised by shape, reduced to (verb, ticket id).
 * Message text, tool inputs, tool results and file contents are read, matched, and dropped
 * inside `distill()`. Nothing else escapes it, and the on-disk cache holds only its output —
 * so the cache is aggregate-only by construction rather than by promise.
 *
 * Mentions are deliberately NOT harvested from tool RESULTS. Reading board/archive.json into
 * a tool result would otherwise "mention" all 26 archived tickets at once and poison every
 * turn after it. Only real user prompts, assistant prose, and tool INPUTS are evidence.
 *
 * Reading is opt-in at the caller (see usage-core.mjs's `enabled` gate), local, and strictly
 * read-only — this module opens nothing outside `projectsDir` and writes nothing but its own
 * cache.
 *
 * Repeat scans are cheap: each file's distilled events are cached by (path, mtime, size) in
 * `~/.maestro/usage-cache.json`, so a dashboard reload re-reads only what changed. The cache
 * also outlives Claude Code's own pruning of old sessions.
 *
 * No third-party dependencies.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname, basename } from "path";

export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const DEFAULT_CACHE_FILE = join(homedir(), ".maestro", "usage-cache.json");

/** Bump when `distill()`'s output shape changes, so stale caches are re-read, not trusted. */
export const CACHE_SCHEMA = 5;

/** Claude Code's own bookkeeping pseudo-model — retries and errors, never real inference. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Ticket-SHAPED identifiers: a short alphanumeric prefix, a hyphen, digits.
 *
 * Deliberately not `T-\d+`. Boards choose their own id prefixes — this kit uses `T-`, but
 * lense-kit uses `kit-096` and applicify used `tl-226`, and a hardcoded `T-` reported 0% of
 * 142 real tickets as unattributable. The prefix belongs to the board, not to this scanner.
 *
 * Being generous here is safe and being narrow is not: attribution accepts an id ONLY if the
 * board defines it (see usage-attribute.mjs), so noise like `UTF-8` or `ISO-8601` is matched,
 * carried, and then refused. A missed prefix, by contrast, is silently unrecoverable.
 */
const TICKET_RE = /\b[A-Za-z][A-Za-z0-9]{0,7}-\d{1,5}\b/g;

/** Ticket-shaped ids per record, so a pathological line cannot bloat the cache. */
const MAX_MENTIONS_PER_EVENT = 16;

/**
 * Commands that prove a session was working a specific ticket, rather than merely naming one.
 * Matched against tool INPUT strings only. Each entry reduces a command to (verb, ticket id);
 * the command itself is never retained.
 */
const ID = "([A-Za-z][A-Za-z0-9]{0,7}-\\d{1,5})";
const COMMAND_PATTERNS = [
  { verb: "set-status", re: new RegExp(`board-write\\.mjs\\b[^\\n]*?\\bset-status\\s+${ID}`, "g") },
  { verb: "set-status", re: new RegExp(`\\bmaestro\\s+ticket\\s+set-status\\s+${ID}`, "g") },
  { verb: "archive", re: new RegExp(`board-write\\.mjs\\b[^\\n]*?\\barchive\\s+${ID}`, "g") },
  { verb: "archive", re: new RegExp(`\\bmaestro\\s+ticket\\s+archive\\s+${ID}`, "g") },
  { verb: "block", re: new RegExp(`board-write\\.mjs\\b[^\\n]*?\\bblock\\s+${ID}`, "g") },
  { verb: "run", re: new RegExp(`\\bmaestro\\s+run\\s+${ID}`, "g") },
  { verb: "spec", re: new RegExp(`board/specs/${ID}\\.md`, "g") },
];

/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, thinking: number }} Usage */

/** @returns {Usage} */
export const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });

/**
 * `thinking` is a SUBSET of `output` (the API reports it under output_tokens_details), so it
 * is reported alongside the total, never summed into it. Double-counting reasoning tokens
 * would inflate every headline number on the dashboard.
 * @param {Usage} u
 */
export const totalTokens = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** @param {Usage} a @param {Usage} b @returns {Usage} */
export function addUsage(a, b) {
  a.input += b.input; a.output += b.output;
  a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite;
  a.thinking += b.thinking;
  return a;
}

/**
 * Normalise a Claude Code usage block.
 *
 * TWO SHAPES, and they are not interchangeable. A transcript turn and the `-p --output-format
 * json` envelope report snake_case (`input_tokens`); that envelope's own per-model breakdown,
 * `modelUsage`, reports camelCase (`inputTokens`, `cacheReadInputTokens`). Reading only the
 * first produced a telemetry record stamped `usageSource: "provider"` with every counter at
 * zero — worse than no record, because it claims a stage was free. Both spellings are accepted
 * here so a caller cannot pick the wrong one.
 *
 * Unknown or missing counters read as zero rather than NaN: a payload from a different CLI
 * version must degrade, not corrupt the totals. `modelUsage` carries no reasoning count at
 * all, which is why callers prefer the top-level block whenever a run used a single model.
 * @param {any} u
 * @returns {Usage}
 */
export function normaliseUsage(u) {
  const n = (/** @type {any} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pick = (/** @type {string} */ snake, /** @type {string} */ camel) =>
    n(u?.[snake] !== undefined ? u[snake] : u?.[camel]);
  return {
    input: pick("input_tokens", "inputTokens"),
    output: pick("output_tokens", "outputTokens"),
    cacheRead: pick("cache_read_input_tokens", "cacheReadInputTokens"),
    cacheWrite: pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
    thinking: n(u?.output_tokens_details?.thinking_tokens ?? u?.thinkingTokens),
  };
}

/**
 * Claude Code encodes a session's cwd into its project directory name by replacing `/` and
 * `_` with `-`. That is lossy and cannot be decoded back, so we never try: we encode the
 * root we're looking for and match forwards. A git worktree of the repo gets its own
 * directory sharing that prefix, which is why worktree sessions are picked up too.
 * @param {string} absPath
 */
export function encodeProjectDir(absPath) {
  return absPath.replace(/[/_]/g, "-");
}

/**
 * @param {string} projectsDir
 * @param {string[]} roots  Absolute repo roots whose sessions we want.
 * @returns {string[]} absolute transcript directories
 */
export function transcriptDirsFor(projectsDir, roots) {
  if (!existsSync(projectsDir)) return [];
  const prefixes = roots.map(encodeProjectDir);
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(projectsDir)) {
    if (prefixes.some((p) => name === p || name.startsWith(`${p}-`))) out.push(join(projectsDir, name));
  }
  return out.sort();
}

/**
 * Pull every ticket id out of a string. Returns bare ids — the string is not retained.
 * @param {string} s @returns {string[]}
 */
function mentionsIn(s) {
  const m = s.match(TICKET_RE);
  return m ? [...new Set(m)].slice(0, MAX_MENTIONS_PER_EVENT) : [];
}

/**
 * Recognise board-mutating commands. Returns (verb, id) pairs; the command is not retained.
 * @param {string} s @returns {Array<{ verb: string, id: string }>}
 */
function commandsIn(s) {
  /** @type {Array<{ verb: string, id: string }>} */
  const out = [];
  for (const { verb, re } of COMMAND_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) { if (m[1]) out.push({ verb, id: m[1] }); }
  }
  return out;
}

/**
 * Collect the text a record contributes as EVIDENCE, and nothing else.
 *
 * Evidence is what a human or an agent deliberately wrote: the user's prompt, the assistant's
 * prose, and the arguments of tool calls. A tool RESULT is not evidence — it is whatever the
 * filesystem happened to contain — so it is skipped entirely. See the file header.
 * @param {any} rec
 * @returns {{ text: string, toolText: string }}
 */
function evidenceText(rec) {
  const content = rec?.message?.content;
  if (typeof content === "string") return { text: content, toolText: "" };
  if (!Array.isArray(content)) return { text: "", toolText: "" };
  const text = [];
  const toolText = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block.type === "tool_use") {
      // Only the fields that carry an identifier by intent. `input` wholesale would sweep in
      // file bodies from Write/Edit calls, which is exactly the content we refuse to read.
      for (const key of ["command", "file_path", "path", "description", "pattern", "prompt", "title", "old_string", "new_string"]) {
        const v = block.input?.[key];
        if (typeof v === "string") toolText.push(v);
      }
    }
    // block.type === "tool_result" and everything else: deliberately dropped.
  }
  return { text: text.join("\n"), toolText: toolText.join("\n") };
}

/**
 * @typedef {{
 *   ts: number, kind: "turn" | "evidence", cwd: string, branch: string | null, sessionId: string,
 *   agentId: string | null, agentType: string | null,
 *   model?: string, usage?: Usage,
 *   mentions: string[], commands: Array<{ verb: string, id: string }>,
 * }} UsageEvent
 */

/**
 * Distil one transcript file into ordered events. Content in, aggregates out — this is the
 * only function in the kit that ever sees transcript text, and it returns none of it.
 *
 * Note what it does NOT do: filter by repo. Each event carries the `cwd` the record reported
 * and the caller decides who owns it (`eventsForRoots`). That split is what makes the on-disk
 * cache independent of which project is being reported on — bake a root filter in here and the
 * cache is only valid for the one question it was first asked, which breaks the moment a
 * portfolio rollup asks about two overlapping repos.
 * @param {string} filePath
 * @param {{ agentType?: string | null }} [opts]
 * @returns {UsageEvent[]}
 */
export function distill(filePath, opts = {}) {
  const agentType = opts.agentType ?? null;
  /** @type {UsageEvent[]} */
  const events = [];
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch { return events; }

  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const { text: prose, toolText } = evidenceText(rec);
    const mentions = mentionsIn(`${prose}\n${toolText}`);
    const commands = commandsIn(toolText);

    const usage = rec?.message?.usage;
    const model = rec?.message?.model;
    const isTurn = rec.type === "assistant" && usage && model && model !== SYNTHETIC_MODEL;
    if (!isTurn && !mentions.length && !commands.length && !rec.gitBranch) continue;

    events.push({
      ts,
      kind: isTurn ? "turn" : "evidence",
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
      branch: typeof rec.gitBranch === "string" ? rec.gitBranch : null,
      sessionId: typeof rec.sessionId === "string" ? rec.sessionId : basename(filePath, ".jsonl"),
      agentId: typeof rec.agentId === "string" ? rec.agentId : null,
      agentType,
      ...(isTurn ? { model, usage: normaliseUsage(usage) } : {}),
      mentions,
      commands,
    });
  }
  return events;
}

/**
 * Does `cwd` belong to `root` — and not to a MORE SPECIFIC root that also contains it?
 *
 * This is the whole of nested-repo correctness. `~/source/lense-kit` and
 * `~/source/lense-kit/applicify-group/applicify` are both real projects with their own boards,
 * and plain prefix matching puts the inner repo's every turn on BOTH of them. In a portfolio
 * rollup that is not a rounding error: the nested project's tokens are counted twice and the
 * parent is credited with work it never did.
 *
 * So ownership goes to the longest matching root, and `excludeRoots` carries the other
 * projects' roots. A root is only excluded when it is strictly deeper than this one, so a
 * sibling project can never suppress work that is genuinely ours.
 * @param {string} cwd
 * @param {string[]} roots
 * @param {string[]} excludeRoots
 */
export function ownsCwd(cwd, roots, excludeRoots = []) {
  const under = (/** @type {string} */ r) => cwd === r || cwd.startsWith(`${r}/`);
  const mine = roots.filter(under);
  if (!mine.length) return false;
  const deepest = Math.max(...mine.map((r) => r.length));
  return !excludeRoots.some((r) => under(r) && r.length > deepest);
}

/**
 * @param {UsageEvent[]} events
 * @param {string[]} roots
 * @param {string[]} [excludeRoots]
 */
export function eventsForRoots(events, roots, excludeRoots = []) {
  return events.filter((e) => ownsCwd(e.cwd, roots, excludeRoots));
}

/** @param {string} cacheFile */
function loadCache(cacheFile) {
  if (!existsSync(cacheFile)) return { schema: CACHE_SCHEMA, files: {} };
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (c?.schema !== CACHE_SCHEMA) return { schema: CACHE_SCHEMA, files: {} };
    return { schema: CACHE_SCHEMA, files: c.files || {} };
  } catch { return { schema: CACHE_SCHEMA, files: {} }; }
}

/** @param {string} cacheFile @param {any} cache */
function saveCache(cacheFile, cache) {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), "utf8");
  // Rename over the real file so a concurrent reader never sees a half-written cache.
  renameSync(tmp, cacheFile);
}

/**
 * Read every transcript belonging to `roots`, using and refreshing the on-disk cache.
 * @param {{ roots: string[], excludeRoots?: string[], projectsDir?: string, cacheFile?: string, useCache?: boolean }} opts
 * @returns {{ events: UsageEvent[], sessions: number, files: number, agentTypes: Record<string, number> }}
 */
export function scanTranscripts(opts) {
  const projectsDir = opts.projectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  const cacheFile = opts.cacheFile ?? DEFAULT_CACHE_FILE;
  const useCache = opts.useCache !== false;
  const roots = opts.roots;
  const excludeRoots = opts.excludeRoots ?? [];
  const cache = useCache ? loadCache(cacheFile) : { schema: CACHE_SCHEMA, files: {} };
  let dirty = false;

  /** @type {UsageEvent[]} */
  const events = [];
  const sessions = new Set();
  /** @type {Record<string, number>} */
  const agentTypes = {};
  let files = 0;

  /** @param {string} filePath @param {string | null} agentType */
  const take = (filePath, agentType) => {
    let stat;
    try { stat = statSync(filePath); } catch { return; }
    const sig = `${stat.mtimeMs}:${stat.size}`;
    const cached = cache.files[filePath];
    let distilled;
    if (cached && cached.sig === sig) {
      distilled = cached.events;
    } else {
      distilled = distill(filePath, { agentType });
      cache.files[filePath] = { sig, events: distilled };
      dirty = true;
    }
    files++;
    // Ownership is decided here, not in distill, so one cached parse serves every caller.
    for (const e of eventsForRoots(distilled, roots, excludeRoots)) {
      events.push(e);
      sessions.add(e.sessionId);
      if (e.kind === "turn") {
        const k = e.agentType || "main";
        agentTypes[k] = (agentTypes[k] || 0) + 1;
      }
    }
  };

  for (const dir of transcriptDirsFor(projectsDir, roots)) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.endsWith(".jsonl")) take(join(dir, name), null);
    }
    // Subagent transcripts live one level down, with their agentType in a sibling meta file.
    // Without this pass the roster breakdown would credit every subagent turn to "main".
    for (const name of entries) {
      const subDir = join(dir, name, "subagents");
      if (!existsSync(subDir)) continue;
      let subs;
      try { subs = readdirSync(subDir); } catch { continue; }
      for (const s of subs) {
        if (!s.endsWith(".jsonl")) continue;
        const metaPath = join(subDir, s.replace(/\.jsonl$/, ".meta.json"));
        let agentType = "subagent";
        try { agentType = JSON.parse(readFileSync(metaPath, "utf8")).agentType || agentType; } catch { /* unnamed subagent */ }
        take(join(subDir, s), agentType);
      }
    }
  }

  if (dirty && useCache) {
    try { saveCache(cacheFile, cache); } catch { /* a failed save only costs a re-scan */ }
  }

  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions: sessions.size, files, agentTypes };
}
