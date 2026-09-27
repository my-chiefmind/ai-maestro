#!/usr/bin/env node
// @ts-check
/**
 * Claude Code hook entry point for automatic usage recording (Stop / SubagentStop / SessionEnd).
 *
 * `render/sync.mjs` wires this into the consumer project's `.claude/settings.json`. Claude Code
 * pipes a JSON payload on stdin ({ session_id, transcript_path, cwd, hook_event_name, ... });
 * this runs the equivalent of
 *
 *   maestro usage sync --runtime claude --session <session_id> --transcript <transcript_path>
 *
 * and, on SessionEnd only, a cursor-based `--runtime codex` sync (Codex has no stable hooks, so
 * the end of any Claude session is the cheap, opportunistic moment to pick up Codex rollouts).
 *
 * The hook must never block or slow the session:
 *   - it ALWAYS exits 0 and prints nothing;
 *   - the actual sync runs in a child process killed after CHILD_TIMEOUT_MS (the settings entry
 *     also carries Claude Code's own `timeout`, HOOK_TIMEOUT_S);
 *   - the board lock is tried only briefly — if another sync holds it, this run is skipped
 *     (the next hook, or `maestro usage sync`, picks the turns up; appends dedup by key);
 *   - errors go to a small local log, `board/.usage-hook.log`, holding a timestamp, the event
 *     name, an error class and a sanitised error message (path-like tokens and anything but
 *     plain words are stripped) — never a prompt, path or transcript content.
 *
 * Worktrees: when the board sits in a linked git worktree, usage is recorded on the board of
 * the MAIN checkout (the worktree's copy is discarded with the worktree). See usage-worktree.mjs.
 *
 * Backfill: when the board has no import cursor yet (the first hook run), a one-time full
 * import of the project's existing Claude and Codex transcripts is started in a DETACHED
 * process — the hook itself does not wait for it. `maestro usage sync --all` is the manual path.
 *
 * No network: it runs the capsule-local kit with `node`, never `npx`.
 */
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveMainBoard } from "./usage-worktree.mjs";

export const HOOK_TIMEOUT_S = 5;
/** Child sync budget: stdin (≤500ms) + child + node startup must stay under HOOK_TIMEOUT_S. */
export const CHILD_TIMEOUT_MAX_MS = 3500;
export const CHILD_TIMEOUT_MS = Math.min(CHILD_TIMEOUT_MAX_MS, Math.max(100, Number(process.env.MAESTRO_USAGE_HOOK_TIMEOUT_MS) || CHILD_TIMEOUT_MAX_MS));
export const LOCK_WAIT_MS = 250;
export const STDIN_MAX_BYTES = 64 * 1024;
export const STDIN_DEADLINE_MS = 500;
export const HOOK_LOG_FILE = ".usage-hook.log";
const LOG_MAX_BYTES = 16 * 1024;
/** Transcripts above this are left to a manual `maestro usage sync` (keeps the hook bounded). */
export const HOOK_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How long SubagentStop waits for the subagent transcript to appear (within the child budget). */
export const AGENT_TRANSCRIPT_WAIT_MS = 1000;
const AGENT_TRANSCRIPT_POLL_MS = 100;
/** A backfill started less than this long ago is not started again. */
export const BACKFILL_RETRY_MS = 10 * 60 * 1000;
/** The detached backfill may wait this long for the board lock. */
const BACKFILL_LOCK_WAIT_MS = 30_000;
const USAGE_CURSOR_FILE = "usage-cursor.json";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT = /^[A-Za-z]{1,32}$/;

const SELF = fileURLToPath(import.meta.url);

/**
 * Reduce an error message to plain words: tokens that look like paths, URLs or home-relative
 * names are dropped, other characters outside a small safe set are removed, and the result is
 * bounded. Never returns transcript content (the sync never puts any into its messages).
 * @param {unknown} message
 */
