#!/usr/bin/env node
// @ts-check
/**
 * usage-attribute.mjs — decide which ticket a transcript turn belongs to, and say how sure
 * we are.
 *
 * Historical attribution is inference, not measurement, and the dashboard is worthless if it
 * hides that. So every turn lands with a CONFIDENCE and the EVIDENCE that produced it, and a
 * turn we cannot justify is left `unassigned` rather than guessed at:
 *
 *   exact       a run telemetry record measured it            (scripts/telemetry-io.mjs)
 *   high        the git branch names the ticket               (`codex/t-029-...`)
 *   high        the session ran a board write for the ticket  (`set-status`, `archive`, ...)
 *   medium      the ticket was named, and it exists on the board
 *   unassigned  nothing above applied
 *
 * Two rules keep this honest, both learned from a naive first pass that credited `T-042` and
 * `T-999` — a doc example and a test fixture — with 150M tokens between them:
 *
 *   1. REJECT IDS THAT ARE NOT REAL. An id is only usable if `board/data.json` or
 *      `board/archive.json` actually defines it. `ticketIndex()` builds that set.
 *   2. NEVER "LAST MENTION WINS" ON ITS OWN. A bare mention is the weakest rung and it
 *      EXPIRES — after `mentionTtlMs` of silence or `mentionTtlTurns` turns without being
 *      renamed. Otherwise one aside at turn 5 would bill the next five hundred turns to it.
 *
 *      With ONE exception, and it is the reason the TTL exists rather than an escape from it:
 *      expiry protects against picking the WRONG ticket out of several in play. A session
 *      whose entire evidence names exactly one real ticket has no competitor to be confused
 *      with, so the mention holds for the session. It stays `medium` — one candidate is not
 *      proof, only an absence of ambiguity — and a session that names a second real ticket
 *      falls back to the expiring rule for every turn, including the ones already seen.
 *
 * A long idle gap also resets the soft signals (`idleResetMs`): a session resumed the next
 * morning is new work, not a continuation. The branch survives a reset because it is
 * structural — the checkout is still what it was.
 */

/** @typedef {import("./usage-scan.mjs").UsageEvent} UsageEvent */
/** @typedef {import("./usage-scan.mjs").Usage} Usage */

/** Ordered strongest-first; `rank()` compares by index. */
export const CONFIDENCE = ["exact", "high", "medium", "unassigned"];

/** @param {string} c */
export const rank = (c) => {
  const i = CONFIDENCE.indexOf(c);
  return i === -1 ? CONFIDENCE.length : i;
};

/** Board writes that prove work on a ticket, as opposed to merely referring to one. */
const STRONG_VERBS = new Set(["set-status", "archive", "block", "run"]);

export const DEFAULTS = {
  /** A gap longer than this between turns is idle time, not agent work. */
  idleCapMs: 5 * 60 * 1000,
  /** Silence long enough that the next turn is a fresh piece of work. */
  idleResetMs: 2 * 60 * 60 * 1000,
  /** How long a bare mention keeps attributing turns to its ticket. */
  mentionTtlMs: 30 * 60 * 1000,
  /** ...and how many turns, whichever runs out first. */
  mentionTtlTurns: 40,
};

/**
 * The set of ticket ids that actually exist, live or archived, with the facts the dashboard
 * shows next to a row. This is the gate every inferred id must pass.
 * @param {{ tickets?: any[], epics?: any[] } | null} data
 * @param {{ tickets?: any[], epics?: any[] } | null} archive
 */
