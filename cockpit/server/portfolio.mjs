/**
 * portfolio.mjs — multi-board read-across for the cockpit's portfolio mode (T-003).
 *
 * Given a registry (scripts/registry.mjs), reads every listed project's board in place —
 * canonical, the same way single-board mode reads its own — and computes the weekly-ready
 * survey across all of them. The registry IS the read allowlist: every path this module
 * reaches for is derived from a registry entry, never from request input.
 *
 * Read-only. Writing a portfolio board reuses the single-board PUT /api/board machinery
 * (shared lock, validation, compare-and-swap and atomic replacement) against a board dir
 * resolved from the registry. There is deliberately no second portfolio writer here.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { readRegistry, findKitDir } from "../../scripts/registry.mjs";
import { eligibleTickets } from "../../scripts/board-core.mjs";
import { readPlan } from "../../scripts/plan-io.mjs";
import { boardVersion, withBoardLock } from "../../scripts/board-io.mjs";

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
  const snapshot = boardDir ? readBoardSnapshot(boardDir, entry.name) : null;
  const data = snapshot?.data ?? null;
  if (!data) return { name: entry.name, path: entry.path, setUp: false };
  // Same shared content version as the single-board endpoint, so a client that loaded a
  // board from this listing can PUT it back with optimistic concurrency intact.
  return {
    name: entry.name,
    path: entry.path,
    boardDir,
    setUp: true,
    epics: snapshot.epics,
    tickets: snapshot.tickets,
    archived: snapshot.archived,
    archivedEpics: snapshot.archivedEpics,
    // The shared token (scripts/board-io.mjs), not a local stat: a version computed a
    // second way is a second concurrency rule, and a client that loads a board here and
    // PUTs it back would compare tokens the two paths could disagree about.
    version: snapshot.version,
    // The project's own plan, so "ready" here means the same thing it means on that project's
    // board. Without it the portfolio counts tickets the orchestrator will refuse — two views
    // of one board disagreeing about what is runnable, which is worse than no count at all.
    // An unreadable plan reads as no plan: the gate goes off, never on.
    plan: (() => { try { return readPlan(join(boardDir, "plan.json")); } catch { return null; } })(),
  };
}

/**
 * Read the current public representation of one board. Both the single-project and
 * portfolio endpoints use this shape, including conflict responses after a failed CAS.
 * The caller controls the board directory; request input never reaches this function.
 *
 * @param {string} boardDir
 * @param {string | null} [project]
 */
export function readBoardSnapshot(boardDir, project = null) {
  const dataPath = join(boardDir, "data.json");
  // Compatibility: an uninitialised registry entry is not an exceptional lock failure.
  // Check before trying to create board/.board.lock, then check again under the lock because
  // a setup/cleanup can race this read.
  if (!existsSync(dataPath)) return null;

  const prelockBarrier = process.env.MAESTRO_COCKPIT_TEST_SNAPSHOT_PRELOCK_BARRIER;
  if (prelockBarrier) {
    // cockpit-nonboard-write: deterministic test synchronization file, never board state.
    writeFileSync(`${prelockBarrier}.ready`, dataPath);
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${prelockBarrier}.resume`)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting at Cockpit pre-lock snapshot test barrier.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  try {
    return withBoardLock(boardDir, () => {
      if (!existsSync(dataPath)) return null;
      const data = readJSON(dataPath, null);
      if (!data) return null;
      const archive = readJSON(join(boardDir, "archive.json"), { epics: [], tickets: [] });

      const barrier = process.env.MAESTRO_COCKPIT_TEST_SNAPSHOT_BARRIER;
      if (barrier) {
        // cockpit-nonboard-write: deterministic test synchronization file, never board state.
        writeFileSync(`${barrier}.ready`, dataPath);
        const deadline = Date.now() + 10_000;
        while (!existsSync(`${barrier}.resume`)) {
          if (Date.now() >= deadline) throw new Error("Timed out waiting at Cockpit snapshot test barrier.");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }

      return {
        data,
        archive,
        boardDir,
        project,
        epics: data.epics ?? [],
        tickets: data.tickets ?? [],
        archived: archive.tickets ?? [],
        archivedEpics: archive.epics ?? [],
        version: boardVersion(dataPath),
      };
    }, { op: `cockpit-snapshot${project ? `:${project}` : ""}` });
  } catch (e) {
    // The board directory itself can disappear after the precheck but before openSync creates
    // its lock. Preserve the same not-set-up result as if it was absent from the beginning.
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT" && !existsSync(dataPath)) return null;
    throw e;
  }
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
 * `eligibleTickets` rule the single-board validator uses for its eligibleCount, **including
 * the scope gate**, so a ticket listed here is exactly one the orchestrator would actually
 * start. `outOfScope` counts the ones held back by the plan.
 * @param {ReturnType<typeof loadPortfolio>} portfolio
 * @param {Date} [now]
 */
export function survey(portfolio, now) {
  const projects = readPortfolioBoards(portfolio).map((b) => {
    if (!b.setUp) return { name: b.name, setUp: false, total: 0, ready: [], byStatus: {} };
    const byStatus = {};
    for (const t of b.tickets) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    // Epics are passed too: initiative ownership is derived through a ticket's epic, and a
    // survey handed tickets alone would silently skip that half of the pick-time gate.
    const ready = eligibleTickets({ epics: b.epics, tickets: b.tickets }, b.archived, { plan: b.plan, archivedEpics: b.archivedEpics })
      .map((t) => ({ id: t.id, name: t.name, priority: t.priority, epicId: t.epicId, area: t.area }));
    // Reported separately rather than folded into `ready`: a project with five scope-blocked
    // tickets and a project with nothing to do are not the same situation, and only one of
    // them is fixed by /plan-update.
    const outOfScope = eligibleTickets({ epics: b.epics, tickets: b.tickets }, b.archived)
      .filter((t) => !ready.some((r) => r.id === t.id)).length;
    return { name: b.name, setUp: true, total: b.tickets.length, ready, outOfScope, byStatus };
  });
  return { week: isoWeek(now), projects };
}
