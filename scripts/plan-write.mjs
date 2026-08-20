#!/usr/bin/env node
/**
 * plan-write.mjs — `maestro plan <op>`: the only supported way to change board/plan.json.
 *
 * Same contract as `maestro ticket`: every operation is DECLARATIVE ("add this requirement",
 * not "here is the new plan"), applied to the file as it exists at write time, inside the board
 * lock, validated, and written atomically — with plan.md re-rendered in the same breath.
 *
 * Usage:
 *   maestro plan init                          create an empty plan (and its mirror)
 *   maestro plan show [--section <key>]        print the plan
 *   maestro plan status                        completeness %, per-section, open gaps
 *   maestro plan questions                     the next unanswered questions (drives /plan-update)
 *   maestro plan coverage                      plan items vs the tickets working them
 *   maestro plan set-goal --text <t> [--metric <m>]...
 *   maestro plan scope [--in <t>]... [--out <t>]...
 *   maestro plan add <section> --text <t> [--verify|--budget|--actor|--target|--mitigation|--notes <v>]
 *   maestro plan edit <ID> [--text|--verify|--budget|--actor|--target|--mitigation|--notes <v>]
 *   maestro plan remove <ID>
 *   maestro plan gap-add --text <t> --need required|optional [--from <skill>]
 *   maestro plan gap-set <G-ID> --status open|accepted|declined [--resolved-as <ID>]
 *   maestro plan render                        rewrite plan.md from plan.json
 *   maestro plan version                       the plan's content version
 *
 * Common flags: --board <path> --plan <path> --expect-version <v> --json --dry-run
 *
 * Exit codes: 0 = written (or no-op), 1 = the request was wrong (do not retry), 2 = contended —
 * the plan moved or the lock was busy, so re-run the same command.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import {
  PLAN_SECTIONS, SECTION_BY_KEY, SECTION_KEYS, QUESTION_SECTIONS, GAP_NEEDS, GAP_STATUSES,
  planCompleteness, planCoverage, planItems, planIsGating, nextId, nextOutId, sectionForId,
  validatePlan, isPlaceholder, TRACEABLE_PREFIXES,
} from "./plan-core.mjs";
import { planPaths, readPlan, planVersion, mutatePlan } from "./plan-io.mjs";
import { BoardConflictError, BoardLockError } from "./board-io.mjs";

const argv = process.argv.slice(2);
const OPS = new Set([
  "init", "show", "status", "questions", "coverage", "gate",
  "set-goal", "scope", "add", "edit", "remove",
  "gap-add", "gap-set", "render", "version",
]);

/** First value of a flag. */
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
/** EVERY value of a repeatable flag — `--metric a --metric b` is the natural way to give a list. */
const flagAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] != null && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
  }
  return out;
};
const has = (name) => argv.includes(`--${name}`);

const JSON_OUT = has("json");
const DRY_RUN = has("dry-run");

function die(msg, code = 1) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg, code }) + "\n");
  else process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code);
}

function ok(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  else if (human) process.stdout.write(`  ✓ ${human}\n`);
  process.exit(0);
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function usage() {
  process.stdout.write(`
  maestro plan — the project plan every epic and ticket is scoped against

    maestro plan status                     completeness %, what's thin, open gaps
    maestro plan questions                  the next unanswered questions
    maestro plan show [--section <key>]     print the plan
    maestro plan coverage                   plan items vs the tickets working them
    maestro plan gate --json                the scope boundary, for machine callers

    maestro plan init                       create an empty plan
    maestro plan set-goal --text <t> [--metric <m>]...
    maestro plan scope [--in <t>]... [--out <t>]...
    maestro plan add <section> --text <t> [field flags]
    maestro plan edit <ID> [field flags]
    maestro plan remove <ID>
    maestro plan gap-add --text <t> --need required|optional [--from <skill>]
    maestro plan gap-set <G-ID> --status open|accepted|declined [--resolved-as <ID>]
    maestro plan render                     rewrite plan.md from plan.json
    maestro plan version

  Sections: ${PLAN_SECTIONS.filter((s) => s.kind === "list").map((s) => s.key).join(", ")}
  Field flags: --text --verify --budget --actor --target --mitigation --notes
  Common:      --board --plan --expect-version --json --dry-run

  Exit 2 means the plan moved or the lock was busy — re-read and retry. Exit 1 means the
  request itself was wrong; retrying will not help.

`);
  process.exit(argv.length ? 1 : 0);
}

// ── Paths ───────────────────────────────────────────────────────────────────────
const boardArg = flag("board", "board/data.json");
const paths = planPaths(boardArg);
const PLAN_PATH = resolve(flag("plan") ?? paths.plan);
const DATA_PATH = resolve(paths.data);

/** Project name for the rendered plan.md — from config.json beside the board dir, if any. */
function projectName() {
  for (const p of [join(paths.boardDir, "..", "config.json"), join(paths.boardDir, "config.json")]) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (cfg?.project?.name) return String(cfg.project.name);
    } catch { /* no config, or not ours to read */ }
  }
  return "Project";
}

