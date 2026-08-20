/**
 * plan-core.mjs — the project plan: its shape, its completeness, and the scope gate.
 *
 * `board/plan.json` is the source of truth for WHAT the project is for; `board/data.json` is
 * the source of truth for the work in flight. The plan exists so three questions have real
 * answers instead of opinions:
 *
 *   1. "Is this ticket in scope?"      — scopeVerdict(), enforced at orchestrator pick time.
 *   2. "How complete is the plan?"     — planCompleteness(), the number /plan-update drives down.
 *   3. "What is this ticket even for?" — a ticket's `traces_to` points at a plan item id.
 *
 * `board/plan.md` is rendered FROM this file on every write (renderPlanMd) and is never read
 * back. One source of truth, one readable mirror: a hand edit to the mirror is lost on the
 * next write, which is honest, whereas parsing prose back into structure fails silently and
 * takes the scope gate down with it.
 *
 * No third-party dependencies.
 */

/**
 * The section registry — the single place a section is defined. The CLI's questionnaire, the
 * completeness maths, the Markdown mirror, and the cockpit's Plan tab all read this, so a new
 * section is one entry here rather than five edits that drift apart.
 *
 * `kind` drives everything mechanical:
 *   prose — one text blob plus a bullet list (`goal`)
 *   scope — the in/out pair, the only section the gate reads directly
 *   list  — id'd items; `fields` names the per-item text fields beyond `text`
 *   gaps  — id'd items with need/status, fed by reporting skills
 *
 * `weight` is that section's share of the completeness percentage. `weight: 0` means the
 * section is genuinely optional and never drags the number down — open questions and gaps
 * are records, not obligations. (Open REQUIRED gaps are scored separately; see
 * planCompleteness.)
 */
export const PLAN_SECTIONS = [
  {
    key: "goal",
    label: "Goal",
    kind: "prose",
    prefix: null,
    weight: 3,
    heading: "Goal",
    blurb: "What success means for the whole project, and how you would know.",
    ask: "In one or two sentences: what does this project make true that isn't true today?",
    followUp: "Add a measurable signal that the goal was met (a metric, a threshold, an observable change).",
  },
  {
    key: "scope",
    label: "Scope",
    kind: "scope",
    prefix: null,
    weight: 3,
    heading: "Scope",
    blurb: "The boundary. Everything the orchestrator refuses to run lives on the wrong side of it.",
    ask: "What is in scope for this project?",
    followUp: "What is explicitly OUT of scope — the things someone will reasonably ask for that this project will not do?",
  },
  {
    key: "deliverables",
    itemLabel: "Deliverable",
    label: "Deliverables",
    kind: "list",
    prefix: "D",
    weight: 2,
    fields: [],
    heading: "Deliverables",
    blurb: "The artifacts that must exist at the end. Nouns, not activities.",
    ask: "What must exist when this is done — services, apps, pipelines, documents?",
  },
  {
    key: "useCases",
    itemLabel: "Use case",
    label: "Use cases",
    kind: "list",
    prefix: "UC",
    weight: 2,
    fields: ["actor"],
    heading: "Use cases",
    blurb: "The journeys the product has to support, from the user's side.",
    ask: "Walk through what someone actually does with this. Who are they, and what are they trying to get done?",
  },
  {
    key: "functional",
    itemLabel: "Requirement",
    label: "Functional requirements",
    kind: "list",
    prefix: "FR",
    weight: 3,
    fields: ["verify"],
    heading: "Functional requirements",
    blurb: "Behaviours the system must have. One per entry — an entry containing \"and\" is usually two.",
    ask: "What must the system DO? One behaviour at a time.",
    followUp: "For each one: how is it demonstrated — a test command, a manual check, a metric?",
  },
  {
    key: "nonFunctional",
    itemLabel: "Quality attribute",
    label: "Non-functional requirements",
    kind: "list",
    prefix: "NFR",
    weight: 2,
    fields: ["budget", "verify"],
    heading: "Non-functional requirements",
    blurb: "Quality attributes with measurable bars: performance, security, availability, accessibility, compliance, operability.",
    ask: "What quality bars must it hold — speed, uptime, security posture, accessibility, compliance, cost?",
    followUp: "Give each a number or a named standard. An NFR with no budget can't be gated on.",
  },
  {
    key: "milestones",
    itemLabel: "Milestone",
    label: "Milestones",
    kind: "list",
    prefix: "M",
    weight: 1,
    fields: ["target"],
    heading: "Milestones",
    blurb: "Meaningful checkpoints above the dependency graph.",
    ask: "Are there checkpoints or releases worth naming — a first demo, a beta, a cutover?",
  },
  {
    key: "risks",
    itemLabel: "Risk",
    label: "Risks & assumptions",
    kind: "list",
    prefix: "R",
    weight: 1,
    fields: ["mitigation"],
    heading: "Risks & assumptions",
    blurb: "What could sink this, and what you are taking on faith.",
    ask: "What could derail this, and what are you assuming is true without having checked?",
  },
  {
    key: "gaps",
    label: "Gaps",
    kind: "gaps",
    prefix: "G",
    weight: 0,
    heading: "Gaps raised against this plan",
    blurb: "Raised by reporting skills. Required gaps count against completeness until accepted or declined.",
    ask: null, // never asked in the questionnaire — gaps arrive from skills, and are triaged
  },
  {
    key: "openQuestions",
    itemLabel: "Question",
    label: "Open questions",
    kind: "list",
    prefix: "Q",
    weight: 0,
    fields: [],
    heading: "Open questions",
    blurb: "Decisions still owed by a human. Never planned around — resolved first.",
    ask: "Anything still undecided that someone needs to answer?",
  },
];

