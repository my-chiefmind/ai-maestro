/**
 * lane-core.mjs — how work is parallelised without turning the merge into the hard part.
 *
 * THE PROBLEM. Both obvious answers are bad. One worktree means no parallelism at all. A
 * worktree per ticket means ten or fifteen long-lived branches whose merge order nobody
 * planned — and merge pain grows with (branches alive) × (files they share) × (how long they
 * live), so that arrangement maximises all three at once.
 *
 * THE MODEL. A small fixed pool of LANES. A lane is a persistent worktree that runs a QUEUE of
 * tickets one after another, landing each before starting the next. That inverts every term:
 *
 *   - branches alive  = number of lanes (capped, default 3), not number of tickets;
 *   - files shared    = zero between lanes, by construction — assignment refuses to put two
 *                       tickets that could touch the same files in different lanes;
 *   - how long live   = one ticket, because a lane merges and re-bases before its next.
 *
 * Tickets inside a lane cannot conflict with each other: they run sequentially in the same
 * tree, each starting from a freshly-updated base. So the only conflicts possible are BETWEEN
 * lanes, and that is exactly what this module's assignment rule exists to prevent.
 *
 * THE CONFLICT DOMAIN. Two tickets belong in the same lane when they might touch the same
 * files. In descending order of confidence:
 *
 *   1. `touches` globs on the ticket — an explicit declaration by whoever planned it;
 *   2. `epicId`  — work in one epic overwhelmingly lands in the same code;
 *   3. `area`    — the coarse fallback, and the reason `area` is worth setting.
 *
 * Every judgment call here resolves toward SEQUENTIAL. A wrong "these are independent" costs a
 * conflicted merge and lost work; a wrong "these are related" costs some wall-clock. Those are
 * not comparable, so this module never guesses in the expensive direction.
 *
 * Pure functions, no I/O — the CLI, the validator, and the orchestrator all read one answer.
 */

/** Hard ceiling regardless of config. Past this, a human cannot hold the state in their head. */
export const MAX_LANES = 5;
export const DEFAULT_LANES = 3;

/**
 * Files whose merge semantics are hostile no matter how careful the plan is: a lockfile, a
 * migration sequence, a generated schema, the board itself. A ticket touching one takes the
 * whole pool. Projects extend this with `orchestration.serialFiles`.
 */
export const DEFAULT_SERIAL_FILES = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/Cargo.lock",
  "**/poetry.lock", "**/Gemfile.lock", "**/go.sum",
  "**/migrations/**", "**/schema.prisma", "**/db/schema.rb",
];

/** @param {object|null} config @returns {number} */
export function laneCount(config) {
  const raw = config?.orchestration?.maxWorktrees;
  const n = Number.isInteger(raw) ? raw : DEFAULT_LANES;
  return Math.max(1, Math.min(MAX_LANES, n));
}

/** @param {object|null} config @returns {string[]} */
export function serialFiles(config) {
  const extra = config?.orchestration?.serialFiles;
  return [...DEFAULT_SERIAL_FILES, ...(Array.isArray(extra) ? extra : [])];
}

// ── Glob matching ───────────────────────────────────────────────────────────────

