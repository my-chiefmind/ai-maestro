/**
 * Board filter reconciliation — plain, dependency-free ESM so the rules are executable outside
 * a browser and can be pinned by test/board-initiatives.test.mjs.
 *
 * These exist because two filters that can contradict each other are not merely confusing: the
 * board's "+ ticket" button defaults from them, so an impossible combination silently files
 * work somewhere other than the view implies, and the contradiction then hides it.
 */

/** Filter sentinel for "epics that belong to no initiative" — distinct from "no filter". */
export const NO_INITIATIVE = '_none';

/** The initiative a filter value names, or '' for "unassigned". null when no filter is set. */
function filtered(initiative) {
  if (!initiative) return null;
  return initiative === NO_INITIATIVE ? '' : initiative;
}

/**
 * The filter state after clicking an epic in the sidebar.
 *
 * Selecting an epic that the active initiative filter excludes RETUNES the initiative filter to
 * that epic's own, rather than leaving a pair that nothing can satisfy. The alternative — an
 * empty board and a "+ ticket" that files into the invisible epic — is the exact defect the
 * initiative-aware defaults were added to close.
 *
 * @template {{epic: string, initiative: string}} F
 * @param {F} f  current filters
 * @param {{id: string, initiativeId?: string} | undefined} epic  the epic clicked, if known
 * @param {string} epicId
 * @returns {F}
 */
export function reconcileEpicSelection(f, epic, epicId) {
  if (!epicId) return { ...f, epic: '' }; // "All epics" keeps whatever initiative is in force
  const own = epic?.initiativeId ?? '';
  const want = filtered(f.initiative);
  const conflicts = want !== null && want !== own;
  return { ...f, epic: epicId, initiative: conflicts ? (own || NO_INITIATIVE) : f.initiative };
}

/**
 * The epic a new ticket should land in, given the filters.
 *
 * An explicitly selected epic wins — but only because reconcileEpicSelection has already made
 * sure it cannot contradict the initiative filter. Otherwise the first epic *within the
 * filtered initiative*, never simply the board's first, which could file the ticket into an
 * initiative the user is not even looking at.
 *
 * @param {{epic: string, initiative: string}} f
 * @param {{id: string, initiativeId?: string}[]} epics
 * @returns {string} an epic id, or '' when there is no sensible default
 */
export function defaultEpicForNewTicket(f, epics) {
  if (f.epic) return f.epic;
  const want = filtered(f.initiative);
  const pool = want === null ? epics : epics.filter((e) => (e.initiativeId ?? '') === want);
  return pool[0]?.id ?? '';
}
