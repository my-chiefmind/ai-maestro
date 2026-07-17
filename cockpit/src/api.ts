import type { Board, BoardEpic, BoardTicket, ProjectConfig, Roster, DocSection } from './types';

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
  const r = await fetch('/api/board', { cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `load failed (${r.status})`);
  }
  return r.json();
}

export async function getBoardVersion(): Promise<string> {
  const r = await fetch('/api/board/version', { cache: 'no-store' });
  if (!r.ok) throw new Error(`version check failed (${r.status})`);
  return (await r.json()).version;
}

// Persists the board. Returns the new version on success; throws ConflictError on a stale
// write (409) and Error on validation failure (400) or other errors.
export async function putBoard(
  body: { epics: BoardEpic[]; tickets: BoardTicket[]; version?: string },
): Promise<string> {
  const r = await fetch('/api/board', {
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
  const r = await fetch('/api/config', { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

export async function getRoster(): Promise<Roster> {
  const r = await fetch('/api/roster', { cache: 'no-store' });
  if (!r.ok) throw new Error(`roster load failed (${r.status})`);
  return r.json();
}

export async function getDocs(): Promise<{ sections: DocSection[] }> {
  const r = await fetch('/api/docs', { cache: 'no-store' });
  if (!r.ok) throw new Error(`docs load failed (${r.status})`);
  return r.json();
}

export async function getDocHtml(path: string): Promise<string> {
  const r = await fetch(`/api/docs/render?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`doc render failed (${r.status})`);
  return (await r.json()).html;
}

export async function getSpec(id: string): Promise<string> {
  const r = await fetch(`/api/spec/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!r.ok) return '';
  return (await r.json()).content ?? '';
}

export async function putSpec(id: string, content: string): Promise<void> {
  const r = await fetch(`/api/spec/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `spec save failed (${r.status})`);
  }
}