export const SECTION_BY_KEY = new Map(PLAN_SECTIONS.map((s) => [s.key, s]));
export const SECTION_KEYS = PLAN_SECTIONS.map((s) => s.key);

/** Sections a human is asked about, in questionnaire order. */
export const QUESTION_SECTIONS = PLAN_SECTIONS.filter((s) => s.ask);

/** Item id prefixes that a ticket may legally trace to (OUT- is legal but always a violation). */
export const TRACEABLE_PREFIXES = ["D", "UC", "FR", "NFR", "M"];

export const GAP_NEEDS = ["required", "optional"];
export const GAP_STATUSES = ["open", "accepted", "declined"];

/** An empty plan — every section present so callers never branch on "absent vs empty". */
export function emptyPlan() {
  return {
    planVersion: 1,
    sections: {
      goal: { text: "", metrics: [] },
      scope: { in: [], out: [] },
      deliverables: [],
      useCases: [],
      functional: [],
      nonFunctional: [],
      milestones: [],
      risks: [],
      gaps: [],
      openQuestions: [],
    },
  };
}

/**
 * Fill in whatever a plan on disk is missing, without inventing content.
 *
 * Every reader below assumes each section key exists with the right container type. Doing that
 * defensively at every call site is how a plan with one hand-deleted key turns into a crash in
 * the cockpit and a silently-skipped scope check in the orchestrator.
 */
export function normalisePlan(raw) {
  const base = emptyPlan();
  if (!raw || typeof raw !== "object") return base;
  const src = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
  const out = { planVersion: Number.isInteger(raw.planVersion) ? raw.planVersion : 1, sections: {} };

  for (const s of PLAN_SECTIONS) {
    const v = src[s.key];
    if (s.kind === "prose") {
      out.sections[s.key] = {
        text: typeof v?.text === "string" ? v.text : "",
        metrics: Array.isArray(v?.metrics) ? v.metrics.filter((m) => typeof m === "string") : [],
      };
    } else if (s.kind === "scope") {
      out.sections[s.key] = {
        in: Array.isArray(v?.in) ? v.in.filter((x) => typeof x === "string") : [],
        out: Array.isArray(v?.out) ? v.out.filter((x) => x && typeof x === "object" && x.id) : [],
      };
    } else {
      out.sections[s.key] = Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && x.id) : [];
    }
  }
  return out;
}