/** A glob as a RegExp. Supports `**`, `*` and `?`; everything else is literal. */
function globToRe(glob) {
  let out = "";
  const g = String(glob).replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { out += ".*"; i++; if (g[i + 1] === "/") i++; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** @param {string} path @param {string} glob */
export function globMatches(path, glob) {
  return globToRe(glob).test(String(path).replace(/^\.\//, ""));
}

/** The literal leading directory of a glob — everything before the first wildcard. */
function literalPrefix(glob) {
  const g = String(glob).replace(/^\.\//, "");
  const i = g.search(/[*?]/);
  const head = i === -1 ? g : g.slice(0, i);
  return head.slice(0, head.lastIndexOf("/") + 1);
}

/**
 * The path segments a glob states literally — `db/migrations/**` → ["db", "migrations"].
 *
 * These are what a matching path MUST contain, which makes them the usable signal for globs
 * that start with a wildcard, where the leading-prefix rule degenerates to "matches anything".
 */
function literalSegments(glob) {
  return String(glob).replace(/^\.\//, "").split("/").filter((seg) => seg && !/[*?]/.test(seg));
}

/**
 * Could two globs ever match the same path?
 *
 * Deliberately conservative: it answers "definitely disjoint" or "assume they overlap". Two
 * globs are treated as disjoint only when neither's literal directory prefix contains the
 * other — `src/api/**` vs `src/web/**` is provably safe, `src/**` vs `src/api/**` is not, and
 * anything this can't decide comes back true. Being wrong toward "overlap" costs wall-clock;
 * being wrong the other way costs a conflicted merge.
 */
export function globsIntersect(a, b) {
  if (a === b) return true;
  if (globMatches(a, b) || globMatches(b, a)) return true;

  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  // Both anchored to a real directory: one containing the other is the overlap case.
  if (pa !== "" && pb !== "") return pa.startsWith(pb) || pb.startsWith(pa);

  // At least one starts with a wildcard (`**/migrations/**`), so its leading prefix says
  // nothing. Fall back to the segments it insists on: a glob that requires "migrations" and one
  // that requires "api" cannot describe the same file. A glob with no literal segments at all
  // (`**`) constrains nothing, so it overlaps everything.
  const sa = literalSegments(a);
  const sb = literalSegments(b);
  if (!sa.length || !sb.length) return true;
  return sa.some((x) => sb.includes(x));
}

/** @param {string[]} a @param {string[]} b */
export function globSetsIntersect(a, b) {
  for (const x of a) for (const y of b) if (globsIntersect(x, y)) return true;
  return false;
}

/**
 * Does this ticket touch a file the project says must never be edited in parallel?
 *
 * Matched on the serial pattern's LITERAL segments — `migrations`, `package-lock.json` — rather
 * than on "could this glob conceivably reach one". Technically `src/**` could contain
 * `src/migrations/`, but treating it that way makes every ticket serial and the pool pointless.
 * The rule is: a ticket is serial when its declaration SAYS so. That is consistent with the
 * rest of the module — declaring what you touch is what buys you parallelism, and what makes
 * you honest about the parts that can't have it.
 */
export function touchesSerialFile(ticket, config) {
  const declared = touchesOf(ticket);
  if (!declared.length) return false;
  for (const serial of serialFiles(config)) {
    const needed = literalSegments(serial);
    if (!needed.length) continue;
    for (const glob of declared) {
      if (globMatches(glob, serial)) return true;
      const has = literalSegments(glob);
      if (needed.every((seg) => has.includes(seg))) return true;
    }
  }
  return false;
}

/** A ticket's declared file scope, normalised. Empty when it never declared one. */
export function touchesOf(ticket) {
  const t = ticket?.touches;
  return Array.isArray(t) ? t.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
}

// ── Conflict domains ────────────────────────────────────────────────────────────

/**
 * Why two tickets must share a lane, or null when they may run in parallel.
 *
 * Order matters: the strongest evidence is checked first, and an explicit `touches` on BOTH
 * sides is the only thing that can override the epic/area heuristics. That is the incentive —
 * declare what you touch and you get parallelism; stay vague and you get correctness.
 *
 * @returns {string|null} a human-readable reason, or null if independent
 */
export function conflictReason(a, b, config = null) {
  if (a.id === b.id) return "same ticket";

  // A dependency is a code relationship, not just an ordering one: the dependent builds ON the
  // other's changes, so it belongs in the same tree, after it.
  const dependsEitherWay =
    (Array.isArray(a.depends_on) ? a.depends_on : []).includes(b.id) ||
    (Array.isArray(b.depends_on) ? b.depends_on : []).includes(a.id);
  if (dependsEitherWay) return `${a.id} and ${b.id} are dependency-related`;

  if (touchesSerialFile(a, config)) return `${a.id} touches a serial-only file`;
  if (touchesSerialFile(b, config)) return `${b.id} touches a serial-only file`;

  const ta = touchesOf(a);
  const tb = touchesOf(b);
  if (ta.length && tb.length) {
    // Both declared. This is the ONLY path that can prove independence across an epic or area.
    return globSetsIntersect(ta, tb)
      ? `${a.id} and ${b.id} declare overlapping file scopes`
      : null;
  }

  if (a.epicId && b.epicId && a.epicId === b.epicId) {
    return `${a.id} and ${b.id} are in epic ${a.epicId} and don't both declare \`touches\``;
  }
  if (a.area && b.area && a.area === b.area) {
    return `${a.id} and ${b.id} are both in area "${a.area}" and don't both declare \`touches\``;
  }
  // Different area, different epic, nothing declared: the weakest independence claim this
  // module will make, and the reason `area` is worth setting on every ticket.
  if (!a.area || !b.area) {
    return `${a.id} or ${b.id} has no area and no \`touches\` — nothing proves they are independent`;
  }
  return null;
}

/** @returns {boolean} */
export function canRunInParallel(a, b, config = null) {
  return conflictReason(a, b, config) === null;
}

// ── Assignment ──────────────────────────────────────────────────────────────────

/**
 * Schedule ready tickets into lanes.
 *
 * Greedy and DETERMINISTIC — same board in, same schedule out, so the CLI's preview is exactly
 * what the orchestrator will do. Tickets are considered in the caller's order (priority, then
 * board order); each either joins the first lane it conflicts with, or opens a new lane, or —
 * when the pool is full — queues behind the lane it conflicts with least.
 *
 * A serial-file ticket is special-cased into an exclusive lane: it runs alone, with the rest of
 * the pool drained first. Migrations and lockfiles are where "we merged five branches" goes
 * wrong, and no heuristic makes them safe.
 *
 * @param {any[]} ready tickets already filtered for eligibility (deps met, gate cleared, in scope)
 * @param {object|null} config
 * @returns {{lanes: Array<{index:number, tickets:any[], reason:string, exclusive:boolean}>, capped:boolean, max:number}}
 */
export function assignLanes(ready, config = null) {
  const max = laneCount(config);
  /** @type {Array<{index:number, tickets:any[], reason:string, exclusive:boolean}>} */
  const lanes = [];

  for (const ticket of ready) {
    if (touchesSerialFile(ticket, config)) {
      // Its own lane, flagged exclusive. The runner drains everything else before starting it.
      lanes.push({ index: lanes.length + 1, tickets: [ticket], reason: `${ticket.id} touches a serial-only file — runs alone`, exclusive: true });
      continue;
    }

    // First lane this ticket conflicts with: it must go there, and after what's already queued.
    const conflicting = lanes.find((l) => !l.exclusive && l.tickets.some((t) => conflictReason(ticket, t, config)));
    if (conflicting) {
      const why = conflicting.tickets.map((t) => conflictReason(ticket, t, config)).find(Boolean);
      conflicting.tickets.push(ticket);
      if (!conflicting.reason) conflicting.reason = why ?? "";
      continue;
    }

    if (lanes.length < max) {
      lanes.push({ index: lanes.length + 1, tickets: [ticket], reason: "", exclusive: false });
      continue;
    }

    // Pool full and nothing conflicts: park it on the shortest lane. It is independent of that
    // lane's work, so running it there is merely slower — never unsafe.
    const shortest = lanes
      .filter((l) => !l.exclusive)
      .sort((x, y) => x.tickets.length - y.tickets.length || x.index - y.index)[0] ?? lanes[0];
    shortest.tickets.push(ticket);
    if (!shortest.reason) shortest.reason = `pool is full at ${max} lanes`;
  }

  return { lanes, capped: ready.length > 0 && lanes.length >= max, max };
}

/**
 * The tickets that may start RIGHT NOW: the head of each lane, minus everything an exclusive
 * ticket blocks. This is what an orchestrator dispatches.
 *
 * @returns {{start: any[], exclusive: any|null, waiting: any[]}}
 */
export function startableNow(ready, config = null) {
  const { lanes } = assignLanes(ready, config);
  const heads = lanes.map((l) => ({ lane: l, ticket: l.tickets[0] })).filter((h) => h.ticket);

  const exclusiveHead = heads.find((h) => h.lane.exclusive);
  const others = heads.filter((h) => !h.lane.exclusive);

  // An exclusive ticket may only start when nothing else is running. If other lanes have work,
  // they go first and the exclusive one waits — draining is always safe, starting is not.
  if (exclusiveHead && others.length === 0) {
    return { start: [exclusiveHead.ticket], exclusive: exclusiveHead.ticket, waiting: [] };
  }
  return {
    start: others.map((h) => h.ticket),
    exclusive: null,
    waiting: exclusiveHead ? [exclusiveHead.ticket] : [],
  };
}

/**
 * Tickets that could have run in parallel but won't, only because they never declared what they
 * touch. This is the actionable half of the scheduler: `touches` is the one thing an author can
 * add to make their work parallelisable.
 *
 * @returns {Array<{a:string, b:string, reason:string}>}
 */
export function parallelismLostToVagueness(ready, config = null) {
  const out = [];
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const a = ready[i], b = ready[j];
      const reason = conflictReason(a, b, config);
      if (!reason) continue;
      if (!/don't both declare|no area and no/.test(reason)) continue; // a real conflict, not vagueness
      out.push({ a: a.id, b: b.id, reason });
    }
  }
  return out;
}
