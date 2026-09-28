#!/usr/bin/env node
// @ts-check
/**
 * `maestro usage commit` — fold the untracked pending spool (`board/.usage-pending.jsonl`,
 * written by the usage hooks and `maestro usage sync`) into the tracked `board/usage.jsonl`,
 * deduped by key, under the board lock, with an atomic replace; then empty the spool.
 * Run it on a branch before a PR so the records reach git through a normal commit.
 * Idempotent: with nothing pending it changes nothing.
 */
import { join, resolve } from "path";
import { commitUsage } from "./usage-ledger.mjs";

/** CLI: `maestro usage commit [--board <dir>] [--json]`. */
export function main(/** @type {string[]} */ argv) {
  /** @type {Record<string, any>} */ const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--board") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) { console.error("✗ --board needs a value."); return 2; }
      o.board = v;
    } else if (a === "--json" || a === "--help" || a === "-h") o[a.replace(/^-+/, "")] = true;
    else { console.error(`✗ Unknown option: ${a}`); return 2; }
  }
  if (o.help || o.h) {
    process.stdout.write(`
  maestro usage commit     fold pending usage (board/.usage-pending.jsonl, untracked) into
                           board/usage.jsonl, deduped, and empty the spool. Commit the result.

  Flags:
    --board <dir>                board directory (default: ./board)
    --json                       print the summary as JSON
`);
    return 0;
  }
  const boardDir = resolve(o.board || join(process.cwd(), "board"));
  let r;
  try { r = commitUsage(boardDir); } catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); return 1; }
  if (o.json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return 0; }
  console.log(r.committed
    ? `${r.committed} pending record(s) folded into board/usage.jsonl (${r.alreadyCommitted} already there). Commit board/usage.jsonl.`
    : `Nothing new to commit (${r.alreadyCommitted} pending record(s) were already in board/usage.jsonl).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) process.exit(main(process.argv.slice(2)));
