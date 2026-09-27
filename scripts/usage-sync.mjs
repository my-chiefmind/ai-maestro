#!/usr/bin/env node
// @ts-check
/**
 * `maestro usage sync` — import Claude Code and Codex transcript usage into the recorded
 * ledger (`board/usage.jsonl`).
 *
 * Reuses the existing distillers (usage-scan `distill`, usage-codex `distillCodexRollout`) so
 * token binning is identical to the report: disjoint input / output / cacheRead / cacheWrite
 * bins, reasoning inside output, total = input + output + cacheRead + cacheWrite.
 *
 * COMPLETE PER SESSION. The report skips a recorded session wholesale in the transcript scan,
 * so a partially-recorded session would hide its unrecorded turns. Therefore whenever any file
 * of a session changed, every file of that session is re-distilled and every owned turn is
 * offered to `appendUsage`, which dedups by the stable key `runtime:sessionId:turnId`.
 * The cursor (`board/usage-cursor.json`) only lets unchanged sessions be skipped cheaply.
 *
 * Nothing but counts and safe identifiers leaves this module: no prompt, response, or tool
 * text, and no filesystem paths (cursor ids are `runtime:sessionId:file`, not paths).
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { distill, eventsForRoots, transcriptDirsFor, DEFAULT_CLAUDE_PROJECTS_DIR } from "./usage-scan.mjs";
import { distillCodexRollout, codexRolloutFiles, DEFAULT_CODEX_HOME } from "./usage-codex.mjs";
import { attribute, ticketIndex } from "./usage-attribute.mjs";
import { rootsForBoard } from "./usage-core.mjs";
import { appendUsage, readUsage, readUsageCursor, usageRecordEnabled } from "./usage-ledger.mjs";
import { linkedWorktreeRoots } from "./usage-worktree.mjs";

/**
 * The roots whose sessions belong to a board: the project (see rootsForBoard) plus every
 * linked git worktree of the same repository — sessions run there are recorded on the main
 * board. Directories that are not worktrees of this repo are never added.
 * @param {string} boardDir
 */
export function ownedRoots(boardDir) {
  const base = rootsForBoard(boardDir);
  const wt = linkedWorktreeRoots(resolve(boardDir, ".."));
  return [...new Set([...base, ...wt])];
}

export const RUNTIMES = ["claude", "codex"];
/** A transcript larger than this is skipped (and reported), keeping a sync bounded. */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._@+/-]*$/;
const safe = (/** @type {any} */ v, /** @type {string} */ d, max = 128) =>
  typeof v === "string" && v && v.length <= max && IDENT.test(v) ? v : d;
const short = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * @typedef {{ runtime: string, sessionId: string, fileId: string, path: string, agentType: string | null, size: number }} Source
 */

/** @param {string} p */
function sizeOf(p) { try { return statSync(p).size; } catch { return -1; } }

/** First sessionId in a Claude transcript (subagent files carry the parent's). */
function claudeSessionOf(/** @type {string} */ p, /** @type {string} */ fallback) {
  let text; try { text = readFileSync(p, "utf8"); } catch { return fallback; }
  for (const line of text.split("\n", 50)) {
    try { const r = JSON.parse(line); if (typeof r?.sessionId === "string") return r.sessionId; } catch { /* skip */ }
  }
  return fallback;
}

/** @param {string} projectsDir @param {string[]} roots @returns {Source[]} */
function claudeSources(projectsDir, roots) {
  /** @type {Source[]} */ const out = [];
  for (const dir of transcriptDirsFor(projectsDir, roots)) {
    let entries; try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name), sid = name.slice(0, -6);
      out.push({ runtime: "claude", sessionId: claudeSessionOf(path, sid), fileId: "main", path, agentType: null, size: sizeOf(path) });
    }
    for (const name of entries) {
      const subDir = join(dir, name, "subagents");
      if (!existsSync(subDir)) continue;
      let subs; try { subs = readdirSync(subDir); } catch { continue; }
      for (const s of subs) {
        if (!s.endsWith(".jsonl")) continue;
        const path = join(subDir, s);
        let agentType = "subagent";
        try { agentType = safeAgentType(JSON.parse(readFileSync(join(subDir, s.replace(/\.jsonl$/, ".meta.json")), "utf8")).agentType); } catch { /* unnamed */ }
        out.push({ runtime: "claude", sessionId: claudeSessionOf(path, name), fileId: `sub-${short(s)}`, path, agentType, size: sizeOf(path) });
      }
    }
  }
  return out;
}

