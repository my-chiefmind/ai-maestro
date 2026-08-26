export interface BoardEpic {
  id: string;
  name: string;
  desc?: string;
  collapsed?: boolean;
  traces_to?: string[];
  sample?: boolean;
}

// Core fields are typed; extras are tolerated so a board can carry custom keys.
export interface BoardTicket {
  id: string;
  epicId?: string;
  name: string;
  desc?: string;
  area?: string;
  priority?: string;
  swag?: string;
  status: string;
  depends_on?: string[];
  agent_plan?: string[];
  model?: string;
  dev_runtime?: string;
  dev_model?: string;
  reviewer_runtime?: string;
  reviewer_model?: string;
  execution_mode?: string;
  wave?: number;
  agent?: string;
  human_gate?: string;
  testCmd?: string;
  evidence?: string;
  traces_to?: string[];
  scope_exception?: string;
  sample?: boolean;
  [key: string]: unknown;
}

export interface Board {
  boardDir: string;
  epics: BoardEpic[];
  tickets: BoardTicket[];
  archived: BoardTicket[];
  archivedEpics: BoardEpic[];
  version?: string;
}

// Project config surfaced to drive the UI's pickers (areas, agent_plan steps, models).
export interface CrossReviewRole { runtime: string; model: string }
export interface ProjectConfig {
  name: string | null;
  areas: string[];
  planSteps: string[];
  models: string[];
  humanGates: string[];
  targets: string[];
  crossReview: { dev: CrossReviewRole; reviewer: CrossReviewRole } | null;
}

export interface RosterAgent { code: string; name: string; description: string }
export interface RosterSkill { name: string; description: string }
export interface Roster { agents: RosterAgent[]; skills: RosterSkill[] }

export interface DocFile { path: string; title: string }
export interface DocSection { key: string; label: string; files: DocFile[] }

// ── Portfolio mode ──────────────────────────────────────────────────────────────
export interface PortfolioReadyTicket {
  id: string;
  name: string;
  priority?: string;
  epicId?: string;
  area?: string;
}
export interface PortfolioProject {
  name: string;
  setUp: boolean;
  total: number;
  ready: PortfolioReadyTicket[];
  /** Ready by dependency but refused by the plan's scope gate. Never counted in `ready`. */
  outOfScope: number;
  byStatus: Record<string, number>;
}
export interface PortfolioToday { week: string; projects: PortfolioProject[] }

// ── Reports (generated files under board/reports/) ──────────────────────────────
export interface ReportInfo { name: string; mtime: number; size: number }

// ── Project plan (board/plan.json) ──────────────────────────────────────────────
// The shape is owned by scripts/plan-core.mjs; these types mirror what /api/plan returns.
export interface PlanItem {
  id: string;
  text: string;
  notes?: string;
  actor?: string;
  verify?: string;
  budget?: string;
  target?: string;
  mitigation?: string;
  // Gaps only
  need?: 'required' | 'optional';
  status?: 'open' | 'accepted' | 'declined';
  from?: string;
  resolvedAs?: string;
}

export interface PlanGoal { text: string; metrics: string[] }
export interface PlanScope { in: string[]; out: { id: string; text: string }[] }

export interface Plan {
  planVersion: number;
  sections: {
    goal: PlanGoal;
    scope: PlanScope;
    deliverables: PlanItem[];
    useCases: PlanItem[];
    functional: PlanItem[];
    nonFunctional: PlanItem[];
    milestones: PlanItem[];
    risks: PlanItem[];
    gaps: PlanItem[];
    openQuestions: PlanItem[];
    [key: string]: unknown;
  };
}

export type PlanSectionKey = keyof Plan['sections'];

export interface PlanSectionMeta {
  key: string;
  label: string;
  kind: 'prose' | 'scope' | 'list' | 'gaps';
  prefix: string | null;
  weight: number;
  heading: string;
  blurb: string;
  ask: string | null;
  followUp: string | null;
  fields: string[];
  itemLabel: string | null;
}

export interface PlanSectionStatus {
  key: string;
  label: string;
  weight: number;
  filled: boolean;
  counts: boolean;
  count: number;
  detail: string;
}

export interface PlanCompleteness {
  percent: number;
  earned: number;
  possible: number;
  sections: PlanSectionStatus[];
  missing: string[];
  requiredGaps: PlanItem[];
  optionalGaps: PlanItem[];
}

export interface PlanCoverageRow {
  id: string;
  section: string;
  text: string;
  tickets: string[];
  done: boolean;
}

export interface PlanResponse {
  project: string | null;
  planPath: string;
  exists: boolean;
  version: string;
  plan: Plan;
  sections: PlanSectionMeta[];
  completeness: PlanCompleteness;
  coverage: PlanCoverageRow[];
  warnings: string[];
}
