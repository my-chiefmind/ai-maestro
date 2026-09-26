/** Pure, targeted plan operations. Input plans are cloned; no filesystem or process state. */
import { SECTION_BY_KEY, PLAN_SECTIONS, GAP_NEEDS, GAP_STATUSES, OWNED_SECTIONS, nextId, nextOutId, sectionForId, isPlaceholder, initiativeMap } from "./plan-core.mjs";

export class PlanInputError extends Error {
  constructor(message, detail = {}) { super(message); this.name = "PlanInputError"; this.code = "EPLANINPUT"; Object.assign(this, detail); }
}
export class PlanNotFoundError extends Error {
  constructor(message, detail = {}) { super(message); this.name = "PlanNotFoundError"; this.code = "EPLANNOTFOUND"; Object.assign(this, detail); }
}
const fail = (message) => { throw new PlanInputError(message); };
const text = (value, label = "text") => { if (typeof value !== "string" || isPlaceholder(value)) fail(`${label} must say something.`); return value; };
const list = (value, label) => { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be an array of strings.`); return value; };
const only = (params, names) => { const bad = Object.keys(params).filter((key) => !names.includes(key)); if (bad.length) fail(`Unknown field(s): ${bad.join(", ")}.`); };

export function applyPlanOperation(source, operation, params = {}) {
  const plan = structuredClone(source);
  if (!params || typeof params !== "object" || Array.isArray(params)) fail("Operation fields must be an object.");
  let result = {};
  switch (operation) {
    case "init": only(params, []); break;
    case "render": only(params, []); break;
    case "addInitiative": {
      only(params, ["name", "outcome", "in", "out", "metrics", "dependsOn", "notes"]);
      const depends = list(params.dependsOn ?? [], "dependsOn");
      for (const id of depends) if (!initiativeMap(plan).has(id)) fail(`Dependency ${id} is not an initiative in this plan.`);
      const id = nextId(plan, "initiatives");
      plan.sections.initiatives.push({ id, name: text(params.name, "name"), outcome: text(params.outcome, "outcome"), scope: { in: list(params.in ?? [], "in"), out: list(params.out ?? [], "out") }, metrics: list(params.metrics ?? [], "metrics"), depends_on: depends, ...(params.notes ? { notes: params.notes } : {}) });
      result = { id }; break;
    }
    case "editInitiative": {
      only(params, ["id", "name", "outcome", "notes", "in", "out", "metrics", "dependsOn"]);
      const initiative = plan.sections.initiatives.find((item) => item.id === params.id);
      if (!initiative) throw new PlanNotFoundError(`${params.id} is not an initiative.`, { id: params.id });
      if (params.name !== undefined) initiative.name = text(params.name, "name");
      if (params.outcome !== undefined) initiative.outcome = text(params.outcome, "outcome");
      if (params.notes !== undefined) { if (typeof params.notes !== "string") fail("notes must be a string."); initiative.notes = params.notes; }
      if (params.in !== undefined) initiative.scope.in = list(params.in, "in");
      if (params.out !== undefined) initiative.scope.out = list(params.out, "out");
      if (params.metrics !== undefined) initiative.metrics = list(params.metrics, "metrics");
      if (params.dependsOn !== undefined) {
        const deps = list(params.dependsOn, "dependsOn");
        for (const id of deps) { if (id === params.id) fail(`${id} cannot depend on itself.`); if (!initiativeMap(plan).has(id)) fail(`--depends-on ${id} is not an initiative in this plan.`); }
        initiative.depends_on = deps;
      }
      result = { id: params.id }; break;
    }
    case "removeInitiative": {
      only(params, ["id"]);
      const index = plan.sections.initiatives.findIndex((item) => item.id === params.id);
      if (index < 0) throw new PlanNotFoundError(`${params.id} is not an initiative.`, { id: params.id });
      const refs = [];
      for (const section of PLAN_SECTIONS.filter((item) => item.kind === "list")) for (const item of plan.sections[section.key] ?? []) if (item.initiativeId === params.id) refs.push(`plan item ${item.id}`);
      for (const item of plan.sections.initiatives) if ((item.depends_on ?? []).includes(params.id)) refs.push(`initiative ${item.id} depends_on it`);
      plan.sections.initiatives.splice(index, 1); result = { id: params.id, references: refs }; break;
    }
    case "setGoal": {
      only(params, ["text", "metrics", "clearMetrics"]);
      if (params.text !== undefined) plan.sections.goal.text = text(params.text);
      if (params.clearMetrics === true) plan.sections.goal.metrics = [];
      if (params.metrics !== undefined) for (const metric of list(params.metrics, "metrics")) if (!plan.sections.goal.metrics.includes(text(metric, "metric"))) plan.sections.goal.metrics.push(metric);
      break;
    }
    case "addScope": {
      only(params, ["in", "out", "removeOut"]);
      for (const item of list(params.in ?? [], "in")) if (!plan.sections.scope.in.includes(text(item))) plan.sections.scope.in.push(item);
      const added = [];
      for (const item of list(params.out ?? [], "out")) { const id = nextOutId(plan); plan.sections.scope.out.push({ id, text: text(item) }); added.push(id); }
      const removeOut = list(params.removeOut ?? [], "removeOut");
      plan.sections.scope.out = plan.sections.scope.out.filter((item) => !removeOut.includes(item.id));
      result = { added }; break;
    }
    case "addItem": {
      only(params, ["section", "text", "verify", "budget", "enforce", "actor", "target", "mitigation", "notes", "initiativeId"]);
      const section = SECTION_BY_KEY.get(params.section);
      if (!section || section.kind !== "list" || params.section === "gaps") fail("section must be a list section other than gaps.");
      const item = { id: nextId(plan, params.section), text: text(params.text) };
      for (const field of ["verify", "budget", "enforce", "actor", "target", "mitigation", "notes"]) {
        if (params[field] === undefined) continue;
        if (field !== "notes" && !(section.fields ?? []).includes(field)) fail(`${field} does not apply to ${params.section}.`);
        if (typeof params[field] !== "string") fail(`${field} must be a string.`);
        item[field] = params[field];
      }
      if (params.initiativeId !== undefined) { if (!OWNED_SECTIONS.has(params.section) || !initiativeMap(plan).has(params.initiativeId)) fail("Invalid initiative ownership."); item.initiativeId = params.initiativeId; }
      plan.sections[params.section].push(item); result = { id: item.id }; break;
    }
    case "editItem": {
      only(params, ["id", "text", "verify", "budget", "enforce", "actor", "target", "mitigation", "notes", "initiativeId", "clearInitiative"]);
      const sectionKey = sectionForId(params.id), section = SECTION_BY_KEY.get(sectionKey);
      if (!section || section.kind !== "list") fail("Invalid plan item id.");
      const item = plan.sections[sectionKey].find((entry) => entry.id === params.id);
      if (!item) throw new PlanNotFoundError(`${params.id} is not in the plan.`, { id: params.id });
      for (const field of ["text", "verify", "budget", "enforce", "actor", "target", "mitigation", "notes"]) {
        if (params[field] === undefined) continue;
        if (field !== "text" && field !== "notes" && !(section.fields ?? []).includes(field)) fail(`${field} does not apply to ${sectionKey}.`);
        item[field] = field === "text" ? text(params[field]) : params[field];
        if (typeof item[field] !== "string") fail(`${field} must be a string.`);
      }
      if (params.clearInitiative && params.initiativeId !== undefined) fail("initiativeId and clearInitiative conflict.");
      if (params.initiativeId !== undefined) { if (!OWNED_SECTIONS.has(sectionKey) || !initiativeMap(plan).has(params.initiativeId)) fail("Invalid initiative ownership."); item.initiativeId = params.initiativeId; }
      if (params.clearInitiative) delete item.initiativeId;
      result = { id: params.id }; break;
    }
    case "removeItem": {
      only(params, ["id"]);
      const key = sectionForId(params.id);
      if (!key) fail("Invalid plan item id.");
      const items = key === "scopeOut" ? plan.sections.scope.out : plan.sections[key];
      const index = items.findIndex((item) => item.id === params.id);
      if (index < 0) throw new PlanNotFoundError(`${params.id} is not in the plan.`, { id: params.id });
      items.splice(index, 1); result = { id: params.id }; break;
    }
    case "addGap": {
      only(params, ["text", "need", "from"]);
      const body = text(params.text);
      if (!GAP_NEEDS.includes(params.need)) fail("Invalid gap need.");
      const duplicate = plan.sections.gaps.find((gap) => gap.text.trim().toLowerCase() === body.trim().toLowerCase());
      if (duplicate) { result = { id: duplicate.id, duplicate: true }; break; }
      const id = nextId(plan, "gaps"); plan.sections.gaps.push({ id, text: body, need: params.need, from: params.from ?? "", status: "open" }); result = { id }; break;
    }
    case "setGap": {
      only(params, ["id", "status", "need", "resolvedAs"]);
      const gap = plan.sections.gaps.find((item) => item.id === params.id);
      if (!gap) throw new PlanNotFoundError(`${params.id} is not a gap.`, { id: params.id });
      if (params.status !== undefined) { if (!GAP_STATUSES.includes(params.status)) fail("Invalid gap status."); gap.status = params.status; }
      if (params.need !== undefined) { if (!GAP_NEEDS.includes(params.need)) fail("Invalid gap need."); gap.need = params.need; }
      if (params.resolvedAs !== undefined) { if (typeof params.resolvedAs !== "string") fail("resolvedAs must be a string."); gap.resolvedAs = params.resolvedAs; }
      result = { id: params.id }; break;
    }
    default: fail(`Unknown plan operation: ${operation}.`);
  }
  return { plan, result };
}
