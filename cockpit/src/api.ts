import type { Board, BoardEpic, BoardTicket, ProjectConfig, Roster, DocSection, PortfolioToday, ReportInfo, PlanResponse, PlanCompleteness, Plan, UsageReport } from './types';

// ── Portfolio scope ─────────────────────────────────────────────────────────────
// Which registry project every call below addresses. Null (the default) means the single
// board this service was started for — exactly the pre-portfolio behavior. The App sets
// this when the user picks a project and remounts the tree, so every page refetches
// through the new scope without threading a parameter through each component.
let activeProject: string | null = null;
export function setActiveProject(name: string | null) { activeProject = name; }
export function getActiveProject(): string | null { return activeProject; }

// Query-string suffix for the active scope. `first` decides '?' vs '&'.
function scopeQS(first = true): string {
  if (!activeProject) return '';
  return `${first ? '?' : '&'}project=${encodeURIComponent(activeProject)}`;
}

// Thrown when a PUT is rejected because the board changed on disk since it was loaded.
// Carries the current on-disk board so the UI can reconcile without a second round-trip.
export class ConflictError extends Error {
  current: Board;
  constructor(message: string, current: Board) {
    super(message);
    this.name = 'ConflictError';
    this.current = current;
  }
}

export async function getBoard(): Promise<Board> {
  const r = await fetch(`/api/board${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `load failed (${r.status})`);
  }
  return r.json();
}

export async function getBoardVersion(): Promise<string> {
  const r = await fetch(`/api/board/version${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`version check failed (${r.status})`);
  return (await r.json()).version;
}

// Persists the board. Returns the new version on success; throws ConflictError on a stale
// write (409) and Error on validation failure (400) or other errors.
export async function putBoard(
  body: { epics: BoardEpic[]; tickets: BoardTicket[]; version?: string },
): Promise<string> {
  const r = await fetch(`/api/board${scopeQS()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (r.status === 409) throw new ConflictError(String(data.error || 'conflict'), data.current as Board);
  if (!r.ok) throw new Error(String(data.error || `save failed (${r.status})`));
  return String(data.version || '');
}

export async function getConfig(): Promise<ProjectConfig | null> {
  const r = await fetch(`/api/config${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

export async function getRoster(): Promise<Roster> {
  const r = await fetch(`/api/roster${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`roster load failed (${r.status})`);
  return r.json();
}

export async function getDocs(): Promise<{ sections: DocSection[] }> {
  const r = await fetch(`/api/docs${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`docs load failed (${r.status})`);
  return r.json();
}

export async function getDocHtml(path: string): Promise<string> {
  const r = await fetch(`/api/docs/render?path=${encodeURIComponent(path)}${scopeQS(false)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`doc render failed (${r.status})`);
  return (await r.json()).html;
}

export async function getSpec(id: string): Promise<string> {
  const r = await fetch(`/api/spec/${encodeURIComponent(id)}${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) return '';
  return (await r.json()).content ?? '';
}

export async function putSpec(id: string, content: string): Promise<void> {
  const r = await fetch(`/api/spec/${encodeURIComponent(id)}${scopeQS()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `spec save failed (${r.status})`);
  }
}

// ── Project plan (board/plan.json) ──────────────────────────────────────────────
// Edits are section-scoped: the tab sends one section's value, never the whole plan, so an
// agent writing a different section at the same moment isn't a conflict.

// Thrown when a plan write is rejected because the plan changed on disk since it was loaded.
export class PlanConflict extends Error {
  current: { plan: Plan; version: string; completeness: PlanCompleteness };
  constructor(message: string, current: { plan: Plan; version: string; completeness: PlanCompleteness }) {
    super(message);
    this.name = 'PlanConflict';
    this.current = current;
  }
}

export async function getPlan(): Promise<PlanResponse> {
  const r = await fetch(`/api/plan${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `plan load failed (${r.status})`);
  }
  return r.json();
}

/** Replace one section. Items with no `id` get one assigned server-side, inside the lock. */
export async function putPlanSection(
  key: string,
  value: unknown,
  version: string,
): Promise<PlanResponse> {
  const r = await fetch(`/api/plan/section/${encodeURIComponent(key)}${scopeQS()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value, version }),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (r.status === 409) throw new PlanConflict(String(data.error || 'conflict'), data.current as PlanConflict['current']);
  if (!r.ok) throw new Error(String(data.error || `plan save failed (${r.status})`));
  return data as unknown as PlanResponse;
}

/** Triage one gap: accept it (pointing at the item it became), decline it, or reclassify it. */
export async function putPlanGap(
  id: string,
  patch: { status?: string; need?: string; resolvedAs?: string },
  version: string,
): Promise<{ plan: Plan; version: string; completeness: PlanCompleteness }> {
  const r = await fetch(`/api/plan/gap/${encodeURIComponent(id)}${scopeQS()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...patch, version }),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (r.status === 409) throw new PlanConflict(String(data.error || 'conflict'), data.current as PlanConflict['current']);
  if (!r.ok) throw new Error(String(data.error || `gap update failed (${r.status})`));
  return data as unknown as { plan: Plan; version: string; completeness: PlanCompleteness };
}

// ── Portfolio ("today" survey) — 404 means portfolio mode isn't configured ──────
export async function getPortfolioToday(): Promise<PortfolioToday | null> {
  const r = await fetch('/api/portfolio/today', { cache: 'no-store' });
  if (r.status === 404) return null; // not configured: single-board mode
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `portfolio load failed (${r.status})`);
  }
  return r.json();
}

// ── Reports (board/reports/, generated files served read-only) ──────────────────
export async function getReports(): Promise<ReportInfo[]> {
  const r = await fetch(`/api/reports${scopeQS()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`reports load failed (${r.status})`);
  return (await r.json()).reports ?? [];
}

export async function getReportHtml(name: string): Promise<string> {
  const r = await fetch(`/api/reports/render?name=${encodeURIComponent(name)}${scopeQS(false)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`report render failed (${r.status})`);
  return (await r.json()).html;
}

// URL for an .html report, shown in a sandboxed iframe rather than fetched as JSON.
export function reportFileUrl(name: string): string {
  return `/api/reports/render?name=${encodeURIComponent(name)}${scopeQS(false)}`;
}

// The long-form docs/help.html guide. Same treatment as an .html report: a sandboxed iframe
// pointed at the route, never fetched and injected into our own document.
//
// `theme` is passed through the URL because the sandbox is opaque in both directions — we
// cannot reach into the frame to set it, and with `default-src 'none'` the document cannot run
// a script to ask. Without it the guide follows the OS rather than this console's toggle.
export function helpGuideUrl(theme?: 'light' | 'dark'): string {
  const scope = scopeQS();
  return `/api/help/guide${scope}${theme ? `${scope ? '&' : '?'}theme=${theme}` : ''}`;
}

// Whether this kit actually ships the guide — an older vendored maestro/ may not, and the Help
// tab should then show the cheat sheet alone rather than an empty frame.
export async function hasHelpGuide(): Promise<boolean> {
  try {
    return (await fetch(helpGuideUrl(), { method: 'HEAD', cache: 'no-store' })).ok;
  } catch {
    return false;
  }
}

// ── Ticket usage ────────────────────────────────────────────────────────────────
export async function getUsage(refresh = false): Promise<UsageReport> {
  const qs = scopeQS();
  const sep = qs ? '&' : '?';
  const r = await fetch(`/api/usage${qs}${refresh ? `${sep}refresh=1` : ''}`, { cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `usage load failed (${r.status})`);
  }
  return r.json();
}

// A plain URL rather than a fetch: the browser's own download machinery handles the
// Content-Disposition the server sets, so the export never has to be buffered in the tab.
export function usageExportUrl(format: 'json' | 'csv' | 'html', view = 'tickets'): string {
  const qs = scopeQS(false);
  return `/api/usage/export?format=${format}&view=${encodeURIComponent(view)}${qs}`;
}