// ── Placeholder detection ───────────────────────────────────────────────────────
// `maestro setup` seeds the plan from a short brief and leaves anything the user skipped as an
// explicit placeholder. A placeholder must NOT count as filled: a plan that reads 100% while
// half its requirements say "propose one" is worse than no percentage at all, because it stops
// anyone from looking.
const PLACEHOLDERS = [
  /^\s*$/,
  /^_?propose one_?\.?$/i,
  /^_?not specified.*$/i,
  /^\s*(tbd|todo|t\.b\.d\.?|n\/a|\?+)\s*$/i,
  /^replace me\b/i,
  /^describe\b.*\bhere\b/i,
];

/** True when a string carries no real content (blank, or a seeded placeholder). */
export function isPlaceholder(s) {
  if (typeof s !== "string") return true;
  const t = s.trim();
  return PLACEHOLDERS.some((re) => re.test(t));
}

const hasText = (s) => !isPlaceholder(s);

/** True when a section holds at least one piece of real content. */
export function sectionFilled(plan, key) {
  const s = SECTION_BY_KEY.get(key);
  const v = normalisePlan(plan).sections[key];
  if (!s) return false;
  if (s.kind === "prose") return hasText(v.text);
  if (s.kind === "scope") return v.in.some(hasText) || v.out.some((o) => hasText(o.text));
  return v.some((item) => hasText(item.text));
}

/**
 * How complete the plan is, as the percentage /plan-update exists to raise.
 *
 * Weighted rather than "sections filled ÷ sections", because the sections are not equally
 * load-bearing: a plan with milestones but no goal is not 50% of a plan. Open REQUIRED gaps
 * are added to the denominator as unearned weight, so a reporting skill finding a hole in the
 * plan visibly lowers the number until someone accepts or declines it — which is the whole
 * point of routing gaps here instead of into a report nobody re-reads.
 *
 * @returns {{percent:number, earned:number, possible:number, sections:Array, missing:string[], requiredGaps:any[], optionalGaps:any[]}}
 */
export function planCompleteness(planRaw) {
  const plan = normalisePlan(planRaw);
  const gaps = plan.sections.gaps;
  const openGaps = gaps.filter((g) => (g.status ?? "open") === "open");
  const requiredGaps = openGaps.filter((g) => g.need === "required");
  const optionalGaps = openGaps.filter((g) => g.need !== "required");

  const sections = PLAN_SECTIONS.map((s) => {
    const filled = sectionFilled(plan, s.key);
    return {
      key: s.key,
      label: s.label,
      weight: s.weight,
      filled,
      counts: s.weight > 0,
      count: countSection(plan, s.key),
      detail: sectionDetail(plan, s),
    };
  });

  const scoring = sections.filter((s) => s.counts);
  const earned = scoring.reduce((n, s) => n + (s.filled ? s.weight : 0), 0);
  const possible = scoring.reduce((n, s) => n + s.weight, 0) + requiredGaps.length;
  const percent = possible === 0 ? 0 : Math.round((earned / possible) * 100);

  return {
    percent,
    earned,
    possible,
    sections,
    missing: scoring.filter((s) => !s.filled).map((s) => s.key),
    requiredGaps,
    optionalGaps,
  };
}

/** How many real entries a section holds (prose counts 0/1). */
export function countSection(planRaw, key) {
  const plan = normalisePlan(planRaw);
  const s = SECTION_BY_KEY.get(key);
  const v = plan.sections[key];
  if (!s) return 0;
  if (s.kind === "prose") return hasText(v.text) ? 1 : 0;
  if (s.kind === "scope") return v.in.filter(hasText).length + v.out.filter((o) => hasText(o.text)).length;
  return v.filter((i) => hasText(i.text)).length;
}

/**
 * The one-line "what's thin here" note the questionnaire and the Plan tab both show. Filled is
 * not the same as good: a requirement with no `verify` cannot be gated on, and an NFR with no
 * budget cannot be measured, so those are called out even when the section technically counts.
 */
