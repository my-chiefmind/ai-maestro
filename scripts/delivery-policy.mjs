/** Delivery contracts and board transitions. No network calls or agent-inferred completion. */
import { digest, canonical, requireValue } from './delivery-values.mjs';

export const DELIVERY_PHASES = ['implementing', 'qa', 'repair-required', 'ready-for-human-review',
  'awaiting-dev-acceptance', 'ready-for-closure'];
export const REQUIRED_GATES = ['scope', 'plan', 'security', 'warnings', 'dependencies', 'human'];
export function criteriaFor(ticket) {
  const criteria = ticket.acceptanceCriteria;
  requireValue(Array.isArray(criteria) && criteria.length > 0, 'Guarded tickets require explicit acceptanceCriteria.');
  const ids = new Set();
  for (const row of criteria) {
    requireValue(row && typeof row.id === 'string' && /^[A-Za-z0-9_-]+$/.test(row.id) && !ids.has(row.id) &&
      typeof row.text === 'string' && row.text.trim() && ['pre-merge', 'post-deploy'].includes(row.phase),
    'Acceptance criteria need unique ids, text, and a pre-merge or post-deploy phase.');
    ids.add(row.id);
  }
  return criteria;
}
export function approvalFor(approval, action, target, options = {}) {
  requireValue(approval?.action === action && approval.target === target &&
    typeof approval.reference === 'string' && approval.reference.trim() &&
    typeof approval.reason === 'string' && approval.reason.trim(),
  `Explicit ${action} approval for ${target}, with reference and reason, is required.`);
  const trusted = options.resolveApproval ? options.resolveApproval(approval.reference) :
    (options.trustedApprovals ?? options.policy?.trustedApprovals)?.[approval.reference];
  requireValue(trusted && !(trusted instanceof Promise) && trusted.action === action && trusted.target === target &&
    trusted.approved === true && typeof trusted.authority === 'string' && trusted.authority.trim() &&
    (!options.scopeDigest || trusted.scopeDigest === options.scopeDigest), 'Approval reference is not trusted for this action, target and scope.');
  return trusted;
}
export function verifyRows(expected, rows, ticketId, options = {}) {
  requireValue(Array.isArray(rows), 'Criterion results are required.');
  requireValue(new Set(rows.map(r => r.id)).size === rows.length, 'Duplicate criterion results.');
  for (const criterion of expected) {
    const row = rows.find(r => r.id === criterion.id);
    requireValue(row && typeof row.evidence === 'string' && row.evidence.trim(), `Missing evidence for ${criterion.id}.`);
    if (row.status === 'WAIVED') approvalFor(row.approval, 'waive', `${ticketId}:${criterion.id}`, options);
    else requireValue(row.status === 'PASS', `${criterion.id} is ${row.status ?? 'NOT RUN'}; required criteria are incomplete.`);
  }
  requireValue(rows.every(r => expected.some(c => c.id === r.id)), 'Results contain unknown or out-of-phase criteria.');
}
export function scopeDigest(ticket, { spec = '', planItems = [], policy = {} } = {}) {
  // Evidence and coordination may advance; requirements, routing and test commands may not.
  const { status, evidence, delivery, currentAgent, nextAgent, ...scope } = ticket;
  return digest({ scope, spec, planItems, policy });
}
/** Approval binds both the original requirements and the exact proposed replacement. */
export function contractChangeDigest(before, proposed) {
  requireValue(before?.id && before.id === proposed?.id, 'Contract change must retain the ticket identity.');
  criteriaFor(before); criteriaFor(proposed);
  return digest({ action: 'change-contract', ticketId: before.id, before: scopeDigest(before), proposed: scopeDigest(proposed) });
}
export function validateQa(ticket, qa, scope, options = {}) {
  const { checks = [], gates = REQUIRED_GATES } = options;
  criteriaFor(ticket);
  requireValue(qa?.ticketId === ticket.id && qa.verdict === 'PASS' && qa.scopeDigest === scope,
    'QA verdict is missing, failed, or does not match the current scope.');
  requireValue(typeof qa.reviewerIdentity === 'string' && qa.reviewerIdentity.trim() &&
    typeof qa.implementationIdentity === 'string' && qa.implementationIdentity.trim() &&
    qa.reviewerIdentity !== qa.implementationIdentity, 'Independent reviewer identity is required.');
  requireValue(/^[a-f0-9]{40,64}$/.test(qa.reviewedCodeSha ?? ''), 'QA must identify the full reviewed code SHA.');
  verifyRows(criteriaFor(ticket).filter(c => c.phase === 'pre-merge'), qa.criteria, ticket.id, { ...options, scopeDigest: scope });
  for (const id of gates) {
    const row = qa.gates?.[id];
    requireValue(row?.status === 'PASS' && typeof row.evidence === 'string' && row.evidence.trim(), `Missing or failed ${id} release gate.`);
  }
  requireValue(Array.isArray(qa.checks) && qa.checks.length > 0, 'Executed QA checks are required.');
  for (const command of checks) {
    const row = qa.checks.find(c => c.command === command);
    requireValue(row?.exitCode === 0 && row.revision === qa.reviewedCodeSha &&
      typeof row.evidence === 'string' && row.evidence.trim(), `Missing executed QA command: ${command}`);
  }
}
export function validateCompletion(ticket, acceptance, approval, merged, options = {}) {
  if (options.policy?.requireClosureApproval || approval) approvalFor(approval, 'complete', ticket.id, { ...options, scopeDigest: merged?.scopeDigest });
  requireValue(merged?.head && merged?.mergeSha && merged?.pr, 'Verified human merge evidence is required.');
  requireValue(acceptance?.ticketId === ticket.id && acceptance.mergeSha === merged.mergeSha &&
    acceptance.deliveryHead === merged.head && acceptance.scopeDigest === merged.scopeDigest,
  'Acceptance does not match the merged delivery and scope.');
  verifyRows(criteriaFor(ticket), acceptance.criteria, ticket.id, { ...options, scopeDigest: merged.scopeDigest });
  if (criteriaFor(ticket).some(c => c.phase === 'post-deploy')) {
    requireValue(acceptance.release?.revision === merged.mergeSha && acceptance.release?.artifact &&
      acceptance.release?.environment && acceptance.release?.evidence,
    'Post-deploy acceptance requires release artifact, environment, exact merged revision, and evidence.');
  }
  requireValue(Array.isArray(acceptance.checks) && acceptance.checks.length &&
    acceptance.checks.every(c => c.status === 'PASS' && c.evidence), 'Executed completion checks are required.');
}
export function assertEvidenceChange(before, after, id) {
  requireValue(before && after && Array.isArray(before.tickets) && Array.isArray(after.tickets), 'Invalid board evidence change.');
  const strip = board => ({ ...board, tickets: board.tickets.map(t => {
    if (t.id !== id) return t;
    const { evidence, delivery, status, ...rest } = t; return rest;
  }) });
  requireValue(canonical(strip(before)) === canonical(strip(after)), 'Post-QA board changes may only update this ticket evidence and delivery metadata.');
  const old = before.tickets.find(t => t.id === id), next = after.tickets.find(t => t.id === id);
  requireValue(old && next && ['in-progress', 'review', 'blocked'].includes(next.status), 'Post-QA board status cannot claim completion.');
  requireValue(!old.evidence || (typeof next.evidence === 'string' && next.evidence.startsWith(old.evidence)), 'Existing evidence must be preserved.');
  requireValue(!old.delivery || next.delivery, 'Existing delivery evidence must be preserved.');
  if (next.delivery) {
    for (const key of ['reviewedCodeSha', 'qaDigest', 'report']) {
      requireValue(old.delivery?.[key] == null || canonical(old.delivery[key]) === canonical(next.delivery[key]), 'Existing delivery attestations cannot be replaced.');
    }
    requireValue(Object.keys(next.delivery).every(k => ['phase', 'reviewedCodeSha', 'qaDigest', 'report', 'evidence'].includes(k)), 'Unexpected delivery metadata field.');
    requireValue(['qa', 'repair-required', 'ready-for-human-review'].includes(next.delivery.phase), 'Post-QA delivery phase requires a separate merge/acceptance operation.');
    const previous = old.delivery?.evidence ?? [];
    requireValue(Array.isArray(next.delivery.evidence ?? []) && canonical((next.delivery.evidence ?? []).slice(0, previous.length)) === canonical(previous), 'Delivery evidence must be append-only.');
  }
}

