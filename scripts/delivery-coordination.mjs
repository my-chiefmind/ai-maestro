import { git, requireValue, identifier, readRecord, writeRecord, deliverySettings, canonical } from './delivery-store.mjs';
import { assertNoConflictingWork } from './delivery-facts.mjs';


export function ownedRecord(s, id, owner, generation) {
  const current = readRecord(s, 'ownership', id);
  requireValue(current && current.record.ownerSessionId === owner && current.record.generation === generation,
    'Ownership is missing, belongs to another session, or has a stale generation.');
  return current;
}
export function acquireOwnership(context, options) {
  const s = deliverySettings(context, { write: true });
  if (!s) return null;
  identifier(options.owner, 'owner session'); identifier(options.requestId, 'claim request');
  const branch = git(s.repo, ['branch', '--show-current']);
  requireValue(options.branch === branch, 'Claim must name the current delivery worktree branch.');
  const ticket = context.data.tickets.find(t => t.id === options.id);
  requireValue(ticket, 'Ticket is not on the active board.');
  const previous = readRecord(s, 'ownership', options.id);
  if (previous) {
    requireValue(previous.record.ownerSessionId === options.owner && previous.record.claimRequestId === options.requestId &&
      previous.record.branch === branch && previous.record.state !== 'closed',
    'Ticket already has an owner; reconcile/resume the existing work.');
    requireValue(canonical(previous.record.schedule?.touches ?? []) === canonical(ticket.touches ?? []),
      'Declared scope changed; expand and reconcile the owned scope before resuming.');
    return previous;
  }
  assertNoConflictingWork(s, options.id, branch, { resume: options.resume, repairOf: options.repairOf });
  return writeRecord(s, 'ownership', options.id, null, { ownerSessionId: options.owner,
    claimRequestId: options.requestId, branch, generation: 1, state: 'claimed',
    schedule: { id: ticket.id, touches: ticket.touches ?? [], area: ticket.area, epicId: ticket.epicId }, dispatch: null, history: [], createdAt: new Date().toISOString() }, { dryRun: options.dryRun === true });
}

/** Every recovery operation fences the previous generation. No elapsed-time takeover. */
export function transferRecord(s, { id, owner, generation, newOwner, evidence }) {
  const prior = ownedRecord(s, id, owner, generation);
  identifier(newOwner, 'new owner');
  requireValue(evidence && typeof evidence === 'string', 'Verified transfer evidence is required.');
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Uncertain or running worker must be reconciled before transfer.');
  requireValue(!prior.record.submission || prior.record.pr, 'Uncertain submission must be reconciled before transfer.');
  return writeRecord(s, 'ownership', id, prior.oid, { ...prior.record, ownerSessionId: newOwner,
    generation: generation + 1, gate: null, transferEvidence: evidence });
}
export function expandScope(s, { id, owner, generation, schedule }) {
  const prior = ownedRecord(s, id, owner, generation);
  requireValue(schedule?.id === id && Array.isArray(schedule.touches), 'Scope must identify the owned ticket.');
  // Expansion never releases a previously granted scope. An empty scope means
  // unknown/exclusive and cannot be narrowed by this operation either.
  const granted = prior.record.schedule?.touches ?? [];
  const touches = granted.length && schedule.touches.length ? [...new Set([...granted, ...schedule.touches])] : [];
  return writeRecord(s, 'ownership', id, prior.oid, { ...prior.record,
    schedule: { ...schedule, touches }, gate: null, qa: null });
}
