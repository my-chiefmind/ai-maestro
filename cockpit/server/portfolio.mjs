/**
 * portfolio.mjs — multi-board read-across for the cockpit's portfolio mode (T-003).
 *
 * Given a registry (scripts/registry.mjs), reads every listed project's board in place —
 * canonical, the same way single-board mode reads its own — and computes the weekly-ready
 * survey across all of them. The registry IS the read allowlist: every path this module
 * reaches for is derived from a registry entry, never from request input.
 *
 * Read-only. Writing a portfolio board reuses the single-board PUT /api/board machinery
 * (validation, backups, optimistic concurrency) against a board dir resolved from the
 * registry — not yet wired in here; see board/specs/T-003.md for what's still open.
 */
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { readRegistry, findKitDir } from "../../scripts/registry.mjs";
import { eligibleTickets } from "../../scripts/board-core.mjs";

function readJSON(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Load the registry, resolving each entry's kit dir. Returns null when no registry file is
 * present at all — portfolio mode is opt-in; single-board mode is the default (T-003 AC2).
 * A registry that IS present but malformed throws (via readRegistry) rather than reading as
 * an empty portfolio — the same "loud, not silent" rule root cockpit's boards.mjs applies to
 * projects.json (T-003 §1).
 * @param {string} registryPath
 */
export function loadPortfolio(registryPath) {
  if (!existsSync(registryPath)) return null;
  const { projects } = readRegistry(registryPath);
  return projects.map((p) => ({ ...p, kitDir: findKitDir(p.path) }));
}

/**
 * One registry entry's board, read in place. The same shape /api/board returns for a single
 * project, plus `name`/`path` so a multi-board response can tell entries apart, and `setUp`
 * for a project the registry lists but that was never `maestro setup`.
 * @param {{ name: string, path: string, kitDir: string | null }} entry
 */
export function readPortfolioBoard(entry) {
  const boardDir = entry.kitDir ? join(entry.kitDir, "board") : null;
  const data = boardDir ? readJSON(join(boardDir, "data.json"), null) : null;
  if (!data) return { name: entry.name, path: entry.path, setUp: false };
  const archive = readJSON(join(boardDir, "archive.json"), { epics: [], tickets: [] });
  // Same mtime+size formula as the single-board endpoint, so a client that loaded a board
  // from this listing can PUT it back with optimistic concurrency intact.
  const s = statSync(join(boardDir, "data.json"));
  return {
    name: entry.name,
    path: entry.path,
    boardDir,
    setUp: true,
    epics: data.epics ?? [],
    tickets: data.tickets ?? [],
    archived: archive.tickets ?? [],
    archivedEpics: archive.epics ?? [],
    version: `${Math.round(s.mtimeMs)}-${s.size}`,
  };
}

/** @param {ReturnType<typeof loadPortfolio>} portfolio */
export function readPortfolioBoards(portfolio) {
  return portfolio.map(readPortfolioBoard);
}

// ── Survey ("today"): ready-to-run tickets across every board, isoWeek-stamped ────────────
/** @param {Date} [date] */
export function isoWeek(date = new Date()) {
  const t = new Date(Date.UTC(date.getFullYear(), 0, 1));
  const day = Math.floor((date - t) / 86400000);
  const w = Math.ceil((day + t.getUTCDay() + 1) / 7);
  return `${date.getFullYear()}-W${String(w).padStart(2, "0")}`;
}

/**
 * "What's ready to run this week", across every board in the portfolio. Ready = the same
 * `eligibleTickets` rule the single-board validator uses for its eligibleCount, so a ticket
 * that's eligible on its own board's `npm run validate` is exactly the one that shows up here.
 * @param {ReturnType<typeof loadPortfolio>} portfolio
 * @param {Date} [now]
 */
export function survey(portfolio, now) {
  const projects = readPortfolioBoards(portfolio).map((b) => {
    if (!b.setUp) return { name: b.name, setUp: false, total: 0, ready: [], byStatus: {} };
    const byStatus = {};
    for (const t of b.tickets) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const ready = eligibleTickets({ tickets: b.tickets }, b.archived)
      .map((t) => ({ id: t.id, name: t.name, priority: t.priority, epicId: t.epicId, area: t.area }));
    return { name: b.name, setUp: true, total: b.tickets.length, ready, byStatus };
  });
  return { week: isoWeek(now), projects };
}
