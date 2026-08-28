import { useEffect, useState } from 'react';
import type { BoardEpic, Plan, PlanInitiative, PlanResponse } from './types';
import { getPlan } from './api';
// The REAL rules, not a copy. Both modules are pure, dependency-free ESM with no node
// builtins, so the browser runs the same code the CLI and the server do.
import { scopeVerdict as coreScopeVerdict } from '../../scripts/plan-core.mjs';
import { ownershipVerdict as coreOwnershipVerdict, initiativeModeActive } from '../../scripts/board-core.mjs';

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
  /** The union of scopeVerdict's and ownershipVerdict's states in scripts/. */
  state: 'no-plan' | 'in-scope' | 'untraced' | 'unknown' | 'out' | 'exception'
    | 'off' | 'unresolved' | 'ok' | 'unassigned-epic' | 'unknown-initiative' | 'cross-initiative';
  blocks: boolean;
  reason: string;
}

/** The epics a ticket's initiative is derived through. Live and archived, as the server does. */
export interface EpicContext { epics: BoardEpic[]; archivedEpics?: BoardEpic[] }

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

  const initiatives: PlanInitiative[] = data?.plan?.sections?.initiatives ?? [];
  const initiativeMode = initiativeModeActive(data?.plan);
  const initiativeName = (id: string | null | undefined) =>
    (id ? initiatives.find((i) => i.id === id)?.name : undefined) ?? id ?? '';

  /**
   * Plan items this epic's tickets may NOT trace to, because another initiative owns them.
   * A project-wide item (owner null) is available to everyone.
   */
  const foreignFor = (own: string | null | undefined): Set<string> => {
    const bad = new Set<string>();
    if (!initiativeMode) return bad;
    for (const o of options) if (o.initiativeId && o.initiativeId !== (own ?? null)) bad.add(o.id);
    return bad;
  };

  /**
   * The verdict, computed by the SAME functions the orchestrator and the validator use —
   * scopeVerdict and ownershipVerdict from scripts/. This used to be a hand-written mirror,
   * and it drifted twice in ways typechecking could not see: a scope exception returned early
   * and skipped ownership entirely, and ownership went quiet whenever the ordinary scope gate
   * was off. Both bugs were possible only because the rule existed twice.
   *
   * It is still a PREVIEW — the server refuses the save either way — but it can no longer
   * disagree, because there is nothing left to disagree with.
   *
   * The two gates are independent and neither clears the other, exactly as eligibleTickets
   * applies them: a ticket runs only when scope AND ownership both pass. Scope is reported
   * first because "not in the plan at all" is the more fundamental answer.
   */
  const verdict = (
    ticket: { id?: string; epicId?: string; traces_to?: string[]; scope_exception?: string },
    epics?: EpicContext | null,
  ): ScopeVerdict => {
    const plan = data?.plan;
    if (!plan) return { state: 'no-plan', blocks: false, reason: 'No project plan yet — the scope gate is off.' };
    const scope = coreScopeVerdict(ticket, plan) as ScopeVerdict;
    const own = epics
      ? coreOwnershipVerdict(ticket, {
        plan,
        data: { epics: epics.epics, tickets: [] },
        archivedEpics: epics.archivedEpics ?? [],
      }) as ScopeVerdict
      : { state: 'unresolved' as const, blocks: false, reason: '' };
    if (scope.blocks) return scope;
    if (own.blocks) return own;
    return scope;
  };

  return {
    plan: data?.plan as Plan | undefined,
    options, byId, verdict, label: sectionLabel,
    initiatives, initiativeMode, initiativeName, foreignFor,
  };
}


function sectionLabel(section: string): string {
  return SECTION_LABEL[section] ?? section;
}