// ── Per-item field flags ────────────────────────────────────────────────────────
const ITEM_FIELDS = ["text", "verify", "budget", "actor", "target", "mitigation", "notes"];

/** Collect the field flags the caller actually passed (absent ≠ empty — absent leaves it alone). */
function itemPatch(section) {
  const patch = {};
  for (const f of ITEM_FIELDS) {
    const v = flag(f);
    if (v == null) continue;
    if (f !== "text" && f !== "notes" && section && !(section.fields ?? []).includes(f)) {
      die(`--${f} does not apply to "${section.key}" (it accepts: ${["text", ...(section.fields ?? []), "notes"].join(", ")}).`);
    }
    patch[f] = v;
  }
  return patch;
}

function write(mutate, op) {
  if (DRY_RUN) {
    const before = readPlan(PLAN_PATH);
    const after = mutate(structuredClone(before));
    const { errors } = validatePlan(after);
    if (errors.length) die(`Would be invalid:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
    return { plan: after, version: planVersion(PLAN_PATH), changed: true, warnings: [], dryRun: true };
  }
  try {
    const r = mutatePlan({ planPath: PLAN_PATH, mutate, expectVersion: flag("expect-version"), projectName: projectName(), op });
    // Quality warnings never block a write — an incomplete plan must stay writable — but they
    // go to stderr rather than being swallowed, or a requirement with no verification method
    // sits there looking finished. --json callers get them via `maestro plan status`.
    if (!JSON_OUT) for (const w of r.warnings) process.stderr.write(`  ⚠ ${w}\n`);
    return r;
  } catch (e) {
    if (e instanceof BoardConflictError || e instanceof BoardLockError) die(e.message, 2);
    die(e.message, 1);
  }
}

// ── Read-only reports ───────────────────────────────────────────────────────────

function renderStatus(plan) {
  const c = planCompleteness(plan);
  if (JSON_OUT) return ok({ ...c, planPath: PLAN_PATH, version: planVersion(PLAN_PATH) });

  const bar = (pct) => {
    const n = Math.round(pct / 5);
    return `[${"█".repeat(n)}${"·".repeat(20 - n)}]`;
  };
  out("");
  out(`  Project plan — ${bar(c.percent)} ${c.percent}% complete`);
  out("");
  for (const s of c.sections) {
    // A filled tick only means something for sections that count toward the percentage. Gaps
    // and open questions being "filled" is not good news, so they never get one.
    const mark = !s.counts ? (s.count ? "·" : "○") : s.filled ? "✓" : "·";
    const count = s.count ? ` (${s.count})` : "";
    const note = s.detail ? `  ${s.detail}` : "";
    out(`   ${mark} ${s.label.padEnd(30)}${count.padEnd(6)}${note}`);
  }
  if (c.requiredGaps.length) {
    out("");
    out(`  Required gaps — these hold the percentage down until accepted or declined:`);
    for (const g of c.requiredGaps) out(`   ⚠ ${g.id}  ${g.text}${g.from ? `  (${g.from})` : ""}`);
  }
  if (c.optionalGaps.length) {
    out("");
    out(`  Optional gaps — suggestions; they never affect the percentage:`);
    for (const g of c.optionalGaps) out(`   · ${g.id}  ${g.text}${g.from ? `  (${g.from})` : ""}`);
  }
  const { warnings } = validatePlan(plan);
  if (warnings.length) {
    out("");
    for (const w of warnings) out(`   ⚠ ${w}`);
  }
  out("");
  out(c.percent === 100 ? "  The plan is complete." : "  Run /plan-update to fill in the rest.");
  out("");
  process.exit(0);
}

/**
 * The questionnaire state /plan-update drives: which sections still need something, in order,
 * with the question to ask and what is already there. Emitting this as data rather than letting
 * the skill invent its own question order is what keeps every project's plan the same shape.
 */
function renderQuestions(plan) {
  const c = planCompleteness(plan);
  const byKey = new Map(c.sections.map((s) => [s.key, s]));
  const steps = QUESTION_SECTIONS.map((s) => {
    const st = byKey.get(s.key);
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      ask: s.ask,
      followUp: s.followUp ?? null,
      filled: st.filled,
      count: st.count,
      detail: st.detail,
      // "Thin" is the useful signal, not just empty: a section can be filled and still be
      // missing the thing that makes it usable (a verify method, an out-of-scope list).
      needsWork: !st.filled || !!st.detail,
      current: currentFor(plan, s.key),
    };
  });
  const gaps = plan.sections.gaps.filter((g) => (g.status ?? "open") === "open");

  if (JSON_OUT) return ok({ percent: c.percent, steps, gaps, next: steps.find((s) => s.needsWork)?.key ?? null });

  out("");
  out(`  Project plan — ${c.percent}% complete. Sections still needing work:`);
  out("");
  for (const s of steps.filter((x) => x.needsWork)) {
    out(`   ${s.label}`);
    out(`     ${s.ask}`);
    if (s.detail) out(`     (${s.detail})`);
    out("");
  }
  if (gaps.length) {
    out(`  ${gaps.length} open gap(s) to triage — see \`maestro plan status\`.`);
    out("");
  }
  process.exit(0);
}

