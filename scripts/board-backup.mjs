/**
 * board-backup.mjs — recovery copies of board files before they are replaced (T-034).
 *
 * The shared writers (board-io.mjs, plan-io.mjs) and `maestro setup` call `backupFile` just
 * before an atomic rename, so every mutation of data.json, archive.json, plan.json or plan.md
 * leaves the previous bytes in `<boardDir>/.backups/`. Retention is bounded per basename so the
 * directory cannot grow without limit.
 *
 * `backupFile` throws on failure; callers decide whether that is fatal. The writers treat it as
 * a warning (see `tryBackup`): losing a recovery copy must never block a valid write.
 *
 * No third-party dependencies.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { join, dirname, basename, extname } from "path";

/** How many backups to keep per file basename (e.g. per `data.json`). */
export const BACKUP_KEEP = 20;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Copy `target` to `<boardDir>/.backups/<name>.<ISO-stamp><ext>` and prune that basename's
 * backups to the newest `keep`. Returns the backup path, or null when `target` does not exist.
 */
export function backupFile(target, { boardDir = dirname(target), keep = BACKUP_KEEP } = {}) {
  if (!existsSync(target)) return null;
  const dir = join(boardDir, ".backups");
  mkdirSync(dir, { recursive: true });
  const ext = extname(target);
  const name = basename(target, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Two writes in the same millisecond must not overwrite each other's backup.
  let dest = join(dir, `${name}.${stamp}${ext}`);
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${name}.${stamp}-${n}${ext}`);
  copyFileSync(target, dest);

  // ISO stamps sort lexically in time order; the `-n` collision suffix sorts after its base.
  const pattern = new RegExp(`^${escapeRe(name)}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z(-\\d+)?${escapeRe(ext)}$`);
  const mine = readdirSync(dir).filter((f) => pattern.test(f)).sort(byStamp);
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    try { unlinkSync(join(dir, old)); } catch { /* already gone */ }
  }
  return dest;
}

function byStamp(a, b) {
  // "<name>.<stamp>Z[-n]<ext>" -> [stamp, n]
  const key = (f) => { const z = f.lastIndexOf("Z"); return [f.slice(0, z), Number(f.slice(z + 1).match(/^-(\d+)/)?.[1] ?? 0)]; };
  const [sa, na] = key(a); const [sb, nb] = key(b);
  return sa < sb ? -1 : sa > sb ? 1 : na - nb;
}

/**
 * Back up each target; on failure warn on stderr and return the error message instead of
 * throwing. Returns undefined when every backup succeeded.
 */
export function tryBackup(targets, { boardDir, keep } = {}) {
  const errors = [];
  for (const t of targets) {
    try { backupFile(t, { boardDir, keep }); }
    catch (e) { errors.push(`${basename(t)}: ${e.message}`); }
  }
  if (!errors.length) return undefined;
  const msg = `backup failed (${errors.join("; ")})`;
  process.stderr.write(`maestro: warning: ${msg} — the write itself went ahead.\n`);
  return msg;
}
