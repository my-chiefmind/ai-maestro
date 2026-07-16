import type { Board, BoardEpic, BoardTicket } from './types';

export async function getBoard(): Promise<Board> {
  const r = await fetch('/api/board', { cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `load failed (${r.status})`);
  }
  return r.json();
}

export async function putBoard(board: { epics: BoardEpic[]; tickets: BoardTicket[] }): Promise<void> {
  const r = await fetch('/api/board', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(board),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `save failed (${r.status})`);
  }
}