function currentFor(plan, key) {
  const s = SECTION_BY_KEY.get(key);
  const v = plan.sections[key];
  if (s.kind === "prose") return { text: v.text, metrics: v.metrics };
  if (s.kind === "scope") return { in: v.in, out: v.out };
  return v;
}

function renderCoverage(plan) {
  const board = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : { tickets: [] };
  const archPath = join(paths.boardDir, "archive.json");
  const archive = existsSync(archPath) ? JSON.parse(readFileSync(archPath, "utf8")) : { tickets: [] };
  const rows = planCoverage(plan, board.tickets ?? [], archive.tickets ?? []);
  const uncovered = rows.filter((r) => !r.tickets.length);

  if (JSON_OUT) return ok({ rows, uncovered: uncovered.map((r) => r.id) });

  out("");
  if (!rows.length) {
    out("  The plan names no deliverables, use cases, requirements, or milestones yet — nothing to cover.");
    out("");
    process.exit(0);
  }
  for (const r of rows) {
    const mark = r.done ? "✓" : r.tickets.length ? "·" : "✗";
    out(`   ${mark} ${r.id.padEnd(8)} ${r.tickets.length ? r.tickets.join(", ") : "no ticket"}   ${r.text.slice(0, 60)}`);
  }
  out("");
  out(uncovered.length
    ? `  ${uncovered.length} plan item(s) with no ticket: ${uncovered.map((r) => r.id).join(", ")}`
    : "  Every plan item has a ticket.");
  out("");
  process.exit(0);
}

// ── Dispatch ────────────────────────────────────────────────────────────────────
main();

