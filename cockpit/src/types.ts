export interface BoardEpic {
  id: string;
  name: string;
  /**
   * The plan initiative this epic delivers. Absent on a legacy board and while an epic is
   * between assignments. A ticket has no initiative field of its own — it derives one through
   * its epic, so this is the only place the link is stored.
   */
  initiativeId?: string;
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
  /**
   * The initiative that owns this item, or absent for a project-wide item that applies to every
   * one. Legal on deliverables, useCases, functional, nonFunctional, milestones and risks only —
   * OWNED_SECTIONS in scripts/plan-core.mjs. Gaps and open questions stay project-level.
   */
  initiativeId?: string;
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

/**
 * A scoped mini-plan: an independently valuable outcome delivered by several epics. It OWNS
 * plan items rather than nesting copies of them, so ids stay globally unique. Initiatives are
 * never traceable themselves — a ticket traces to a requirement and derives its initiative
 * through its epic.
 */
export interface PlanInitiative {
  id: string;
  name: string;
  outcome: string;
  scope: { in: string[]; out: string[] };
  metrics: string[];
  /** Planning metadata only — never read by ticket eligibility or lane assignment. */
  depends_on: string[];
  notes?: string;
}

/** Delivery derived from the board, never declared. `percent` is done ÷ total, rounded. */
export interface InitiativeProgress {
  id: string | null;
  name: string;
  total: number;
  covered: number;
  done: number;
  uncovered: string[];
  incomplete: string[];
  milestones: string[];
  percent: number;
}
export interface PlanScope { in: string[]; out: { id: string; text: string }[] }

export interface Plan {
  planVersion: number;
  sections: {
    goal: PlanGoal;
    scope: PlanScope;
    initiatives: PlanInitiative[];
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
  kind: 'prose' | 'scope' | 'list' | 'gaps' | 'initiatives';
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
  /** null for a project-wide item. */
  initiativeId?: string | null;
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
  /** Empty unless the plan defines initiatives — the cockpit hides the whole layer when it is. */
  initiatives: InitiativeProgress[];
  projectWide: InitiativeProgress;
  warnings: string[];
}

// ── Ticket usage (Value page) ───────────────────────────────────────────────────
// Mirrors what scripts/usage-core.mjs emits. The kit is the source of truth for these
// shapes; this is the UI's read-only view of them.
export interface UsageTokens {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  thinking: number; total: number;
}
export interface UsageMetrics {
  tokens: UsageTokens;
  turns: number; runs: number;
  estimatedActiveMs: number; exactMs: number; spanMs: number;
  firstTs: number | null; lastTs: number | null;
}
export interface UsageBucket extends UsageMetrics { key: string }
/** How a ticket's figures were obtained. `exact` came from run telemetry, `estimated` from
 *  transcript attribution, `mixed` from both — never averaged into one unlabelled number. */
export type UsageTiming = 'exact' | 'estimated' | 'mixed';
export type UsageConfidence = 'exact' | 'high' | 'medium' | 'unassigned';
export interface UsageTicket {
  id: string; onBoard: boolean; name: string; status: string; area: string;
  epicId: string; epicName: string; boardModel: string; agentPlan: string[];
  executionMode: string; swag: string; priority: string; archived: boolean;
  doneAt: string | null;
  metrics: UsageMetrics;
  confidence: UsageConfidence;
  /** Why this ticket's turns were attributed to it — 'branch', 'board-write:set-status', … */
  evidence: string[];
  timing: UsageTiming;
  /** First measured stage start to last measured stage end. Null when nothing was measured. */
  cycleMs: number | null;
  breakdown: Record<string, UsageBucket[]>;
}
export interface UsageReport {
  generatedAt: string; schema: number; project: string; boardDir: string; roots: string[];
  dateRange: { from: string | null; to: string | null };
  enabled: { transcripts: boolean; telemetry: boolean };
  coverage: {
    turns: number; attributed: number;
    byConfidence: Record<string, number>;
    unassignedReasons: Record<string, number>;
    skippedExact: number;
    ticketsOnBoard: number; ticketsWithUsage: number;
    exactRuns: number; telemetrySkippedLines: number;
    transcriptFiles: number; transcriptSessions: number;
    unassignedTokens: number; unassignedTurns: number;
  };
  totals: UsageMetrics;
  unassigned: UsageMetrics;
  tickets: UsageTicket[];
  breakdown: Record<string, UsageBucket[]>;
}