export function sanitizeMessage(message) {
  if (typeof message !== "string") return "";
  return message.split(/\s+/)
    .filter((w) => w && !/[\/\\~]/.test(w) && !/^[A-Za-z]:/.test(w))
    .map((w) => w.replace(/[^A-Za-z0-9.,:;()'=_-]/g, ""))
    .filter(Boolean).join(" ").slice(0, 120);
}

/** Append one line to the capsule-local hook log; never throws. Keeps the log small. */
export function logHookError(/** @type {string} */ boardDir, /** @type {string} */ event, /** @type {string} */ kind, /** @type {string} */ message = "") {
  try {
    const path = join(boardDir, HOOK_LOG_FILE);
    if (!existsSync(boardDir)) return;
    const ev = EVENT.test(event) ? event : "unknown";
    const k = /^[A-Za-z0-9_-]{1,40}$/.test(kind) ? kind : "error";
    const msg = sanitizeMessage(message);
    const line = `${new Date().toISOString()} ${ev} ${k}${msg ? ` ${msg}` : ""}\n`;
    let size = 0; try { size = statSync(path).size; } catch { /* new */ }
    if (size > LOG_MAX_BYTES) {
      const tail = readFileSync(path, "utf8").split("\n").slice(-50).join("\n");
      writeFileSync(path, tail + line);
    } else appendFileSync(path, line);
  } catch { /* the log is best effort */ }
}

/** Error class for the log: a code or constructor name (the message is logged separately, sanitised). */
function kindOf(/** @type {any} */ e) {
  if (e && typeof e.code === "string") return e.code;
  if (e && typeof e.name === "string") return e.name;
  return "error";
}

/** Read stdin, bounded in size and time. Resolves "" on TTY, error, overflow or deadline. */
export function readStdin(stream = process.stdin, deadlineMs = STDIN_DEADLINE_MS) {
  return new Promise((done) => {
    if (stream.isTTY) return done("");
    /** @type {Buffer[]} */ const chunks = []; let size = 0, settled = false;
    const finish = (/** @type {string} */ v) => { if (settled) return; settled = true; clearTimeout(t); stream.pause(); stream.removeAllListeners?.("data"); done(v); };
    const t = setTimeout(() => finish(""), deadlineMs);
    stream.on("data", (/** @type {Buffer} */ c) => { size += c.length; if (size > STDIN_MAX_BYTES) finish(""); else chunks.push(c); });
    stream.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => finish(""));
  });
}

/**
 * Parent: parse the payload, then run the sync in a time-boxed child. Always returns 0.
 * @param {string[]} argv @param {string} [stdinText]
 */
export function runHook(argv, stdinText) {
  let boardDir = "";
  let event = "unknown";
  try {
    const bi = argv.indexOf("--board");
    boardDir = resolve(bi >= 0 && argv[bi + 1] ? argv[bi + 1] : join(process.cwd(), "board"));
    const text = stdinText ?? "";
    let payload; try { payload = JSON.parse(text); } catch { logHookError(boardDir, event, "bad-payload"); return 0; }
    if (!payload || typeof payload !== "object") { logHookError(boardDir, event, "bad-payload"); return 0; }
    if (typeof payload.hook_event_name === "string" && EVENT.test(payload.hook_event_name)) event = payload.hook_event_name;
    if (!existsSync(boardDir)) return 0;
    // A linked worktree records on the main checkout's board (the worktree copy is discarded).
    boardDir = resolveMainBoard(boardDir).boardDir;
    // Opt-out: usage.record=false makes the hook a no-op even before sync removes it.
    try {
      const cfg = JSON.parse(readFileSync(join(boardDir, "..", "config.json"), "utf8"));
      if (cfg?.usage?.record === false) return 0;
    } catch { /* no/invalid config: default is ON */ }
    const session = payload.session_id, transcript = payload.transcript_path;
    const jobs = [];
    if (typeof session === "string" && SESSION_ID.test(session) && typeof transcript === "string" && transcript) {
      jobs.push(["--runtime", "claude", "--session", session, "--transcript", transcript]);
    } else logHookError(boardDir, event, "no-transcript");
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    // SubagentStop carries the subagent's own transcript; the parent file does not hold its turns.
    // It may not be on disk yet when the hook fires: wait briefly, then fall back to the session's
    // subagents/ directory (dedup by key makes re-importing sibling subagent files harmless).
    if (typeof session === "string" && SESSION_ID.test(session) && (payload.agent_transcript_path || event === "SubagentStop")) {
      const given = !!payload.agent_transcript_path;
      const files = subagentTranscripts(payload, given ? Math.min(deadline, Date.now() + AGENT_TRANSCRIPT_WAIT_MS) : 0);
      if (!files.length && given) logHookError(boardDir, event, "no-agent-transcript", "Subagent transcript not found.");
      for (const f of files) jobs.push(["--runtime", "claude", "--session", session, "--transcript", f, "--subagent"]);
    }
    if (event === "SessionEnd") jobs.push(["--runtime", "codex"]);
    for (const job of jobs) {
      const left = deadline - Date.now();
      if (left <= 50) { logHookError(boardDir, event, "timeout"); break; }
      const r = spawnSync(process.execPath, [SELF, "--child", "--board", boardDir, ...job], {
        stdio: ["ignore", "ignore", "pipe"], timeout: left, killSignal: "SIGKILL", maxBuffer: 4096,
      });
      if (r.error || r.signal) logHookError(boardDir, event, r.signal ? "timeout" : kindOf(r.error));
      else if (r.status !== 0) {
        const [kind = "error", ...rest] = String(r.stderr || "").trim().split("\n").pop()?.split(/\s+/) || [];
        logHookError(boardDir, event, kind, rest.join(" "));
      }
    }
    maybeStartBackfill(boardDir, event);
  } catch (e) { logHookError(boardDir, event, kindOf(e), e instanceof Error ? e.message : ""); }
  return 0;
}

/** Synchronous sleep for the short transcript poll (the hook is already a short-lived process). */
function sleepMs(/** @type {number} */ ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} p */
function readable(p) { try { return statSync(p).isFile(); } catch { return false; } }

/**
 * The subagent transcript(s) for a SubagentStop payload. Claude Code documents
 * `agent_transcript_path` (plus `agent_id`, `agent_type`, `transcript_path`, `session_id`); on
 * disk the file is `<project dir>/<session_id>/subagents/agent-<agent_id>.jsonl`, next to the
 * main `<project dir>/<session_id>.jsonl`. Order of preference, polled until `until`:
 *   1. agent_transcript_path (relative paths resolve against the payload cwd);
 *   2. <dir of transcript_path>/<session_id>/subagents/agent-<agent_id>.jsonl;
 *   3. every *.jsonl in that subagents/ directory.
 * @param {any} payload @param {number} until epoch ms
 * @returns {string[]}
 */
export function subagentTranscripts(payload, until) {
  const cwd = typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const given = typeof payload.agent_transcript_path === "string" && payload.agent_transcript_path
    ? resolve(cwd, payload.agent_transcript_path) : null;
  const main = typeof payload.transcript_path === "string" && payload.transcript_path ? resolve(cwd, payload.transcript_path) : null;
  const subDir = main && typeof payload.session_id === "string" && SESSION_ID.test(payload.session_id)
    ? join(dirname(main), payload.session_id, "subagents") : null;
  const agentId = typeof payload.agent_id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(payload.agent_id) ? payload.agent_id : null;
  const byId = subDir && agentId ? [join(subDir, `agent-${agentId}.jsonl`), join(subDir, `${agentId}.jsonl`)] : [];
  for (;;) {
    if (given && readable(given)) return [given];
    const hit = byId.find(readable);
    if (hit) return [hit];
    if (Date.now() + AGENT_TRANSCRIPT_POLL_MS > until) break;
    sleepMs(AGENT_TRANSCRIPT_POLL_MS);
  }
  if (!subDir) return [];
  try {
    return readdirSync(subDir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => join(subDir, n)).filter(readable);
  } catch { return []; }
}

const backfillMarker = (/** @type {string} */ boardDir) =>
  join(tmpdir(), `ai-maestro-usage-backfill-${createHash("sha256").update(boardDir).digest("hex").slice(0, 16)}`);

/**
 * First run (no import cursor): start the one-time full import in a DETACHED process so the
 * hook returns immediately. A marker in the OS temp dir stops concurrent hooks from starting
 * a second one; it expires after BACKFILL_RETRY_MS so a crashed backfill is retried.
 * MAESTRO_USAGE_BACKFILL=0 disables it. Never throws.
 * @param {string} boardDir @param {string} event
 * @returns {boolean} whether a backfill was started
 */
export function maybeStartBackfill(boardDir, event) {
  try {
    if (process.env.MAESTRO_USAGE_BACKFILL === "0") return false;
    if (existsSync(join(boardDir, USAGE_CURSOR_FILE))) return false;
    const marker = backfillMarker(boardDir);
    try { if (Date.now() - statSync(marker).mtimeMs < BACKFILL_RETRY_MS) return false; } catch { /* none */ }
    writeFileSync(marker, `${process.pid}\n`);
    const child = spawn(process.execPath, [SELF, "--backfill", "--board", boardDir], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => logHookError(boardDir, event, "backfill-spawn"));
    child.unref();
    return true;
  } catch (e) { logHookError(boardDir, event, "backfill-spawn", e instanceof Error ? e.message : ""); return false; }
}

/** Detached backfill: the full import `maestro usage sync` does, then mark it done. */
async function runBackfill(/** @type {string[]} */ argv) {
  const i = argv.indexOf("--board");
  const boardDir = resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : "board");
  const lockOptions = { timeoutMs: BACKFILL_LOCK_WAIT_MS };
  try {
    const { syncUsage } = await import("./usage-sync.mjs");
    const { ensureUsageCursor } = await import("./usage-ledger.mjs");
    syncUsage({ boardDir, runtime: "all", lockOptions });
    ensureUsageCursor(boardDir, { lockOptions });
    return 0;
  } catch (e) {
    logHookError(boardDir, "Backfill", kindOf(e), e instanceof Error ? e.message : "");
    try { rmSync(backfillMarker(boardDir), { force: true }); } catch { /* retried after expiry */ }
    return 1;
  }
}

/** Child: the sync itself. Exit 0 ok / skipped; non-zero with an error class on stderr. */
async function runChild(/** @type {string[]} */ argv) {
  const get = (/** @type {string} */ f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const boardDir = resolve(get("--board") || "board");
  try {
    const { syncUsage } = await import("./usage-sync.mjs");
    /** @type {any} */ const runtime = get("--runtime");
    syncUsage({
      boardDir, runtime, session: get("--session"), transcript: get("--transcript"), subagent: argv.includes("--subagent"),
      maxFileBytes: HOOK_MAX_FILE_BYTES, lockOptions: { timeoutMs: LOCK_WAIT_MS },
    });
    return 0;
  } catch (e) {
    const kind = kindOf(e);
    if (kind === "BoardLockError" || kind === "EBOARDLOCK") { process.stderr.write("lock-held\n"); return 3; }
    process.stderr.write(`${/^[A-Za-z0-9_-]{1,40}$/.test(kind) ? kind : "error"} ${sanitizeMessage(e instanceof Error ? e.message : "")}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") runChild(argv.slice(1)).then((c) => process.exit(c), () => process.exit(1));
  else if (argv[0] === "--backfill") runBackfill(argv.slice(1)).then((c) => process.exit(c), () => process.exit(1));
  else readStdin().then((text) => process.exit(runHook(argv, text)), () => process.exit(0));
}