/** Verdicts preserve the detailed refusal without converting missing evidence to success. */
export function mergeReadiness(ticket, qa, scope, options = {}) {
  try {
    validateQa(ticket, qa, scope, options);
    return { ready: true, reasons: [] };
  } catch (error) {
    return { ready: false, reasons: [error.message] };
  }
}
export function completion(ticket, acceptance, approval, merged, options = {}) {
  try {
    validateCompletion(ticket, acceptance, approval, merged, options);
    return { complete: true, reasons: [] };
  } catch (error) {
    return { complete: false, reasons: [error.message] };
  }
}
export const guardedDelivery = context => context.config?.delivery?.enabled === true;

/**
 * Validate and apply delivery metadata changes to `after` while the board lock is held.
 * Mutates restored/changed active tickets and completed archive records in place; callers
 * persist the resulting board only after the complete transition passes validation.
 */
export function applyGuardedBoardTransition(context, before, after, options = {}) {
  if (!guardedDelivery(context)) return;
  const policy = context.config.delivery;
  const trust = { policy, resolveApproval: options.resolveApproval };
  for (const ticket of after.data.tickets ?? []) {
    criteriaFor(ticket);
    requireValue(ticket.status !== 'done', 'Guarded completion must use archive with verified delivery evidence.');
    const old = before.data.tickets?.find(t => t.id === ticket.id);
    if (!old) {
      const restored = before.archive.tickets?.find(t => t.id === ticket.id);
      requireValue(restored || policy.coordination !== 'git' || options.reservationVerified === true, 'Shared creation/import requires a verified permanent reservation.');
      if (!restored && policy.requireCreationApproval) {
        approvalFor(options.approval, 'create', ticket.id, trust);
      }
      requireValue(!ticket.delivery || restored, 'New tickets cannot import delivery attestations.');
      if (restored) {
        ticket.delivery = { phase: 'repair-required', previous: restored.delivery ?? null };
      }
    } else if (canonical(criteriaFor(old)) !== canonical(criteriaFor(ticket))) {
      approvalFor(options.approval, 'change-contract', ticket.id, { ...trust, scopeDigest: contractChangeDigest(old, ticket) });
      ticket.delivery = { phase: 'repair-required' };
    } else if (scopeDigest(old) !== scopeDigest(ticket)) {
      ticket.delivery = { phase: 'repair-required' };
    }
  }
  for (const archived of after.archive.tickets ?? []) {
    const prior = before.data.tickets?.find(t => t.id === archived.id);
    if (!prior || archived.status !== 'done') continue;
    const record = options.deliveryRecord;
    requireValue(record?.state === 'ready-for-closure', 'Guarded archive requires verified ready-for-closure delivery evidence.');
    validateCompletion(prior, record.acceptance, record.completionApproval, record.merged, trust);
    requireValue(record.merged.scopeDigest === options.currentScopeDigest, 'Archived scope must match the current verified delivery contract.');
    archived.delivery = {
      phase: 'ready-for-closure',
      completion: record.acceptance,
      merged: record.merged,
    };
  }
}