function main() {
const op = argv[0];
if (!op || op === "--help" || op === "-h" || op === "help") usage();
if (!OPS.has(op)) die(`Unknown op "${op}". Known: ${[...OPS].join(", ")}.`);

// An unparsable plan is the caller's to fix — never silently treated as an empty one, or the
// first write would replace a real plan with a blank.
let plan;
try { plan = readPlan(PLAN_PATH); } catch (e) { die(e.message, 1); }

switch (op) {
  case "version":
    return ok({ version: planVersion(PLAN_PATH), path: PLAN_PATH }, planVersion(PLAN_PATH));

  case "status":
    renderStatus(plan);
    break;

  case "questions":
    renderQuestions(plan);
    break;

  case "coverage":
    renderCoverage(plan);
    break;

  case "gate": {
    // The scope boundary as data, for callers that must apply it themselves — the orchestrate
    // Workflow can't import this module (a Workflow script has no filesystem access), so it
    // shells out here rather than asking an agent to interpret plan.json. Same authority,
    // no second reading of what "in scope" means.
    const items = planItems(plan);
    const inScopeIds = [...items.values()].filter((i) => TRACEABLE_PREFIXES.includes(i.prefix)).map((i) => i.id);
    const outIds = [...items.values()].filter((i) => i.prefix === "OUT").map((i) => i.id);
    const gating = planIsGating(plan);
    if (JSON_OUT) return ok({ gating, inScopeIds, outIds });
    out("");
    out(gating
      ? `  Scope gate ON — in scope: ${inScopeIds.join(", ") || "(none)"}${outIds.length ? `; out: ${outIds.join(", ")}` : ""}`
      : "  Scope gate OFF — the plan names no deliverable, use case, or requirement yet.");
    out("");
    process.exit(0);
    break;
  }

  case "show": {
    const key = flag("section");
    if (key && !SECTION_BY_KEY.has(key)) die(`Unknown section "${key}". Known: ${SECTION_KEYS.join(", ")}.`);
    if (JSON_OUT) return ok({ plan: key ? { [key]: plan.sections[key] } : plan });
    if (existsSync(paths.md) && !key) { out(readFileSync(paths.md, "utf8")); process.exit(0); }
    out(JSON.stringify(key ? plan.sections[key] : plan, null, 2));
    process.exit(0);
    break;
  }

  case "init": {
    if (existsSync(PLAN_PATH) && !has("force")) {
      die(`A plan already exists at ${PLAN_PATH}. Use \`maestro plan status\` to see it, or --force to reset it.`);
    }
    const r = write((p) => p, "plan-init");
    ok({ version: r.version, path: PLAN_PATH }, `plan created at ${PLAN_PATH} (0% complete — run /plan-update).`);
    break;
  }

  case "render": {
    const r = write((p) => p, "plan-render");
    ok({ version: r.version }, `plan.md re-rendered from plan.json.`);
    break;
  }

  case "set-goal": {
    const text = flag("text");
    const metrics = flagAll("metric");
    if (text == null && !metrics.length && !has("clear-metrics")) {
      die("Nothing to set — pass --text and/or --metric (repeatable).");
    }
    const r = write((p) => {
      if (text != null) p.sections.goal.text = text;
      if (has("clear-metrics")) p.sections.goal.metrics = [];
      // Append rather than replace: a questionnaire that adds one metric at a time must not
      // silently drop the ones already recorded.
      for (const m of metrics) if (!p.sections.goal.metrics.includes(m)) p.sections.goal.metrics.push(m);
      return p;
    }, "plan-set-goal");
    ok({ version: r.version, percent: planCompleteness(r.plan).percent }, `goal updated — plan now ${planCompleteness(r.plan).percent}% complete.`);
    break;
  }

  case "scope": {
    const ins = flagAll("in");
    const outs = flagAll("out");
    const removeIds = flagAll("remove-out");
    if (!ins.length && !outs.length && !removeIds.length) die("Nothing to set — pass --in and/or --out (both repeatable), or --remove-out <OUT-n>.");
    const added = [];
    const r = write((p) => {
      for (const x of ins) if (!p.sections.scope.in.includes(x)) p.sections.scope.in.push(x);
      for (const x of outs) {
        const id = nextOutId(p);
        p.sections.scope.out.push({ id, text: x });
        added.push(id);
      }
      if (removeIds.length) {
        p.sections.scope.out = p.sections.scope.out.filter((o) => !removeIds.includes(o.id));
      }
      return p;
    }, "plan-scope");
    ok({ version: r.version, added, percent: planCompleteness(r.plan).percent },
      `scope updated${added.length ? ` — out-of-scope ${added.join(", ")}` : ""}.`);
    break;
  }

  case "add": {
    const key = argv[1];
    const section = SECTION_BY_KEY.get(key);
    if (!section || section.kind !== "list") {
      die(`\`add\` takes a list section: ${PLAN_SECTIONS.filter((s) => s.kind === "list").map((s) => s.key).join(", ")}. For gaps use \`gap-add\`; for the goal use \`set-goal\`; for scope use \`scope\`.`);
    }
    const patch = itemPatch(section);
    if (!patch.text || isPlaceholder(patch.text)) die("--text is required, and must say something (a placeholder like \"TBD\" would count as filled without being filled).");
    let id;
    const r = write((p) => {
      id = nextId(p, key);
      p.sections[key].push({ id, ...patch });
      return p;
    }, `plan-add-${key}`);
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent }, `${id} added to ${section.label} — plan now ${c.percent}% complete.`);
    break;
  }

  case "edit": {
    const id = argv[1];
    if (!id) die("Which item? `maestro plan edit <ID> --text ...`");
    const key = sectionForId(id);
    if (!key || key === "scopeOut") die(`"${id}" is not an editable plan item id.`);
    const section = SECTION_BY_KEY.get(key);
    const patch = itemPatch(section);
    if (!Object.keys(patch).length) die(`Nothing to change — pass at least one of: ${["text", ...(section.fields ?? []), "notes"].map((f) => `--${f}`).join(" ")}.`);
    const r = write((p) => {
      const item = p.sections[key].find((i) => i.id === id);
      if (!item) throw new Error(`${id} is not in the plan.`);
      Object.assign(item, patch);
      return p;
    }, "plan-edit");
    ok({ version: r.version, id, percent: planCompleteness(r.plan).percent }, `${id} updated.`);
    break;
  }

  case "remove": {
    const id = argv[1];
    if (!id) die("Which item? `maestro plan remove <ID>`");
    const key = sectionForId(id);
    if (!key) die(`"${id}" is not a plan item id.`);

    // A removed requirement leaves every ticket that traced to it dangling — and the scope gate
    // would then refuse to run them. Say so rather than letting it be discovered at run time.
    const orphans = [];
    if (existsSync(DATA_PATH)) {
      try {
        const board = JSON.parse(readFileSync(DATA_PATH, "utf8"));
        for (const t of board.tickets ?? []) {
          if (Array.isArray(t.traces_to) && t.traces_to.includes(id)) orphans.push(t.id);
        }
      } catch { /* an unreadable board is the board validator's problem, not this op's */ }
    }
    if (orphans.length && !has("force")) {
      die(`${id} is traced to by ${orphans.join(", ")} — removing it puts those tickets out of scope. ` +
          `Re-trace them first, or pass --force.`, 1);
    }

    const r = write((p) => {
      if (key === "scopeOut") p.sections.scope.out = p.sections.scope.out.filter((o) => o.id !== id);
      else p.sections[key] = p.sections[key].filter((i) => i.id !== id);
      return p;
    }, "plan-remove");
    ok({ version: r.version, id, orphans, percent: planCompleteness(r.plan).percent },
      `${id} removed${orphans.length ? ` (${orphans.join(", ")} now trace to nothing)` : ""}.`);
    break;
  }

  case "gap-add": {
    const text = flag("text");
    const need = flag("need");
    const from = flag("from") ?? "";
    if (!text) die("--text is required.");
    if (!GAP_NEEDS.includes(need)) die(`--need must be one of: ${GAP_NEEDS.join(", ")}. "required" means the plan is incomplete without it and the completeness percentage should say so.`);

    // Reporting skills run repeatedly. Without this, every /atomic-report would file the same
    // gap again and the plan would fill with duplicates that each dock the percentage.
    const dup = plan.sections.gaps.find((g) => g.text.trim().toLowerCase() === text.trim().toLowerCase());
    if (dup) ok({ version: planVersion(PLAN_PATH), id: dup.id, duplicate: true }, `already raised as ${dup.id} — nothing added.`);

    let id;
    const r = write((p) => {
      id = nextId(p, "gaps");
      p.sections.gaps.push({ id, text, need, from, status: "open" });
      return p;
    }, "plan-gap-add");
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent },
      `${id} raised as ${need === "optional" ? "an" : "a"} ${need} gap — plan now ${c.percent}% complete.`);
    break;
  }

  case "gap-set": {
    const id = argv[1];
    if (!id) die("Which gap? `maestro plan gap-set <G-ID> --status accepted --resolved-as FR-7`");
    const status = flag("status");
    const need = flag("need");
    const resolvedAs = flag("resolved-as");
    if (status && !GAP_STATUSES.includes(status)) die(`--status must be one of: ${GAP_STATUSES.join(", ")}.`);
    if (need && !GAP_NEEDS.includes(need)) die(`--need must be one of: ${GAP_NEEDS.join(", ")}.`);
    if (!status && !need && !resolvedAs) die("Nothing to change — pass --status, --need, or --resolved-as.");
    const r = write((p) => {
      const g = p.sections.gaps.find((x) => x.id === id);
      if (!g) throw new Error(`${id} is not a gap in this plan.`);
      if (status) g.status = status;
      if (need) g.need = need;
      if (resolvedAs) g.resolvedAs = resolvedAs;
      return p;
    }, "plan-gap-set");
    const c = planCompleteness(r.plan);
    ok({ version: r.version, id, percent: c.percent }, `${id} updated — plan now ${c.percent}% complete.`);
    break;
  }
}
}