function sectionDetail(plan, s) {
  const v = plan.sections[s.key];
  if (s.key === "goal") {
    if (!hasText(v.text)) return "No goal stated.";
    return v.metrics.filter(hasText).length ? "" : "No success metric — nothing to measure the goal against.";
  }
  if (s.key === "scope") {
    const inN = v.in.filter(hasText).length;
    const outN = v.out.filter((o) => hasText(o.text)).length;
    if (!inN && !outN) return "No boundary set — the scope gate has nothing to check against.";
    if (!outN) return "Nothing marked out of scope — the boundary is one-sided.";
    return "";
  }
  if (s.key === "functional") {
    const missing = v.filter((i) => hasText(i.text) && !hasText(i.verify)).map((i) => i.id);
    return missing.length ? `No verification method on ${missing.join(", ")}.` : "";
  }
  if (s.key === "nonFunctional") {
    const noBudget = v.filter((i) => hasText(i.text) && !hasText(i.budget)).map((i) => i.id);
    return noBudget.length ? `No measurable budget on ${noBudget.join(", ")} — can't be gated.` : "";
  }
  if (s.key === "gaps") {
    const open = v.filter((g) => (g.status ?? "open") === "open");
    const req = open.filter((g) => g.need === "required").length;
    if (!open.length) return "";
    return `${open.length} open (${req} required).`;
  }
  return "";
}

// ── Ids ─────────────────────────────────────────────────────────────────────────

/** Every id the plan defines, mapped to {id, prefix, section, text}. */
export function planItems(planRaw) {
  const plan = normalisePlan(planRaw);
  const out = new Map();
  for (const s of PLAN_SECTIONS) {
    if (s.kind === "list" || s.kind === "gaps") {
      for (const item of plan.sections[s.key]) {
        out.set(item.id, { id: item.id, prefix: s.prefix, section: s.key, text: item.text ?? "" });
      }
    }
  }
  for (const o of plan.sections.scope.out) {
    out.set(o.id, { id: o.id, prefix: "OUT", section: "scopeOut", text: o.text ?? "" });
  }
  return out;
}

/**
 * The next free id for a section, e.g. "FR-4".
 *
 * Max-plus-one rather than length-plus-one: ids are permanent references from tickets, so
 * reusing the id of a deleted requirement would silently re-point every ticket that traced to
 * it at unrelated work.
 */
