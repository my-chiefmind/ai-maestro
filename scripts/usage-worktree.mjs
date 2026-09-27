// @ts-check
/**
 * Git worktree awareness for usage recording.
 *
 * A Claude Code session started in a linked worktree (`git worktree add ...`) has
 * $CLAUDE_PROJECT_DIR = the worktree, so the hook's `--board $CLAUDE_PROJECT_DIR/board` points
 * at the worktree's COPY of the board, which is thrown away with the worktree. These helpers
 * map such a board back to the same path in the MAIN checkout of the same repository, and list
 * the repo's linked worktrees so their sessions count as owned by the main board.
 *
 * Ownership is unchanged otherwise: only directories git itself reports as worktrees of THIS
 * repository are added — an unrelated checkout under /tmp stays excluded.
 *
 * Every git call is bounded (GIT_TIMEOUT_MS) and failures fall back to "not a worktree".
 */
import { spawnSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";

export const GIT_TIMEOUT_MS = 1500;

/** @param {string} cwd @param {string[]} args @returns {string | null} */
function git(cwd, args) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  } catch { return null; }
}

/** @param {string} p */
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * Describe the checkout containing `dir`.
 * @param {string} dir
 * @returns {{ top: string, main: string, linked: boolean } | null}
 */
export function checkoutOf(dir) {
  if (!existsSync(dir)) return null;
  const out = git(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!out) return null;
  const [top, common] = out.split("\n").map((s) => s.trim());
  if (!top || !common) return null;
  const commonAbs = real(isAbsolute(common) ? common : resolve(dir, common));
  // A non-bare repo's common dir is <main>/.git; anything else (bare repo, odd layout) is not mapped.
  if (basename(commonAbs) !== ".git") return null;
  const main = dirname(commonAbs), topReal = real(top);
  return { top: topReal, main, linked: topReal !== main };
}

/**
 * Map a board inside a linked worktree to the same board in the main checkout.
 * Returns the original board when it is not in a linked worktree or the main copy is missing.
 * @param {string} boardDir
 * @returns {{ boardDir: string, worktreeRoot: string | null }}
 */
export function resolveMainBoard(boardDir) {
  const abs = resolve(boardDir);
  const co = checkoutOf(existsSync(abs) ? abs : dirname(abs));
  if (!co || !co.linked) return { boardDir: abs, worktreeRoot: null };
  const rel = relative(co.top, real(abs));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { boardDir: abs, worktreeRoot: null };
  const mainBoard = join(co.main, rel);
  if (!existsSync(mainBoard)) return { boardDir: abs, worktreeRoot: null };
  return { boardDir: mainBoard, worktreeRoot: co.top };
}

/**
 * The linked worktrees (not the main checkout) of the repository containing `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
export function linkedWorktreeRoots(dir) {
  const co = checkoutOf(dir);
  if (!co) return [];
  const out = git(co.main, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const roots = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice(9).trim();
    if (!p || real(p) === co.main) continue;
    roots.push(p);
    // macOS: /tmp is /private/tmp — a session cwd may carry either spelling.
    if (real(p) !== p) roots.push(real(p));
  }
  return roots;
}