export function ticketIndex(data, archive) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const epics = new Map();
  for (const src of [data, archive]) {
    for (const e of src?.epics || []) if (e?.id) epics.set(e.id, e.name || e.id);
  }
  /** Lowercased id -> canonical id, so a branch's `t-029` resolves to the board's `T-029`. */
  const byLower = new Map();
  for (const [src, archived] of /** @type {const} */ ([[data, false], [archive, true]])) {
    for (const t of src?.tickets || []) {
      if (!t?.id || byId.has(t.id)) continue;
      byLower.set(String(t.id).toLowerCase(), t.id);
      byId.set(t.id, {
        id: t.id,
        name: t.name || "",
        status: t.status || "",
        area: t.area || "",
        epicId: t.epicId || "",
        epicName: t.epicId ? epics.get(t.epicId) || "" : "",
        model: t.model || "",
        agentPlan: Array.isArray(t.agent_plan) ? t.agent_plan : [],
        executionMode: t.execution_mode || "",
        swag: t.swag || "",
        priority: t.priority || "",
        doneAt: t.done_at || null,
        archived,
      });
    }
  }
  // Carried on the Map so every consumer resolves ids the same way without a second argument.
  /** @type {any} */ (byId).byLower = byLower;
  return byId;
}

/**
 * Resolve a possibly differently-cased id to the board's own spelling, or null.
 * @param {Map<string, any>} index @param {string} id
 */
export function canonicalId(index, id) {
  if (index.has(id)) return id;
  const lower = /** @type {any} */ (index).byLower;
  return lower?.get(String(id).toLowerCase()) ?? null;
}

/**
 * Pull a ticket id out of a branch name (`codex/t-029-initiative-plan-core` -> `T-029`,
 * `feature/kit-096-fix` -> `kit-096`).
 *
 * The prefix is whatever the board uses, so candidates are matched loosely and then resolved
 * against the index — a branch cannot invent a ticket. Case-insensitive, because branch
 * conventions lowercase ids that the board spells in caps.
 * @param {string | null} branch
 * @param {Map<string, any>} [index]
 */
export function ticketFromBranch(branch, index) {
  if (!branch) return null;
  const candidates = branch.match(/[A-Za-z][A-Za-z0-9]{0,7}-\d{1,5}/g);
  if (!candidates) return null;
  if (!index) {
    const t = candidates.find((c) => /^t-\d+$/i.test(c));
    return t ? `T-${t.split("-")[1]}` : null;
  }
  for (const c of candidates) {
    const id = canonicalId(index, c);
    if (id) return id;
  }
  return null;
}

/**
 * Assign every turn in `events` to a ticket.
 *
 * Events must be the full stream for the roots being reported on; they are grouped by session
 * and replayed in order, because attribution is stateful — a `set-status` at turn 10 explains
 * turn 11, and nothing before it.
 *
 * @param {UsageEvent[]} events
 * @param {Map<string, any>} index          Real tickets, from `ticketIndex()`.
 * @param {{ exactSessions?: Set<string> } & Partial<typeof DEFAULTS>} [opts]
 *        `exactSessions` are sessions already measured by run telemetry; their turns are
 *        dropped here so the unified report cannot count the same work twice.
 */
