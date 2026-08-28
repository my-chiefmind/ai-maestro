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
 *   initiatives — id'd scoped mini-plans (name/outcome/scope/metrics/depends_on) that OWN
 *           items in the list sections above. Structurally unlike the rest, which is why every
 *           mechanical function branches on this kind explicitly rather than falling through
 *           to the `text`-shaped list handling.
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
    key: "initiatives",
    itemLabel: "Initiative",
    label: "Initiatives",
    kind: "initiatives",
    prefix: "I",
    // WEIGHT 0 IS DELIBERATE. Any positive weight puts initiatives in the completeness
    // denominator, so every project that never asked for them would watch its percentage drop
    // for a section it will never fill. Initiatives are an optional organising layer, not an
    // obligation — same reasoning as gaps and open questions.
    weight: 0,
    heading: "Initiatives",
    blurb: "Independently valuable outcomes, each owning several epics. Use them only when the project holds multiple large outcomes; a small project goes straight from plan to epics.",
    // Never asked in the questionnaire: initiatives are proposed once the plan exists and its
    // shape is visible, not extracted from a brief before there is anything to divide.
    ask: null,
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
    fields: ["verify", "enforce"],
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
    fields: ["budget", "verify", "enforce"],
    heading: "Non-functional requirements",
    blurb: "Quality attributes with measurable bars: performance, security, availability, accessibility, compliance, operability.",
    ask: "What quality bars must it hold — speed, uptime, security posture, accessibility, compliance, cost?",
    followUp: "Give each a number or a named standard, and where the rule must never be violated, an `enforce` command that fails the build — an instruction to an agent is not a guarantee.",
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

/**
 * Item id prefixes that a ticket may legally trace to (OUT- is legal but always a violation).
 *
 * `I` is deliberately absent. An initiative is an organising boundary, not a unit of work —
 * tracing a ticket at one would say "this serves the whole initiative", which is exactly the
 * vagueness `traces_to` exists to prevent. A ticket traces to the requirement it implements
 * and derives its initiative through its epic.
 */
export const TRACEABLE_PREFIXES = ["D", "UC", "FR", "NFR", "M"];

/**
 * The sections whose items may be OWNED by an initiative. Everything else is project-level:
 * gaps and open questions belong to the project by definition (a gap is something the plan
 * does not yet cover, so it cannot belong to a slice of it), and an initiative cannot own
 * another initiative.
 *
 * This set is the validator's half of a rule the schema states separately — see the split
 * `ownedItem`/`item` definitions in plan.schema.json. The two must agree.
 */
export const OWNED_SECTIONS = new Set(["deliverables", "useCases", "functional", "nonFunctional", "milestones", "risks"]);

export const GAP_NEEDS = ["required", "optional"];
export const GAP_STATUSES = ["open", "accepted", "declined"];

/** An empty plan — every section present so callers never branch on "absent vs empty". */
export function emptyPlan() {
  return {
    planVersion: 1,
    sections: {
      goal: { text: "", metrics: [] },
      scope: { in: [], out: [] },
      initiatives: [],
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
    } else if (s.kind === "initiatives") {
      // NOTE THE MISSING `&& x.id`, unlike every branch around it. mutatePlan validates the
      // NORMALISED plan (plan-io.mjs), so anything dropped here is dropped before validatePlan
      // can object — and an id-less initiative filtered out at read time would be erased from
      // disk by the next unrelated write, silently, which is the exact class of data loss the
      // locked writers exist to prevent. Object entries survive normalisation; checkId then
      // reports the missing id as an error and the write is refused instead.
      out.sections[s.key] = Array.isArray(v)
        ? v.filter((x) => x && typeof x === "object").map(normaliseInitiative)
        : [];
    } else {
      out.sections[s.key] = Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && x.id) : [];
    }
  }
  return out;
}

/**
 * Fill in an initiative's containers without inventing content, and WITHOUT dropping unknown
 * keys — the spread comes first so validatePlan still sees a stray field and can report it.
 * Silently normalising an unknown key away would turn a typo'd `metric` into missing data
 * nobody is told about.
 *
 * Note that an initiative's `scope.out` is plain strings, unlike the project's, which carries
 * `OUT-` ids. Only the project boundary is enforced by the scope gate; an initiative's is
 * narrative, and giving it ids would imply a second gate that does not exist.
 *
 * `scope` is rebuilt rather than spread, so a nested typo (`scope.inn`) would vanish here the
 * way an unknown top-level key does not. validatePlan checks the RAW scope keys for exactly
 * that reason — the schema's `additionalProperties: false` and the validator have to agree.
 */
