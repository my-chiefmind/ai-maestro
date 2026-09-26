import type { Board, BoardEpic, BoardTicket, ProjectConfig } from './types';

// The canonical workflow order — also the editable status set.
export const BOARD_STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'blocked', 'done'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const MODELS = ['haiku', 'sonnet', 'opus'];

// Fallback pipeline steps when there's no config.json to read the real roster from.
export const DEFAULT_PLAN_STEPS = ['pe', 'backend', 'frontend', 'devops', 'qa', 'pd', 'merge'];

// The plan steps to offer in the picker, in canonical pipeline order.
export function planStepsFor(config: ProjectConfig | null): string[] {
  const steps = config?.planSteps?.length ? config.planSteps : DEFAULT_PLAN_STEPS;
  // Keep a stable, meaningful order (pe → dev → qa/pd → merge) regardless of config order.
  return [...steps].sort((a, b) => DEFAULT_PLAN_STEPS.indexOf(a) - DEFAULT_PLAN_STEPS.indexOf(b));
}

// Next unused ticket id, preserving the board's existing prefix (default "T-").
export function nextTicketId(board: Board): string {
  const ids = [...board.tickets, ...board.archived].map((t) => t.id);
  const m = ids.map((id) => /^([A-Za-z]+-)(\d+)$/.exec(id)).filter(Boolean) as RegExpExecArray[];
  const prefix = m[0]?.[1] || 'T-';
  const max = m.filter((x) => x[1] === prefix).reduce((n, x) => Math.max(n, Number(x[2])), 0);
  const width = Math.max(3, ...m.filter((x) => x[1] === prefix).map((x) => x[2].length));
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

// Next unused epic id of the form e<n>.
export function nextEpicId(board: Board): string {
  const nums = [...board.epics, ...board.archivedEpics]
    .map((e) => /^e(\d+)$/.exec(e.id)).filter(Boolean).map((x) => Number((x as RegExpExecArray)[1]));
  return `e${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

// Every ticket id on the board (live + archived) — for the depends_on picker.
export function allTicketRefs(board: Board): { id: string; name: string }[] {
  return [...board.tickets, ...board.archived].map((t) => ({ id: t.id, name: t.name || '' }));
}

export type { BoardEpic };

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
