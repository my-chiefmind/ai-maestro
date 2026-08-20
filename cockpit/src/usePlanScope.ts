import { useEffect, useState } from 'react';
import type { Plan, PlanResponse } from './types';
import { getPlan } from './api';

/** A plan item a ticket may legally trace to. `OUT-` ids are offered too, clearly marked. */
export interface TraceOption {
  id: string;
  text: string;
  section: string;
  out: boolean;
}

export interface ScopeVerdict {
  state: 'no-plan' | 'in-scope' | 'untraced' | 'unknown' | 'out' | 'exception';
  blocks: boolean;
  reason: string;
}

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
    const push = (key: string, items: { id: string; text: string }[]) => {
      for (const i of items) options.push({ id: i.id, text: i.text, section: key, out: false });
    };
    push('deliverables', s.deliverables);
    push('useCases', s.useCases);
    push('functional', s.functional);
    push('nonFunctional', s.nonFunctional);
    push('milestones', s.milestones);
    for (const o of s.scope.out) options.push({ id: o.id, text: o.text, section: 'scopeOut', out: true });
  }

  const byId = new Map(options.map((o) => [o.id, o]));
  // The gate is off until the plan names real work — matches planIsGating().
  const gating = options.some((o) => !o.out && ['D', 'UC', 'FR'].includes(prefixOf(o.id)));

  const verdict = (ticket: { traces_to?: string[]; scope_exception?: string }): ScopeVerdict => {
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
    return {
      state: 'in-scope',
      blocks: false,
      reason: dangling.length
        ? `In scope via ${resolved.join(', ')}; ${dangling.join(', ')} is not a plan item.`
        : `In scope via ${resolved.join(', ')}.`,
    };
  };

  return { plan: data?.plan as Plan | undefined, options, byId, gating, verdict, label: sectionLabel };
}

function prefixOf(id: string): string {
  return String(id).match(/^([A-Z]+)-\d+$/)?.[1] ?? '';
}

function sectionLabel(section: string): string {
  return SECTION_LABEL[section] ?? section;
}
