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
 *   - errors go to a small local log, `board/.usage-hook.log`, holding only a timestamp, the
 *     event name and an error class — never a prompt, path or message text.
 *
 * No network: it runs the capsule-local kit with `node`, never `npx`.
 */
import { spawnSync } from "child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

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
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT = /^[A-Za-z]{1,32}$/;

const SELF = fileURLToPath(import.meta.url);

/** Append one line to the capsule-local hook log; never throws. Keeps the log small. */
export function logHookError(/** @type {string} */ boardDir, /** @type {string} */ event, /** @type {string} */ kind) {
  try {
    const path = join(boardDir, HOOK_LOG_FILE);
    if (!existsSync(boardDir)) return;
    const ev = EVENT.test(event) ? event : "unknown";
    const k = /^[A-Za-z0-9_-]{1,40}$/.test(kind) ? kind : "error";
    const line = `${new Date().toISOString()} ${ev} ${k}\n`;
    let size = 0; try { size = statSync(path).size; } catch { /* new */ }
    if (size > LOG_MAX_BYTES) {
      const tail = readFileSync(path, "utf8").split("\n").slice(-50).join("\n");
      writeFileSync(path, tail + line);
    } else appendFileSync(path, line);
  } catch { /* the log is best effort */ }
}

/** Error class for the log: a code or constructor name, never a message (which may hold paths). */
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
    // SubagentStop carries the subagent's own transcript; the parent file does not hold its turns.
    const agentTranscript = payload.agent_transcript_path;
    if (typeof session === "string" && SESSION_ID.test(session) && typeof agentTranscript === "string" && agentTranscript) {
      jobs.push(["--runtime", "claude", "--session", session, "--transcript", agentTranscript, "--subagent"]);
    }
    if (event === "SessionEnd") jobs.push(["--runtime", "codex"]);
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    for (const job of jobs) {
      const left = deadline - Date.now();
      if (left <= 50) { logHookError(boardDir, event, "timeout"); break; }
      const r = spawnSync(process.execPath, [SELF, "--child", "--board", boardDir, ...job], {
        stdio: ["ignore", "ignore", "pipe"], timeout: left, killSignal: "SIGKILL", maxBuffer: 4096,
      });
      if (r.error || r.signal) logHookError(boardDir, event, r.signal ? "timeout" : kindOf(r.error));
      else if (r.status !== 0) {
        const kind = String(r.stderr || "").trim().split(/\s+/).pop() || "error";
        logHookError(boardDir, event, kind);
      }
    }
  } catch (e) { logHookError(boardDir, event, kindOf(e)); }
  return 0;
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
    process.stderr.write(`${/^[A-Za-z0-9_-]{1,40}$/.test(kind) ? kind : "error"}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") runChild(argv.slice(1)).then((c) => process.exit(c), () => process.exit(1));
  else readStdin().then((text) => process.exit(runHook(argv, text)), () => process.exit(0));
}

