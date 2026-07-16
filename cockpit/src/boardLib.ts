import type { Board, BoardTicket } from './types';

// The canonical workflow order — also the editable status set.
export const BOARD_STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'blocked', 'done'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const MODELS = ['haiku', 'sonnet', 'opus'];

export const DONE_STATUSES = new Set(['done']);

// A todo ticket is "ready" when every dependency is done or no longer present.
export function isReady(ticket: BoardTicket, board: Board): boolean {
  if (ticket.status !== 'todo') return false;
  if (ticket.human_gate) return false; // gated tickets are never auto-eligible
  const done = new Set(
    [...board.archived, ...board.tickets].filter((t) => DONE_STATUSES.has(t.status)).map((t) => t.id),
  );
  const deps = ticket.depends_on || [];
  return deps.every((d) => done.has(d) || !board.tickets.find((t) => t.id === d));
}

// A ticket carries a human gate when human_gate is set.
export const isGated = (t: BoardTicket) => Boolean(t.human_gate);

export function epicName(board: Board, epicId?: string): string {
  if (!epicId) return '';
  return [...board.epics, ...board.archivedEpics].find((e) => e.id === epicId)?.name || epicId;
}

// The pipeline label for a ticket card (agent_plan joined, or the agent display label).
export function planLabel(t: BoardTicket): string {
  if (Array.isArray(t.agent_plan) && t.agent_plan.length) return t.agent_plan.join(' › ');
  return String(t.agent || '');
}