const AGENT_TYPE = /^[A-Za-z0-9._-]{1,64}$/;
/** A *.meta.json agentType is untrusted file content: keep it only when it is a short, plain label. */
export function safeAgentType(/** @type {unknown} */ v) {
  return typeof v === "string" && AGENT_TYPE.test(v) ? v : "subagent";
}

/** @param {string} codexHome @param {string[]} roots @returns {Source[]} */
function codexSources(codexHome, roots) {
  return codexRolloutFiles(codexHome, roots).map((path) => ({
    runtime: "codex", sessionId: codexSessionOf(path), fileId: "rollout", path, agentType: null, size: sizeOf(path),
  }));
}

function codexSessionOf(/** @type {string} */ p) {
  try {
    const r = JSON.parse(readFileSync(p, "utf8").split("\n", 1)[0] || "");
    const id = r?.payload?.session_id || r?.payload?.id;
    if (typeof id === "string") return id;
  } catch { /* fall through */ }
  return `file-${short(p)}`;
}

/** @param {Source} s */
const cursorId = (s) => `${s.runtime}:${s.sessionId}:${s.fileId}`;

/**
 * Convert attributed turns of one session into ledger records with stable keys.
 * @param {Source} src @param {any[]} events distilled events of that file, in file order
 */
function keyEvents(src, events) {
  let i = 0;
  return events.map((e) => {
    if (e.kind !== "turn") return e;
    // Claude: message.id (fallback requestId), exposed by distill() as responseId — stable
    // and unique across files, so resumed/subagent files and re-imports dedup by key.
    const id = e.responseId ? String(e.responseId) : null;
    const turnKey = id
      ? (src.runtime === "claude" && id.length <= 128 && IDENT.test(id) ? id : `r-${short(id)}`)
      : `${src.fileId}-${i}`;
    i++;
    return { ...e, turnKey, runtime: src.runtime, provider: e.provider || (src.runtime === "codex" ? "openai" : "anthropic") };
  });
}

/** @param {string | null} evidence */
function evidenceKind(evidence) {
  if (!evidence) return "none";
  if (evidence === "branch") return "branch";
  if (evidence.startsWith("board-write:")) return "command";
  if (evidence.startsWith("mention")) return "mention";
  return "none";
}

/**
 * Run a sync.
 * @param {{
 *   boardDir: string,
 *   runtime?: "claude" | "codex" | "all",
 *   all?: boolean,
 *   session?: string, transcript?: string, subagent?: boolean,
 *   roots?: string[], excludeRoots?: string[],
 *   projectsDir?: string, codexHome?: string,
 *   config?: any, data?: any, archive?: any,
 *   maxFileBytes?: number,
 *   lockOptions?: { timeoutMs?: number, staleMs?: number },
 * }} opts
 */