export function attribute(events, index, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const exactSessions = opts.exactSessions || new Set();

  /** @type {Map<string, UsageEvent[]>} */
  const bySession = new Map();
  for (const e of events) {
    if (exactSessions.has(e.sessionId)) continue;
    let arr = bySession.get(e.sessionId);
    if (!arr) bySession.set(e.sessionId, (arr = []));
    arr.push(e);
  }

  /** @type {Array<{ ts: number, ticketId: string | null, confidence: string, evidence: string | null, model: string, agentType: string, sessionId: string, branch: string | null, usage: Usage, activeMs: number }>} */
  const turns = [];
  let skippedExact = 0;
  for (const e of events) if (exactSessions.has(e.sessionId) && e.kind === "turn") skippedExact++;

  for (const [sessionId, stream] of bySession) {
    stream.sort((a, b) => a.ts - b.ts);

    // Which real tickets does this session name at all? One candidate means an unexpiring
    // mention is unambiguous rather than a guess; two or more and the TTL does its job.
    const candidates = new Set();
    for (const e of stream) {
      for (const raw of e.mentions) { const id = canonicalId(index, raw); if (id) candidates.add(id); }
      for (const c of e.commands) { const id = canonicalId(index, c.id); if (id) candidates.add(id); }
    }
    const soleCandidate = candidates.size === 1;

    /** @type {string | null} */ let branchTicket = null;
    /** @type {{ id: string, verb: string, ts: number } | null} */ let command = null;
    /** @type {{ id: string, ts: number, turns: number } | null} */ let mention = null;
    let prevTs = null;
    let sawSignal = false;
    /** @type {number | null} */ let prevTurnTs = null;

    for (const e of stream) {
      if (prevTs !== null && e.ts - prevTs > cfg.idleResetMs) { command = null; mention = null; prevTurnTs = null; }
      prevTs = e.ts;

      // Branch: structural, and re-read on every event so a mid-session checkout is honoured.
      branchTicket = ticketFromBranch(e.branch, index);

      for (const c of e.commands) {
        const id = canonicalId(index, c.id);
        if (!id) continue;
        if (STRONG_VERBS.has(c.verb)) command = { id, verb: c.verb, ts: e.ts };
        else mention = { id, ts: e.ts, turns: 0 };
      }
      for (const raw of e.mentions) {
        const id = canonicalId(index, raw);
        if (id) mention = { id, ts: e.ts, turns: 0 };
      }

      if (e.kind !== "turn" || !e.usage || !e.model) continue;

      if (mention && !soleCandidate) {
        mention.turns++;
        if (e.ts - mention.ts > cfg.mentionTtlMs || mention.turns > cfg.mentionTtlTurns) mention = null;
      }

      let ticketId = null, confidence = "unassigned", evidence = null;
      if (branchTicket) { ticketId = branchTicket; confidence = "high"; evidence = "branch"; }
      else if (command) { ticketId = command.id; confidence = "high"; evidence = `board-write:${command.verb}`; }
      else if (mention) { ticketId = mention.id; confidence = "medium"; evidence = soleCandidate ? "mention:sole-in-session" : "mention"; }
      else {
        // Say WHY, because the three reasons mean very different things and only one of them
        // is a shortcoming of this engine. "no-ticket-in-session" is a finding about the work
        // itself — agent time that was never tied to a ticket — and rolling it in with
        // genuinely ambiguous turns would hide the most useful number on the page.
        evidence = candidates.size === 0 ? "no-ticket-in-session"
          : sawSignal ? "signal-expired"
          : "before-first-signal";
      }
      if (ticketId) sawSignal = true;

      // Active time is the gap since the previous turn IN THIS SESSION, capped, and credited
      // to the ticket the current turn belongs to. Gating it on the two turns sharing a ticket
      // looks tidier and silently discards most of the clock: with attribution flipping in and
      // out of `unassigned`, adjacent turns usually differ, and the elapsed work vanishes.
      // A gap longer than the cap is the human being elsewhere, so it is truncated, not kept.
      const activeMs = prevTurnTs === null ? 0 : Math.min(e.ts - prevTurnTs, cfg.idleCapMs);
      prevTurnTs = e.ts;

      turns.push({
        ts: e.ts, ticketId, confidence, evidence,
        model: e.model, agentType: e.agentType || "main",
        sessionId, branch: e.branch, usage: e.usage, activeMs,
      });
    }
  }

  turns.sort((a, b) => a.ts - b.ts);
  const byConfidence = /** @type {Record<string, number>} */ ({});
  const unassignedReasons = /** @type {Record<string, number>} */ ({});
  for (const t of turns) {
    byConfidence[t.confidence] = (byConfidence[t.confidence] || 0) + 1;
    if (!t.ticketId && t.evidence) unassignedReasons[t.evidence] = (unassignedReasons[t.evidence] || 0) + 1;
  }
  return {
    turns,
    coverage: {
      turns: turns.length,
      attributed: turns.filter((t) => t.ticketId).length,
      byConfidence,
      unassignedReasons,
      skippedExact,
    },
  };
}