export function nextId(planRaw, key) {
  const s = SECTION_BY_KEY.get(key);
  if (!s?.prefix) throw new Error(`Section "${key}" does not carry ids.`);
  const plan = normalisePlan(planRaw);
  const nums = plan.sections[key]
    .map((i) => String(i.id ?? "").match(new RegExp(`^${s.prefix}-(\\d+)$`)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return `${s.prefix}-${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

/** The next free OUT- id (scope.out is the one id'd list that isn't its own section). */
export function nextOutId(planRaw) {
  const plan = normalisePlan(planRaw);
  const nums = plan.sections.scope.out
    .map((o) => String(o.id ?? "").match(/^OUT-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return `OUT-${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

/** Which section an id belongs to, from its prefix. */
export function sectionForId(id) {
  const m = String(id ?? "").match(/^([A-Z]+)-\d+$/);
  if (!m) return null;
  if (m[1] === "OUT") return "scopeOut";
  return PLAN_SECTIONS.find((s) => s.prefix === m[1])?.key ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────────

/**
 * Structural check on a plan, mirroring plan.schema.json. Errors block a write; warnings are
 * quality notes that never do — an incomplete plan is the normal state of a young project and
 * must stay writable, or /plan-update could never fill it in.
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePlan(planRaw) {
  const errors = [];
  const warnings = [];

  if (!planRaw || typeof planRaw !== "object") return { errors: ["Plan must be an object."], warnings };
  if (planRaw.sections && typeof planRaw.sections !== "object") errors.push("`sections` must be an object.");
  for (const key of Object.keys(planRaw.sections ?? {})) {
    if (!SECTION_BY_KEY.has(key)) errors.push(`Unknown plan section "${key}" — known: ${SECTION_KEYS.join(", ")}.`);
  }
  if (errors.length) return { errors, warnings };

  const plan = normalisePlan(planRaw);
  const seen = new Set();

  const checkId = (id, prefix, where) => {
    if (!id) return errors.push(`${where}: item missing id.`);
    if (!new RegExp(`^${prefix}-\\d+$`).test(id)) {
      errors.push(`${where}: id "${id}" must look like ${prefix}-1.`);
    }
    // Ids are the join key between the plan and the board. A duplicate makes `traces_to`
    // ambiguous, so the scope gate would resolve a ticket against whichever copy it hit first.
    if (seen.has(id)) errors.push(`Duplicate plan id "${id}" — ids must be unique across the whole plan.`);
    seen.add(id);
  };

  for (const s of PLAN_SECTIONS) {
    if (s.kind !== "list" && s.kind !== "gaps") continue;
    for (const item of plan.sections[s.key]) {
      checkId(item.id, s.prefix, s.label);
      if (typeof item.text !== "string") errors.push(`${item.id}: \`text\` must be a string.`);
      for (const k of Object.keys(item)) {
        const allowed = ["id", "text", "notes", ...(s.fields ?? [])];
        if (s.kind === "gaps") allowed.push("need", "status", "from", "resolvedAs");
        if (!allowed.includes(k)) errors.push(`${item.id}: unknown field "${k}" (allowed: ${allowed.join(", ")}).`);
      }
    }
  }

  for (const o of plan.sections.scope.out) {
    checkId(o.id, "OUT", "Scope (out)");
    if (typeof o.text !== "string") errors.push(`${o.id}: \`text\` must be a string.`);
  }

  for (const g of plan.sections.gaps) {
    if (!GAP_NEEDS.includes(g.need)) errors.push(`${g.id}: need must be one of ${GAP_NEEDS.join(", ")}.`);
    if (g.status && !GAP_STATUSES.includes(g.status)) errors.push(`${g.id}: unknown status "${g.status}".`);
    if (g.status === "accepted" && !g.resolvedAs) {
      warnings.push(`${g.id}: accepted but doesn't say which plan item it became (set resolvedAs).`);
    }
    if (g.resolvedAs && !seen.has(g.resolvedAs) && sectionForId(g.resolvedAs)) {
      warnings.push(`${g.id}: resolvedAs "${g.resolvedAs}" isn't an id in this plan.`);
    }
  }

  // Quality warnings — the things that make a plan look done without being usable.
  for (const r of plan.sections.functional) {
    if (hasText(r.text) && !hasText(r.verify)) warnings.push(`${r.id}: no verification method — the release gate has nothing to check.`);
  }
  for (const n of plan.sections.nonFunctional) {
    if (hasText(n.text) && !hasText(n.budget)) warnings.push(`${n.id}: no measurable budget — this NFR can't be gated on.`);
  }

  return { errors, warnings };
}

// ── The scope gate ──────────────────────────────────────────────────────────────

/**
 * True when the plan says enough for the gate to mean anything.
 *
 * A blank plan must NOT gate: a project one minute past `maestro setup` would have every
 * ticket refused, and the fastest way out would be to delete the plan. The gate turns itself
 * on the moment there is something to be in scope OF.
 */
export function planIsGating(planRaw) {
  const plan = normalisePlan(planRaw);
  return (
    plan.sections.functional.some((i) => hasText(i.text)) ||
    plan.sections.deliverables.some((i) => hasText(i.text)) ||
    plan.sections.useCases.some((i) => hasText(i.text))
  );
}

/**
 * Is this ticket (or epic) inside the plan?
 *
 * States:
 *   no-plan    — nothing to check against; never blocks
 *   exception  — a human wrote `scope_exception`; allowed, but reported everywhere
 *   in-scope   — traces to at least one real plan item
 *   untraced   — traces to nothing: by definition not in the plan
 *   unknown    — traces to an id the plan doesn't define (usually a deleted requirement)
 *   out        — traces to something the plan explicitly excluded (OUT-n)
 *
 * `blocks` is what the orchestrator reads. The validator only ever warns on the same verdict —
 * that split is deliberate: you must be able to jot a ticket before the plan covers it, but
 * nothing may RUN until someone decides it is in scope.
 *
 * @returns {{state:string, blocks:boolean, reason:string, ids:string[], unknown:string[], out:string[]}}
 */
export function scopeVerdict(ticket, planRaw) {
  const none = { ids: [], unknown: [], out: [] };
  if (!planIsGating(planRaw)) {
    return { state: "no-plan", blocks: false, reason: "No project plan yet — the scope gate is off until the plan names a deliverable, use case, or requirement.", ...none };
  }

  const items = planItems(planRaw);
  const ids = Array.isArray(ticket?.traces_to) ? ticket.traces_to.filter((x) => typeof x === "string") : [];

  if (typeof ticket?.scope_exception === "string" && ticket.scope_exception.trim()) {
    return {
      state: "exception",
      blocks: false,
      reason: `Scope exception on record: ${ticket.scope_exception.trim()}`,
      ids, unknown: [], out: [],
    };
  }

  if (!ids.length) {
    return {
      state: "untraced",
      blocks: true,
      reason: "Traces to nothing in the plan — it is out of scope until the plan covers it.",
      ...none,
    };
  }

  // Only D/UC/FR/NFR/M put something INSIDE the scope boundary. A gap (G-n) is by definition
  // something the plan does not yet cover, and a risk or open question commits to nothing — so
  // tracing a ticket at one of those must not smuggle it past the gate. Accept the gap into
  // the plan first; the ticket then traces to whatever it became.
  const prefixOf = (id) => items.get(id)?.prefix ?? null;
  const resolved = ids.filter((id) => TRACEABLE_PREFIXES.includes(prefixOf(id)));
  const out = ids.filter((id) => prefixOf(id) === "OUT");
  const unknown = ids.filter((id) => !resolved.includes(id) && !out.includes(id));

  if (out.length) {
    return {
      state: "out",
      blocks: true,
      reason: `Traces to ${out.join(", ")}, which the plan lists as out of scope.`,
      ids, unknown, out,
    };
  }
  if (!resolved.length) {
    return {
      state: "unknown",
      blocks: true,
      reason: `Traces only to ${unknown.join(", ")}, which the plan does not define as in-scope work.`,
      ids, unknown, out,
    };
  }
  if (unknown.length) {
    // Partially resolvable: one good trace is enough to run, but the dangling id is still a
    // defect worth reporting — it usually means a requirement was deleted out from under it.
    return {
      state: "in-scope",
      blocks: false,
      reason: `In scope via ${resolved.join(", ")}; ${unknown.join(", ")} is not an in-scope plan item.`,
      ids, unknown, out,
    };
  }
  return {
    state: "in-scope",
    blocks: false,
    reason: `In scope via ${resolved.join(", ")}.`,
    ids, unknown, out,
  };
}

/**
 * Which plan items have no ticket working them — the coverage question the kit could not
 * answer before. Counts live and archived tickets, since a landed ticket still covers its
 * requirement.
 *
 * @returns {Array<{id:string, section:string, text:string, tickets:string[], done:boolean}>}
 */
export function planCoverage(planRaw, tickets = [], archived = []) {
  const items = planItems(planRaw);
  const byId = new Map();
  for (const [id, item] of items) {
    if (item.prefix === "OUT" || item.prefix === "G" || item.prefix === "Q" || item.prefix === "R") continue;
    byId.set(id, { ...item, tickets: [], done: false });
  }
  const consider = [
    ...tickets.map((t) => ({ t, done: t.status === "done" })),
    ...archived.map((t) => ({ t, done: t.status === "done" })),
  ];
  for (const { t, done } of consider) {
    for (const id of Array.isArray(t.traces_to) ? t.traces_to : []) {
      const row = byId.get(id);
      if (!row) continue;
      row.tickets.push(t.id);
      if (done) row.done = true;
    }
  }
  return [...byId.values()];
}

// ── The Markdown mirror ─────────────────────────────────────────────────────────

const mdEscape = (s) => String(s ?? "").replace(/\r?\n/g, " ").trim();

/**
 * Render plan.json as the readable plan.md that ships beside it.
 *
 * Deterministic — same plan in, same bytes out, no timestamps — so the mirror doesn't churn
 * the git history on every unrelated write, and so the renderer's own lock file stays stable.
 */
export function renderPlanMd(planRaw, projectName = "Project") {
  const plan = normalisePlan(planRaw);
  const c = planCompleteness(plan);
  const L = [];

  L.push(`# ${projectName} — project plan`);
  L.push("");
  L.push(`_Generated from \`plan.json\` — **do not edit this file**; edits are overwritten on the next write._`);
  L.push(`_Edit it in the cockpit's **Plan** tab, or run \`/plan-update\`._`);
  L.push("");
  L.push(`**Plan completeness: ${c.percent}%**${c.missing.length ? ` — still missing: ${c.missing.map((k) => SECTION_BY_KEY.get(k).label).join(", ")}.` : " — every section filled."}`);
  if (c.requiredGaps.length) {
    L.push("");
    L.push(`> ⚠ ${c.requiredGaps.length} required gap(s) open against this plan. They hold the percentage down until accepted or declined.`);
  }
  L.push("");

  // Goal
  L.push(`## ${SECTION_BY_KEY.get("goal").heading}`);
  L.push("");
  L.push(hasText(plan.sections.goal.text) ? plan.sections.goal.text.trim() : "_Not set._");
  const metrics = plan.sections.goal.metrics.filter(hasText);
  if (metrics.length) {
    L.push("");
    L.push("**Success metrics**");
    L.push("");
    for (const m of metrics) L.push(`- ${mdEscape(m)}`);
  }
  L.push("");

  // Scope
  L.push(`## ${SECTION_BY_KEY.get("scope").heading}`);
  L.push("");
  const inScope = plan.sections.scope.in.filter(hasText);
  L.push("**In scope**");
  L.push("");
  if (inScope.length) for (const x of inScope) L.push(`- ${mdEscape(x)}`);
  else L.push("_Not set._");
  L.push("");
  const outScope = plan.sections.scope.out.filter((o) => hasText(o.text));
  L.push("**Out of scope** — a ticket tracing to one of these is refused by the scope gate.");
  L.push("");
  if (outScope.length) for (const o of outScope) L.push(`- \`${o.id}\` ${mdEscape(o.text)}`);
  else L.push("_Not set._");
  L.push("");

  // Id'd list sections
  for (const s of PLAN_SECTIONS) {
    if (s.kind !== "list") continue;
    const items = plan.sections[s.key].filter((i) => hasText(i.text));
    L.push(`## ${s.heading}`);
    L.push("");
    if (!items.length) {
      L.push("_Not set._");
      L.push("");
      continue;
    }
    const extra = (s.fields ?? []).filter((f) => items.some((i) => hasText(i[f])));
    if (extra.length) {
      L.push(`| Id | ${s.itemLabel ?? "What"} | ${extra.map(fieldLabel).join(" | ")} |`);
      L.push(`| --- | --- | ${extra.map(() => "---").join(" | ")} |`);
      for (const i of items) {
        L.push(`| \`${i.id}\` | ${mdEscape(i.text)} | ${extra.map((f) => mdEscape(i[f]) || "—").join(" | ")} |`);
      }
    } else {
      for (const i of items) L.push(`- \`${i.id}\` ${mdEscape(i.text)}`);
    }
    L.push("");
  }

  // Gaps — split by need, because that is the whole reason they're recorded here.
  const gaps = plan.sections.gaps.filter((g) => hasText(g.text));
  L.push(`## ${SECTION_BY_KEY.get("gaps").heading}`);
  L.push("");
  if (!gaps.length) {
    L.push("_None raised._");
    L.push("");
  } else {
    for (const need of GAP_NEEDS) {
      const rows = gaps.filter((g) => (g.need ?? "optional") === need);
      if (!rows.length) continue;
      L.push(`**${need === "required" ? "Required — the plan is incomplete without these" : "Optional — worth considering"}**`);
      L.push("");
      L.push("| Id | Gap | Raised by | Status |");
      L.push("| --- | --- | --- | --- |");
      for (const g of rows) {
        const status = g.status ?? "open";
        const shown = status === "accepted" && g.resolvedAs ? `accepted → \`${g.resolvedAs}\`` : status;
        L.push(`| \`${g.id}\` | ${mdEscape(g.text)} | ${mdEscape(g.from) || "—"} | ${shown} |`);
      }
      L.push("");
    }
  }

  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function fieldLabel(f) {
  return { verify: "Verified by", budget: "Budget", actor: "Actor", target: "Target", mitigation: "Mitigation" }[f] ?? f;
}