export function syncUsage(opts) {
  const boardDir = resolve(opts.boardDir);
  const readJson = (/** @type {string} */ p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
  const config = opts.config !== undefined ? opts.config : readJson(resolve(boardDir, "..", "config.json"));
  const runtime = opts.runtime || "all";
  if (!["claude", "codex", "all"].includes(runtime)) throw new Error(`--runtime must be claude, codex, or all.`);
  /** @type {Record<string, {imported:number, sessions:number, skippedSessions:number}>} */
  const perRuntime = {};
  for (const r of RUNTIMES) perRuntime[r] = { imported: 0, sessions: 0, skippedSessions: 0 };
  const result = { recording: usageRecordEnabled(config), runtimes: perRuntime, imported: 0, duplicates: 0, skippedFiles: 0, cursorUpdated: 0 };
  if (!result.recording) return result;

  const roots = (opts.roots || ownedRoots(boardDir)).map((r) => resolve(r));
  const excludeRoots = (opts.excludeRoots || []).map((r) => resolve(r));
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const data = opts.data !== undefined ? opts.data : readJson(join(boardDir, "data.json"));
  const archive = opts.archive !== undefined ? opts.archive : readJson(join(boardDir, "archive.json"));
  const index = ticketIndex(data, archive);

  /** @type {Source[]} */ let sources;
  if (opts.transcript) {
    if (!opts.session) throw new Error("--transcript requires --session <id>.");
    const path = resolve(opts.transcript);
    let head = ""; try { head = readFileSync(path, "utf8").split("\n", 1)[0]; } catch { throw new Error("Transcript is not readable."); }
    const isCodex = runtime === "codex" || (runtime === "all" && /"type"\s*:\s*"session_meta"/.test(head));
    if (opts.subagent && !isCodex) {
      // An explicit Claude subagent transcript (<session>/subagents/agent-*.jsonl): same fileId
      // and agentType as the directory scan gives it, so keys/labels match either way.
      const name = basename(path);
      let agentType = "subagent";
      try { agentType = safeAgentType(JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")).agentType); } catch { /* unnamed */ }
      sources = [{ runtime: "claude", sessionId: opts.session, fileId: `sub-${short(name)}`, path, agentType, size: sizeOf(path) }];
    } else sources = [{ runtime: isCodex ? "codex" : "claude", sessionId: opts.session, fileId: isCodex ? "rollout" : "main", path, agentType: null, size: sizeOf(path) }];
  } else {
    sources = [];
    if (runtime !== "codex") sources.push(...claudeSources(opts.projectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR, roots));
    if (runtime !== "claude") sources.push(...codexSources(opts.codexHome ?? DEFAULT_CODEX_HOME, roots));
    if (opts.session) sources = sources.filter((s) => s.sessionId === opts.session);
  }

  const cursor = readUsageCursor(boardDir).sources;
  /** @type {Map<string, Source[]>} */ const bySession = new Map();
  for (const s of sources) {
    if (s.size < 0) continue;
    if (s.size > maxFileBytes) { result.skippedFiles++; continue; }
    const k = `${s.runtime}:${s.sessionId}`;
    let arr = bySession.get(k); if (!arr) bySession.set(k, (arr = [])); arr.push(s);
  }

  const records = [];
  /** @type {Record<string, {offset:number}>} */ const cursorPatch = {};
  for (const [, group] of [...bySession].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rt = group[0].runtime;
    const changed = opts.all || opts.transcript || group.some((s) => cursor[cursorId(s)]?.offset !== s.size);
    if (!changed) { perRuntime[rt].skippedSessions++; continue; }
    const events = [];
    for (const s of group) {
      const raw = s.runtime === "codex" ? distillCodexRollout(s.path) : distill(s.path, { agentType: s.agentType });
      events.push(...keyEvents(s, s.runtime === "codex" ? raw.map((e) => ({ ...e, sessionId: s.sessionId })) : raw));
    }
    const owned = eventsForRoots(events, roots, excludeRoots);
    const { turns } = attribute(owned, index);
    for (const t of turns) {
      if (!t.turnKey) continue;
      const u = t.usage;
      const output = u.output, reasoning = Math.min(u.thinking || 0, output);
      records.push({
        v: 1, key: `${rt}:${safe(t.sessionId, `s-${short(t.sessionId)}`)}:${t.turnKey}`, runtime: rt,
        provider: safe(t.provider, "unknown", 64), model: safe(t.model, "unknown"),
        ts: new Date(t.ts).toISOString(), sessionId: safe(t.sessionId, `s-${short(t.sessionId)}`),
        agentType: safe(t.agentType, "main", 64), branch: safe(t.branch, "unknown", 200),
        ticketId: t.ticketId ? safe(t.ticketId, null, 64) : null,
        confidence: safe(t.confidence, "unassigned", 32), evidenceKind: evidenceKind(t.evidence),
        usage: { input: u.input, output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning, total: u.input + output + u.cacheRead + u.cacheWrite },
      });
    }
    if (owned.some((e) => e.kind === "turn")) perRuntime[rt].sessions++;
    if (!opts.transcript) for (const s of group) if (cursor[cursorId(s)]?.offset !== s.size) cursorPatch[cursorId(s)] = { offset: s.size };
  }

  if (!records.length && !Object.keys(cursorPatch).length) return result;
  // Tally per runtime from what appendUsage actually wrote (it dedups by key under the lock,
  // both against the ledger and within the batch), not from a pre-read — a pre-read counted
  // a turn twice when the same message id appeared in two files of one batch. One append per
  // runtime keeps the split exact; the cursor advances with the last one.
  let appended = 0, skipped = 0;
  const groups = RUNTIMES.map((rt) => records.filter((r) => r.runtime === rt)).filter((g) => g.length);
  if (!groups.length) groups.push([]);
  groups.forEach((group, i) => {
    const last = i === groups.length - 1;
    const res = appendUsage(boardDir, group, {
      ...(last && Object.keys(cursorPatch).length ? { cursor: cursorPatch } : {}),
      ...(opts.lockOptions ? { lockOptions: opts.lockOptions } : {}),
    });
    if (group.length) perRuntime[group[0].runtime].imported += res.appended;
    appended += res.appended; skipped += res.skipped;
  });
  result.imported = appended; result.duplicates = skipped; result.cursorUpdated = Object.keys(cursorPatch).length;
  return result;
}

/** CLI: `maestro usage sync [...]`. */
export function main(/** @type {string[]} */ argv) {
  const known = new Set(["--runtime", "--session", "--transcript", "--all", "--subagent", "--board", "--exclude-root", "--json", "--help", "-h"]);
  const takesValue = new Set(["--runtime", "--session", "--transcript", "--board", "--exclude-root"]);
  /** @type {Record<string, any>} */ const o = { excludeRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) { console.error(`✗ Unknown option: ${a}`); return 2; }
    if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) { console.error(`✗ ${a} needs a value.`); return 2; }
      if (a === "--exclude-root") o.excludeRoots.push(v); else o[a.slice(2)] = v;
    } else o[a.replace(/^-+/, "")] = true;
  }
  if (o.help || o.h) {
    process.stdout.write(`
  maestro usage sync       import Claude Code / Codex transcript usage into board/usage.jsonl

  Flags:
    --runtime claude|codex|all   which runtime(s) to import (default all)
    --session <id>               only this session
    --transcript <path>          import this transcript file (needs --session)
    --subagent                   the --transcript is a Claude subagent file (<session>/subagents/agent-*.jsonl)
    --all                        ignore the cursor and re-read every session (still dedups; the manual backfill)
    --exclude-root <dir>         a nested project whose sessions are not ours (repeatable)
    --board <dir>                board directory (default: ./board)
    --json                       print the summary as JSON
`);
    return 0;
  }
  const boardDir = resolve(o.board || join(process.cwd(), "board"));
  let r;
  try {
    r = syncUsage({ boardDir, runtime: o.runtime, all: !!o.all, session: o.session, transcript: o.transcript, subagent: !!o.subagent, excludeRoots: o.excludeRoots });
  } catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); return 1; }
  if (o.json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return 0; }
  if (!r.recording) { console.log('Usage recording is off (config.json "usage": { "record": false }) — nothing written.'); return 0; }
  for (const rt of RUNTIMES) {
    const s = r.runtimes[rt];
    console.log(`${rt.padEnd(7)} ${s.imported} turn(s) imported from ${s.sessions} session(s); ${s.skippedSessions} unchanged session(s) skipped`);
  }
  console.log(`total   ${r.imported} new, ${r.duplicates} already recorded, ${r.skippedFiles} oversized file(s) skipped, cursor ${r.cursorUpdated ? `advanced for ${r.cursorUpdated} file(s)` : "unchanged"}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) process.exit(main(process.argv.slice(2)));
