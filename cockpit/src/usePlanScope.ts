import { useEffect, useState } from 'react';
import type { Plan, PlanInitiative, PlanResponse } from './types';
import { getPlan } from './api';

/** A plan item a ticket may legally trace to. `OUT-` ids are offered too, clearly marked. */
export interface TraceOption {
  id: string;
  text: string;
  section: string;
  out: boolean;
  /** The initiative that owns this item, or null for a project-wide one. */
  initiativeId: string | null;
}

export interface ScopeVerdict {
  state: 'no-plan' | 'in-scope' | 'untraced' | 'unknown' | 'out' | 'exception'
    | 'unassigned-epic' | 'cross-initiative';
  blocks: boolean;
  reason: string;
}

/** The epic a ticket hangs off, as much of it as the verdict needs. */
export interface EpicRef { id: string; initiativeId?: string }

// Only these put something INSIDE the boundary. Mirrors TRACEABLE_PREFIXES in plan-core.mjs —
// a gap is by definition work the plan does not yet cover, so tracing at one must not clear
// the gate.
const TRACEABLE = ['D', 'UC', 'FR', 'NFR', 'M'];
const SECTION_LABEL: Record<string, string> = {
  deliverables: 'Deliverable', useCases: 'Use case', functional: 'Requirement',
  nonFunctional: 'Quality attribute', milestones: 'Milestone', scopeOut: 'Out of scope',
};

/**
 * The plan, as the board console needs it: the ids a ticket may trace to, and a local verdict
 * so the drawer can tell you a ticket won't run *before* you save it.
 *
 * The verdict logic is duplicated from scripts/plan-core.mjs on purpose — it is a preview, not
 * the decision. The authority stays server-side (the validator warns, the orchestrator blocks);
 * this only spares the user a save-and-see round trip.
 */
export function usePlanScope(scopeKey?: string) {
  const [data, setData] = useState<PlanResponse | null>(null);
  useEffect(() => { getPlan().then(setData).catch(() => setData(null)); }, [scopeKey]);

  const options: TraceOption[] = [];
  if (data) {
    const s = data.plan.sections;
    const push = (key: string, items: { id: string; text: string; initiativeId?: string }[]) => {
      for (const i of items) {
        options.push({ id: i.id, text: i.text, section: key, out: false, initiativeId: i.initiativeId ?? null });
      }
    };
    push('deliverables', s.deliverables);
    push('useCases', s.useCases);
    push('functional', s.functional);
    push('nonFunctional', s.nonFunctional);
    push('milestones', s.milestones);
    for (const o of s.scope.out) options.push({ id: o.id, text: o.text, section: 'scopeOut', out: true, initiativeId: null });
  }

  const byId = new Map(options.map((o) => [o.id, o]));
  // The gate is off until the plan names real work — matches planIsGating().
  const gating = options.some((o) => !o.out && ['D', 'UC', 'FR'].includes(prefixOf(o.id)));

  const initiatives: PlanInitiative[] = data?.plan?.sections?.initiatives ?? [];
  const initiativeMode = initiatives.length > 0;
  const initiativeName = (id: string | null | undefined) =>
    (id ? initiatives.find((i) => i.id === id)?.name : undefined) ?? id ?? '';

  /**
   * Plan items this epic's tickets may NOT trace to, because another initiative owns them.
   * A project-wide item (initiativeId null) is available to everyone.
   *
   * Mirrors ownershipVerdict in scripts/board-core.mjs. Like the scope verdict above this is a
   * PREVIEW, not the decision — the server refuses the save either way. It exists so the drawer
   * can say no before a round trip, and it has to agree with the server or it is worse than
   * nothing: a picker that offers an option the save then rejects teaches people to ignore it.
   */
  const foreignFor = (own: string | null | undefined): Set<string> => {
    const bad = new Set<string>();
    if (!initiativeMode) return bad;
    for (const o of options) {
      if (o.initiativeId && o.initiativeId !== (own ?? null)) bad.add(o.id);
    }
    return bad;
  };

  const verdict = (ticket: { traces_to?: string[]; scope_exception?: string }, epic?: EpicRef | null): ScopeVerdict => {
    if (!gating) return { state: 'no-plan', blocks: false, reason: 'No project plan yet — the scope gate is off.' };
    if (ticket.scope_exception?.trim()) {
      return { state: 'exception', blocks: false, reason: `Runs on a scope exception: ${ticket.scope_exception.trim()}` };
    }
    const ids = ticket.traces_to ?? [];
    if (!ids.length) return { state: 'untraced', blocks: true, reason: 'Traces to nothing in the plan — the orchestrator will not pick it.' };
    const out = ids.filter((id) => byId.get(id)?.out);
    if (out.length) return { state: 'out', blocks: true, reason: `Traces to ${out.join(', ')}, which the plan lists as out of scope.` };
    const resolved = ids.filter((id) => TRACEABLE.includes(prefixOf(id)) && byId.has(id));
    if (!resolved.length) return { state: 'unknown', blocks: true, reason: `Traces only to ${ids.join(', ')}, which the plan does not define as in-scope work.` };
    const dangling = ids.filter((id) => !byId.has(id));

    // Ownership is checked AFTER scope and is deliberately not cleared by a scope exception:
    // an exception is a decision about project scope, not a licence to wire a ticket to another
    // initiative's requirement. Server-side this is the same split (board-core.mjs).
    if (initiativeMode && epic !== undefined) {
      const own = epic?.initiativeId ?? null;
      if (epic && !own) {
        return {
          state: 'unassigned-epic',
          blocks: true,
          reason: `Epic ${epic.id} belongs to no initiative, so this ticket has none either — the orchestrator will not pick it. Assign the epic from Epics ▸ Manage.`,
        };
      }
      const foreign = ids.filter((id) => {
        const owner = byId.get(id)?.initiativeId ?? null;
        return owner !== null && owner !== own;
      });
      if (foreign.length) {
        const owners = foreign.map((id) => `${id} (${initiativeName(byId.get(id)?.initiativeId)})`).join(', ');
        return {
          state: 'cross-initiative',
          blocks: true,
          reason: own
            ? `This ticket is in ${initiativeName(own)} through its epic, but traces to ${owners}. Move it, or trace to one of ${initiativeName(own)}'s items or a project-wide one.`
            : `With no epic this ticket derives no initiative and may trace only to project-wide items, but it traces to ${owners}.`,
        };
      }
    }

    return {
      state: 'in-scope',
      blocks: false,
      reason: dangling.length
        ? `In scope via ${resolved.join(', ')}; ${dangling.join(', ')} is not a plan item.`
        : `In scope via ${resolved.join(', ')}.`,
    };
  };

  return {
    plan: data?.plan as Plan | undefined,
    options, byId, gating, verdict, label: sectionLabel,
    initiatives, initiativeMode, initiativeName, foreignFor,
  };
}

function prefixOf(id: string): string {
  return String(id).match(/^([A-Z]+)-\d+$/)?.[1] ?? '';
}

function sectionLabel(section: string): string {
  return SECTION_LABEL[section] ?? section;
}