function normaliseInitiative(i) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    ...i,
    id: i.id,
    name: typeof i.name === "string" ? i.name : "",
    outcome: typeof i.outcome === "string" ? i.outcome : "",
    scope: {
      in: strings(i.scope?.in),
      out: strings(i.scope?.out),
    },
    metrics: strings(i.metrics),
    depends_on: strings(i.depends_on),
  };
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
  // An initiative carries no `text`: it is named and it states an outcome.
  if (s.kind === "initiatives") return v.some((i) => hasText(i.name));
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
  if (s.kind === "initiatives") return v.filter((i) => hasText(i.name)).length;
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
    if (noBudget.length) return `No measurable budget on ${noBudget.join(", ")} — can't be gated.`;
    const described = v.filter((i) => hasText(i.text) && !hasText(i.enforce)).map((i) => i.id);
    return described.length ? `${described.join(", ")} are checked by judgment, not by a command (no \`enforce\`).` : "";
  }
  if (s.key === "initiatives") {
    const noOutcome = v.filter((i) => hasText(i.name) && !hasText(i.outcome)).map((i) => i.id);
    return noOutcome.length ? `No outcome stated on ${noOutcome.join(", ")} — an initiative without one is a folder.` : "";
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
        out.set(item.id, {
          id: item.id,
          prefix: s.prefix,
          section: s.key,
          text: item.text ?? "",
          // null means project-wide: the item applies to every initiative. Only the sections in
          // OWNED_SECTIONS can carry a non-null value; validatePlan rejects it anywhere else.
          initiativeId: item.initiativeId ?? null,
        });
      }
    } else if (s.kind === "initiatives") {
      // Initiatives join the id space so `I-1` collides with any other `I-1` and sectionForId
      // resolves it — but they are not traceable (see TRACEABLE_PREFIXES) and are skipped by
      // planCoverage, so an initiative never appears as a requirement waiting for a ticket.
      for (const init of plan.sections[s.key]) {
        // An id-less entry survives normalisation so validatePlan can report it (see the
        // initiatives branch there); it must not be keyed into the id map as `undefined`.
        if (!init.id) continue;
        out.set(init.id, { id: init.id, prefix: s.prefix, section: s.key, text: init.name ?? "", initiativeId: null });
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
 * Every dependency cycle among initiatives, each as the list of ids forming the loop.
 *
 * Iterative DFS with a grey/black colouring, the same shape as the board's ticket-cycle check —
 * one algorithm for "this graph eats itself", so the two cannot disagree about what a cycle is.
 */
export function initiativeCycles(initiatives) {
  const byId = new Map(initiatives.map((i) => [i.id, i]));
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map([...byId.keys()].map((id) => [id, WHITE]));
  const cycles = [];
  const stack = [];
  const visit = (id) => {
    colour.set(id, GREY);
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue; // a dangling dependency is reported separately
      if (colour.get(dep) === GREY) cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (colour.get(dep) === WHITE) visit(dep);
    }
    stack.pop();
    colour.set(id, BLACK);
  };
  for (const id of byId.keys()) if (colour.get(id) === WHITE) visit(id);
  return cycles;
}

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

  // Initiatives are validated FIRST so the ownership check below has a set of known ids, and so
  // checkId has already claimed them in the shared id space.
  const initiativeIds = new Set();
  // Paired BY INDEX, not by id — an entry missing its id has nothing to look up by, and that is
  // precisely the entry these checks exist to catch. normalisePlan's initiatives branch filters
  // only non-objects, so the raw and normalised arrays agree on length and order.
  const rawInitiatives = (Array.isArray(planRaw.sections?.initiatives) ? planRaw.sections.initiatives : [])
    .filter((x) => x && typeof x === "object");
  plan.sections.initiatives.forEach((init, idx) => {
    const raw = rawInitiatives[idx] ?? {};
    const where = init.id ? `${init.id}` : `Initiative #${idx + 1} (no id)`;
    checkId(init.id, "I", "Initiatives");
    if (init.id) initiativeIds.add(init.id);
    if (!hasText(init.name)) errors.push(`${where}: an initiative needs a \`name\`.`);
    // An initiative without an outcome is a folder, which is the exact thing this layer is not.
    if (!hasText(init.outcome)) errors.push(`${where}: an initiative needs an \`outcome\` — what is true for someone once it lands.`);
    // Type checks read the RAW entry, not the normalised one: normalisation has already
    // filtered non-strings out, so comparing normalised-to-normalised would always pass and
    // this check would be dead code that looks alive.
    for (const [label, value] of [["scope.in", raw.scope?.in], ["scope.out", raw.scope?.out], ["metrics", raw.metrics], ["depends_on", raw.depends_on]]) {
      if (value === undefined) continue;
      if (!Array.isArray(value)) errors.push(`${where}: \`${label}\` must be an array of strings.`);
      else if (value.some((x) => typeof x !== "string")) errors.push(`${where}: \`${label}\` must contain only strings.`);
    }
    if (raw.scope !== undefined) {
      if (typeof raw.scope !== "object" || raw.scope === null || Array.isArray(raw.scope)) {
        errors.push(`${where}: \`scope\` must be an object with \`in\` and \`out\` arrays.`);
      } else {
        // Nested keys are checked against the RAW object because normaliseInitiative rebuilds
        // `scope` from scratch: a typo like `scope.inn` is gone by the time the normalised
        // entry exists, so only this can see it. The schema says additionalProperties:false
        // here, and core validation must not be the looser of the two.
        for (const k of Object.keys(raw.scope)) {
          if (k !== "in" && k !== "out") errors.push(`${where}: unknown field "scope.${k}" (allowed: in, out).`);
        }
      }
    }
    for (const k of Object.keys(raw)) {
      const allowed = ["id", "name", "outcome", "scope", "metrics", "depends_on", "notes"];
      if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}" (allowed: ${allowed.join(", ")}).`);
    }
  });
  for (const init of plan.sections.initiatives) {
    for (const dep of init.depends_on) {
      if (dep === init.id) errors.push(`${init.id}: depends on itself.`);
      else if (!initiativeIds.has(dep)) errors.push(`${init.id}: depends_on "${dep}", which is not an initiative in this plan.`);
    }
  }
  // Dependency cycles are informational metadata today (they never touch scheduling — see
  // board-core) but a cycle still means the plan describes an impossible order, and saying so
  // now is cheaper than discovering it when something does read them.
  for (const cyc of initiativeCycles(plan.sections.initiatives)) {
    errors.push(`Initiative dependency cycle: ${cyc.join(" → ")}.`);
  }

  for (const s of PLAN_SECTIONS) {
    if (s.kind !== "list" && s.kind !== "gaps") continue;
    for (const item of plan.sections[s.key]) {
      checkId(item.id, s.prefix, s.label);
      if (typeof item.text !== "string") errors.push(`${item.id}: \`text\` must be a string.`);
      for (const k of Object.keys(item)) {
        const allowed = ["id", "text", "notes", ...(s.fields ?? [])];
        if (s.kind === "gaps") allowed.push("need", "status", "from", "resolvedAs");
        // Ownership is legal on the six OWNED_SECTIONS only. On gaps and open questions the
        // field is not merely ignored — it is an unknown field, and reported as one.
        if (OWNED_SECTIONS.has(s.key)) allowed.push("initiativeId");
        if (!allowed.includes(k)) errors.push(`${item.id}: unknown field "${k}" (allowed: ${allowed.join(", ")}).`);
      }
      if (item.initiativeId !== undefined && OWNED_SECTIONS.has(s.key)) {
        if (typeof item.initiativeId !== "string" || !initiativeIds.has(item.initiativeId)) {
          errors.push(`${item.id}: initiativeId "${item.initiativeId}" is not an initiative in this plan. Omit it for a project-wide item.`);
        }
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
    // "I" is skipped for the same reason as the rest: an initiative is not work waiting for a
    // ticket. Without it every initiative would be reported as an uncovered plan item forever.
    if (["OUT", "G", "Q", "R", "I"].includes(item.prefix)) continue;
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

// ── Initiative progress ─────────────────────────────────────────────────────────

/** Every initiative in the plan, by id. Order follows the plan array, never a Map's insertion quirk. */
export function initiativeMap(planRaw) {
  return new Map(normalisePlan(planRaw).sections.initiatives.filter((i) => i.id).map((i) => [i.id, i]));
}

/**
 * The id of the initiative that owns a plan item, or null.
 *
 * null means project-wide — the item applies to every initiative. An id the plan does not
 * define also yields null, because "nobody owns it" is the truthful answer either way;
 * callers that need to distinguish an unknown item ask planItems, which is the register of
 * what exists.
 */
export function initiativeForItem(planRaw, itemId) {
  return planItems(planRaw).get(itemId)?.initiativeId ?? null;
}

/**
 * The sections whose items count toward an initiative's delivery percentage.
 *
 * Milestones are deliberately absent. A milestone is a checkpoint, not a thing that is built,
 * so counting one as delivered work would let an initiative read 60% because someone named
 * three dates. They are still reported per initiative — see the `milestones` field — just not
 * scored.
 */
const PROGRESS_SECTIONS = new Set(["deliverables", "useCases", "functional", "nonFunctional"]);

/**
 * Turn coverage rows into one progress record. The shared shape behind both an initiative's
 * progress and the project-wide bucket, so "covered" cannot come to mean two things.
 *
 * `percent` is done ÷ total, rounded — the share of this initiative's scored items that a
 * landed ticket has actually delivered, NOT the share that has a ticket filed against it.
 * Filing tickets must never move the number on its own.
 */
function progressFrom(id, name, rows) {
  const scored = rows.filter((r) => PROGRESS_SECTIONS.has(r.section));
  const covered = scored.filter((r) => r.tickets.length);
  const done = scored.filter((r) => r.done);
  return {
    id,
    name,
    total: scored.length,
    covered: covered.length,
    done: done.length,
    // No ticket at all, versus has a ticket that has not landed. Different problems: the first
    // needs planning, the second needs finishing.
    uncovered: scored.filter((r) => !r.tickets.length).map((r) => r.id),
    incomplete: covered.filter((r) => !r.done).map((r) => r.id),
    milestones: rows.filter((r) => r.section === "milestones").map((r) => r.id),
    percent: scored.length === 0 ? 0 : Math.round((done.length / scored.length) * 100),
  };
}

/**
 * Delivery progress per initiative.
 *
 * Derived ENTIRELY by grouping planCoverage() — it never walks the tickets itself. "Covered"
 * and "done" are decided in exactly one place, so a per-initiative report and the project-wide
 * one can never disagree about the same requirement. planCoverage already counts live and
 * archived tickets, which is what makes a landed ticket still count for the item it delivered.
 *
 * A project-wide item (no initiativeId) is deliberately excluded from every initiative's
 * percentage: counting a shared NFR toward all six initiatives would flatter every one of them
 * with the same piece of work. It is reported once by projectWideProgress().
 *
 * @returns {Array<{id, name, total, covered, done, uncovered, incomplete, milestones, percent}>}
 *          empty when the plan defines no initiative
 */
export function initiativeProgress(planRaw, tickets = [], archived = []) {
  const initiatives = initiativeMap(planRaw);
  if (!initiatives.size) return [];
  const rows = planCoverage(planRaw, tickets, archived);
  return [...initiatives.values()].map((init) =>
    progressFrom(init.id, init.name, rows.filter((r) => r.initiativeId === init.id)));
}

/**
 * The same record for the items no initiative owns. Reported once, beside the initiatives,
 * rather than folded into each of them.
 */
export function projectWideProgress(planRaw, tickets = [], archived = []) {
  const rows = planCoverage(planRaw, tickets, archived).filter((r) => r.initiativeId == null);
  return progressFrom(null, "Project-wide", rows);
}

/**
 * Every plan item that carries an `enforce` command.
 *
 * This is the difference between a requirement the agents are ASKED to honour and one they
 * CANNOT violate. "Always include the clinic id" given to a model is a wish; the same rule as a
 * command that exits non-zero is a fact about the repository. `verify` says how a human would
 * check the bar; `enforce` is the check itself, and the release gate runs it rather than
 * judging it.
 *
 * @param {any} planRaw
 * @param {string[]|null} [ids] restrict to these plan ids (a ticket's traces_to), or all
 * @returns {Array<{id:string, section:string, text:string, enforce:string, budget?:string}>}
 */
export function enforceableItems(planRaw, ids = null) {
  const plan = normalisePlan(planRaw);
  const out = [];
  for (const key of ["functional", "nonFunctional"]) {
    for (const item of plan.sections[key]) {
      if (!hasText(item.enforce)) continue;
      if (ids && !ids.includes(item.id)) continue;
      out.push({ id: item.id, section: key, text: item.text, enforce: item.enforce.trim(), budget: item.budget });
    }
  }
  return out;
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

  // Id'd list sections.
  //
  // TWO PATHS, deliberately. With no initiative defined the legacy path below runs UNCHANGED,
  // byte for byte — that is what test/fixtures/legacy-plan.md pins, and it is why an
  // initiative-free project sees no churn in its plan.md the day this ships. Routing legacy
  // plans through the initiative-aware renderer and hoping the bytes lined up would have been
  // the same feature with none of the guarantee.
  const initiatives = plan.sections.initiatives.filter((i) => i.id && hasText(i.name));

  if (!initiatives.length) {
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
      L.push(...itemBody(s, items));
      L.push("");
    }
  } else {
    // Ownership is read from the plan array in ORDER — never from a Map — so the same plan
    // always renders the same bytes.
    const owned = (key, initiativeId) =>
      plan.sections[key].filter((i) => hasText(i.text) && (i.initiativeId ?? null) === initiativeId);

    const ownedBlock = (initiativeId, level) => {
      const out = [];
      for (const s of PLAN_SECTIONS) {
        if (s.kind !== "list" || !OWNED_SECTIONS.has(s.key)) continue;
        const items = owned(s.key, initiativeId);
        if (!items.length) continue;
        out.push(`${"#".repeat(level)} ${s.heading}`, "", ...itemBody(s, items), "");
      }
      return out;
    };

    const global = ownedBlock(null, 3);
    L.push("## Project-wide plan items");
    L.push("");
    if (global.length) {
      L.push("_Owned by no single initiative — these apply to every one._");
      L.push("");
      L.push(...global);
    } else {
      L.push("_None — every plan item belongs to an initiative._");
      L.push("");
    }

    L.push(`## ${SECTION_BY_KEY.get("initiatives").heading}`);
    L.push("");
    for (const init of initiatives) {
      L.push(`### \`${init.id}\` ${mdEscape(init.name)}`);
      L.push("");
      L.push(hasText(init.outcome) ? init.outcome.trim() : "_No outcome stated._");
      L.push("");
      const inScope = init.scope.in.filter(hasText);
      const outScope = init.scope.out.filter(hasText);
      if (inScope.length || outScope.length) {
        if (inScope.length) {
          L.push("**In scope**");
          L.push("");
          for (const x of inScope) L.push(`- ${mdEscape(x)}`);
          L.push("");
        }
        if (outScope.length) {
          L.push("**Out of scope for this initiative**");
          L.push("");
          for (const x of outScope) L.push(`- ${mdEscape(x)}`);
          L.push("");
        }
      }
      const metrics = init.metrics.filter(hasText);
      if (metrics.length) {
        L.push("**Metrics**");
        L.push("");
        for (const m of metrics) L.push(`- ${mdEscape(m)}`);
        L.push("");
      }
      const deps = init.depends_on.filter(hasText);
      if (deps.length) {
        L.push(`**Depends on:** ${deps.map((d) => `\`${d}\``).join(", ")} — planning information only; it never affects ticket or lane scheduling.`);
        L.push("");
      }
      const block = ownedBlock(init.id, 4);
      if (block.length) L.push(...block);
      else {
        L.push("_No plan items owned yet._");
        L.push("");
      }
    }

    // Open questions stay project-level in both modes; in initiative mode they sit with the
    // gaps at the end rather than in the per-initiative run.
    const questions = plan.sections.openQuestions.filter((i) => hasText(i.text));
    L.push(`## ${SECTION_BY_KEY.get("openQuestions").heading}`);
    L.push("");
    if (questions.length) L.push(...itemBody(SECTION_BY_KEY.get("openQuestions"), questions));
    else L.push("_Not set._");
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

/**
 * The rows for one list section — a table when any optional field is populated, bullets
 * otherwise. Extracted so the legacy and initiative-mode renderers cannot drift into two
 * different table shapes; the legacy caller passes exactly what the old inline loop did.
 */
function itemBody(s, items) {
  const out = [];
  const extra = (s.fields ?? []).filter((f) => items.some((i) => hasText(i[f])));
  if (extra.length) {
    out.push(`| Id | ${s.itemLabel ?? "What"} | ${extra.map(fieldLabel).join(" | ")} |`);
    out.push(`| --- | --- | ${extra.map(() => "---").join(" | ")} |`);
    for (const i of items) {
      out.push(`| \`${i.id}\` | ${mdEscape(i.text)} | ${extra.map((f) => mdEscape(i[f]) || "—").join(" | ")} |`);
    }
  } else {
    for (const i of items) out.push(`- \`${i.id}\` ${mdEscape(i.text)}`);
  }
  return out;
}

function fieldLabel(f) {
  return { verify: "Verified by", budget: "Budget", actor: "Actor", target: "Target", mitigation: "Mitigation", enforce: "Enforced by" }[f] ?? f;
}
