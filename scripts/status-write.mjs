#!/usr/bin/env node
/**
 * status-write.mjs — `maestro status <op>`: the machine-local shared ticket status
 * (config.localStatus; see docs/LOCAL-STATUS.md).
 *
 * Usage:
 *   maestro status show <id>          one ticket as every reader sees it (definition + status)
 *   maestro status list               the store's entries (tickets whose status is local)
 *   maestro status sync               write the logical board into data.json/archive.json and
 *                                     archive done tickets; a no-op when nothing changed
 *   maestro status log [--limit N]    the append-only change log, newest first
 *   maestro status export [--out f]   back up the store (default: the common dir's backups)
 *   maestro status import <file> [--replace]   restore an export (merge by default)
 *   maestro status where              the store's ref, lock and backup locations
 *
 * Common flags:
 *   --board <path>   board/data.json (default: ./board/data.json, else ./maestro/board/data.json)
 *   --config <path>  project config (default: alongside the board's directory)
 *   --json           machine-readable result on stdout
 *   --dry-run        sync/import: report what would change; write nothing
 *
 * Exit codes: 0 = ok (or no-op), 1 = usage/validation failure, 2 = conflict or lock timeout
 * (retryable).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readTicket, readLocalStatus, localStatusLog, syncLocalStatus, exportLocalStatus, importLocalStatus,
} from "./board-api.mjs";
import { localStatusSettings } from "./local-status.mjs";

const argv = process.argv.slice(2);
const op = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");
const DRY_RUN = has("dry-run");

function die(msg, code = 1) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg, code }) + "\n");
  else process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code);
}
function ok(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  else process.stdout.write(`${human}\n`);
  process.exit(0);
}
function usage() {
  process.stdout.write(`
  maestro status — machine-local ticket status shared by every worktree (config.localStatus)

    maestro status show <id>              one ticket: definition from git + local status
    maestro status list                   tickets whose status is held locally
    maestro status sync [--dry-run]       write status into data.json/archive.json, archive
                                          done tickets; commit the result in one daily PR
    maestro status log [--limit N]        append-only change log, newest first
    maestro status export [--out <file>]  back up the store (default: <git-common-dir>/maestro/status/backups/)
    maestro status import <file> [--replace]  restore a backup (merges by default)
    maestro status where                  where the store, lock and backups live

    --board <path>  --config <path>  --json  --dry-run
`);
  process.exit(op ? 0 : 1);
}

if (!op || op === "--help" || op === "-h" || op === "help") usage();
const OPS = ["show", "list", "sync", "log", "export", "import", "where"];
if (!OPS.includes(op)) die(`Unknown status op "${op}". Expected one of: ${OPS.join(", ")}.`);

const defaultBoard = existsSync(join(process.cwd(), "board", "data.json")) || !existsSync(join(process.cwd(), "maestro", "board", "data.json"))
  ? join(process.cwd(), "board", "data.json") : join(process.cwd(), "maestro", "board", "data.json");
const dataPath = resolve(flag("board", defaultBoard));
const configPath = flag("config") ? resolve(flag("config")) : undefined;
const base = { dataPath, ...(configPath ? { configPath } : {}) };
const subject = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;

try {
  if (!existsSync(dataPath)) die(`Board file not found: ${dataPath}. Pass --board <path>.`);
  if (op === "show") {
    if (!subject) die("Usage: maestro status show <id>");
    const r = readTicket({ ...base, id: subject });
    const t = r.ticket;
    ok(r, `${t.id}\t${t.status}\t${r.location}\t(${r.source === "local-status" ? "local status" : "from files"})` +
      `${t.currentAgent ? `\tagent ${t.currentAgent}` : ""}`);
  }
  if (op === "list") {
    const r = readLocalStatus(base);
    if (!r.enabled) ok(r, "Local status is off for this board (config.localStatus.enabled is not true).");
    const rows = Object.entries(r.tickets).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([id, e]) => `${id}\t${e.fields?.status ?? "-"}\t${e.location}\t${e.updatedAt}`);
    ok(r, rows.length ? rows.join("\n") : "No local status yet — every ticket reads from the files.");
  }
  if (op === "where") {
    const s = localStatusSettings(base);
    if (!s) ok({ enabled: false }, "Local status is off for this board.");
    const where = { enabled: true, ref: s.ref, board: s.board, commonDir: s.common, lock: join(s.lockDir, s.lockName),
      backups: join(s.lockDir, "backups", s.boardKey), fields: s.fields };
    ok(where, Object.entries(where).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n"));
  }
  if (op === "log") {
    const r = localStatusLog({ ...base, limit: Number(flag("limit", "50")) });
    ok(r, r.entries.map((e) => `${e.at ?? "?"}  ${e.op}  ${e.branch ?? e.worktree ?? ""}  ` +
      (e.changes ?? []).map((c) => `${c.id}: ${c.from?.status ?? "∅"}→${c.to?.status ?? "∅"}${c.to?.location === "archive" && c.from?.location !== "archive" ? " (archived)" : ""}`).join(", ")).join("\n") || "No changes logged yet.");
  }
  if (op === "export") {
    const out = flag("out");
    const r = exportLocalStatus({ ...base, out: out ? resolve(out) : undefined });
    ok({ path: r.path, oid: r.document.oid, tickets: Object.keys(r.document.store.tickets).length },
      `  ✓ exported ${Object.keys(r.document.store.tickets).length} ticket status(es) to ${r.path}`);
  }
  if (op === "import") {
    if (!subject) die("Usage: maestro status import <file> [--replace]");
    const r = importLocalStatus({ ...base, file: resolve(subject), mode: has("replace") ? "replace" : "merge", dryRun: DRY_RUN });
    ok(r, r.changed ? `  ✓ ${r.dryRun ? "would import" : "imported"} ${r.tickets.length} ticket status(es)` : "  ✓ nothing to import (already identical)");
  }
  if (op === "sync") {
    const r = syncLocalStatus({ ...base, dryRun: DRY_RUN });
    if (!r.changed) ok(r, "  ✓ board files already match the shared status — nothing to sync");
    ok(r, `  ✓ ${r.dryRun ? "would sync" : "synced"}: ${r.files.length} file(s)` +
      `${r.archived.length ? `, archived ${r.archived.join(", ")}` : ""}` +
      `${r.updated.length ? `, updated ${r.updated.join(", ")}` : ""}` +
      `${r.dryRun ? " (nothing written)" : `\n    commit ${r.files.map((f) => f.replace(process.cwd() + "/", "")).join(" ")} in one PR`}`);
  }
} catch (e) {
  die(e.message, e.code === "EBOARDCONFLICT" || e.code === "EBOARDLOCK" ? 2 : 1);
}
