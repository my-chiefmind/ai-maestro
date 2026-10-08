/** Git-backed coordination. No daemon, wall-clock expiry, or force takeover. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { conflictReason } from './lane-core.mjs';
import { BoardInputError, BoardConflictError } from './board-errors.mjs';

import { canonical, digest, requireValue } from './delivery-values.mjs';
export { canonical, digest, requireValue } from './delivery-values.mjs';

export function identifier(value, label = 'identifier') {
  requireValue(typeof value === 'string' && !['constructor', 'prototype', '__proto__'].includes(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value), `Invalid ${label}.`);
  return value;
}
export function git(repo, args, { input, allowFailure = false, env } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', input, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  if (!allowFailure && result.status !== 0) throw new BoardInputError(`Git ${args[0]} failed; coordination is unavailable (${result.error?.code ?? result.status}).`);
  return allowFailure ? result : result.stdout.trim();
}
export function assertWorktree(repo) {
  const top = realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  const gitDir = realpathSync(git(repo, ['rev-parse', '--absolute-git-dir']));
  const common = realpathSync(resolve(repo, git(repo, ['rev-parse', '--git-common-dir'])));
  requireValue(gitDir !== common, 'Guarded delivery writes require a separate git worktree; the primary checkout is read-only.');
  requireValue(git(repo, ['branch', '--show-current']), 'Guarded delivery requires a named worktree branch.');
  return top;
}
export function deliverySettings(context, { write = false } = {}) {
  const policy = context.config?.delivery;
  if (!policy?.enabled) return null;
  requireValue(policy.enabled === true, 'delivery.enabled must be boolean.');
  const boardRepo = git(dirname(context.dataPath), ['rev-parse', '--show-toplevel']);
  const repo = context.executionRepo ? git(context.executionRepo, ['rev-parse', '--show-toplevel']) : boardRepo;
  const common = path => realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir'])));
  requireValue(common(repo) === common(boardRepo), 'Execution checkout must share the board repository Git directory.');
  if (write && policy.requireWorktree) assertWorktree(repo);
  const remote = policy.remote ?? 'origin';
  identifier(remote, 'remote');
  const namespace = identifier(policy.namespace ?? 'maestro', 'delivery namespace');
  const board = relative(boardRepo, resolve(realpathSync(dirname(context.dataPath)), basename(context.dataPath))).split('\\').join('/');
  requireValue(board && !board.startsWith('../') && !isAbsolute(board), 'Board must be inside the delivery repository.');
  // Remote name may differ between clones; the explicit namespace and board path are the identity.
  const repositoryId = policy.repositoryId ?? (policy.coordination === 'git' ? null : 'local');
  requireValue(typeof repositoryId === 'string' && repositoryId.trim(), 'Shared coordination requires an explicit delivery.repositoryId.');
  const boardKey = digest([repositoryId, board]).slice(0, 16);
  const mode = policy.coordination ?? 'local';
  requireValue(['local', 'git'].includes(mode), 'delivery.coordination must be local or git.');
  if (context.forgeAdapter) requireValue(typeof context.forgeAdapter.listPullRequests === 'function', 'Forge adapter must be executable code.');
  return { forgeAdapter: context.forgeAdapter, repo, remote, namespace, board, repositoryId, policy, config: context.config, mode, prefix: `${namespace}/${boardKey}`,
    ledgerRef: mode === 'git' ? `refs/heads/${namespace}/coordination/${boardKey}` : `refs/maestro/${namespace}/${boardKey}` };
}
export function remoteRefs(s, pattern) {
  const output = git(s.repo, ['ls-remote', '--refs', s.remote, pattern]);
  return output ? output.split('\n').map(line => {
    const [oid, ref] = line.split('\t');
    requireValue(/^[a-f0-9]{40,64}$/.test(oid) && ref?.startsWith('refs/'), 'Malformed remote ref response.');
    return { oid, ref };
  }) : [];
}
export function readLedger(s) {
  let oid;
  if (s.mode === 'git') oid = remoteRefs(s, s.ledgerRef)[0]?.oid;
  else {
    const lines = git(s.repo, ['for-each-ref', '--format=%(refname) %(objectname)', s.ledgerRef]);
    oid = lines.split('\n').find(line => line.startsWith(`${s.ledgerRef} `))?.split(' ')[1] ?? null;
  }
  if (!oid) return { oid: null, ledger: { schemaVersion: 1, repositoryId: s.repositoryId, board: s.board, reservation: {}, ownership: {} } };
  if (s.mode === 'git') git(s.repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', s.remote, oid]);
  let ledger;
  try { ledger = JSON.parse(git(s.repo, ['show', `${oid}:record.json`])); }
  catch { throw new BoardInputError('Invalid coordination ledger.'); }
  requireValue(ledger.schemaVersion === 1 && ledger.repositoryId === s.repositoryId && ledger.board === s.board && ledger.reservation && ledger.ownership,
    'Coordination ledger identity does not match this board.');
  return { oid, ledger };
}
export function readRecord(s, kind, id) {
  identifier(id, 'ticket id');
  requireValue(['reservation', 'ownership'].includes(kind), 'Invalid coordination kind.');
  return readLedger(s).ledger[kind][id] ?? null;
}
function commitLedger(s, expected, ledger) {
  const blob = git(s.repo, ['hash-object', '-w', '--stdin'], { input: `${canonical(ledger)}\n` });
  const tree = git(s.repo, ['mktree'], { input: `100644 blob ${blob}\trecord.json\n` });
  const oid = git(s.repo, ['commit-tree', tree, ...(expected ? ['-p', expected] : [])], {
    input: 'Maestro coordination transaction\n',
    env: { GIT_AUTHOR_NAME: 'Maestro coordination', GIT_AUTHOR_EMAIL: 'maestro@localhost',
      GIT_COMMITTER_NAME: 'Maestro coordination', GIT_COMMITTER_EMAIL: 'maestro@localhost' },
  });
  const result = s.mode === 'git'
    ? git(s.repo, ['push', '--porcelain', `--force-with-lease=${s.ledgerRef}:${expected ?? ''}`, s.remote, `${oid}:${s.ledgerRef}`], { allowFailure: true })
    : git(s.repo, ['update-ref', s.ledgerRef, oid, expected ?? ''], { allowFailure: true });
  return { oid, result };
}
export function writeRecord(s, kind, id, expected, values, { dryRun = false } = {}) {
  if (s.policy?.requireWorktree) assertWorktree(s.repo); identifier(id, 'ticket id');
  requireValue(['reservation', 'ownership'].includes(kind), 'Invalid coordination kind.');
  requireValue(kind !== 'reservation' || expected === null, 'Reservations are permanent and immutable.');
  const entry = { oid: randomUUID(), record: { ...values, schemaVersion: 1, kind, ticketId: id, board: s.board, previousOid: expected ?? null } };
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = readLedger(s);
    const previous = snapshot.ledger[kind][id];
    if ((previous?.oid ?? null) !== (expected ?? null)) throw new BoardConflictError(`Concurrent ${kind} update for ${id}; reconcile before retrying.`);
    if (kind === 'ownership' && previous?.record.dispatch && !previous.record.dispatch.stoppedEvidence) {
      requireValue(values.dispatch?.attemptId === previous.record.dispatch.attemptId,
        'An active or uncertain dispatch cannot be discarded; reconcile it first.');
      if (!values.dispatch.stoppedEvidence) {
        const granted = previous.record.schedule?.touches ?? [];
        const proposed = values.schedule?.touches;
        requireValue(Array.isArray(proposed) && (!granted.length ? !proposed.length :
          !proposed.length || granted.every(path => proposed.includes(path))),
        'An active or uncertain dispatch cannot release granted scopes.');
        requireValue(!['awaiting-dev-acceptance', 'awaiting-acceptance', 'ready-for-closure', 'closed'].includes(values.state),
          'An active or uncertain dispatch cannot release scheduling ownership.');
      }
    }
    if (kind === 'ownership' && values.schedule && !['awaiting-dev-acceptance', 'awaiting-acceptance', 'ready-for-closure', 'closed'].includes(values.state)) {
      // Ticket ownership and cross-ticket scheduling are ONE compare-and-swap decision.
      for (const [otherId, other] of Object.entries(snapshot.ledger.ownership)) {
        if (otherId === id || ['awaiting-dev-acceptance', 'awaiting-acceptance', 'ready-for-closure', 'closed'].includes(other.record.state)) continue;
        const a = values.schedule, b = other.record.schedule;
        const conflict = !a.touches?.length || !b?.touches?.length || conflictReason(a, b, s.config ?? {});
        requireValue(!conflict, `Active ticket ${otherId} conflicts with ${id}; wait for its delivery or reconcile its ownership.`);
      }
    }
    if (kind === 'reservation') {
      const duplicate = Object.entries(snapshot.ledger.reservation).find(([otherId, e]) => otherId !== id && e.record.requestId === values.requestId);
      if (duplicate) throw new BoardConflictError('Reservation request already allocated another id; reconcile the original receipt.');
    }
    if (dryRun) return { ...entry, dryRun: true };
    snapshot.ledger[kind][id] = entry;
    const outcome = commitLedger(s, snapshot.oid, snapshot.ledger);
    const actual = readLedger(s);
    if (actual.ledger[kind][id]?.oid === entry.oid) return entry;
    if (actual.oid === snapshot.oid && outcome.result.status !== 0) throw new BoardInputError('Coordination write failed; no fallback to another mode.');
    // Another ticket won the global CAS. Re-read and re-evaluate scheduling before retrying.
  }
  throw new BoardConflictError('Coordination contention; retry after reconciliation.');
}
export function reserveTicket(s, usedIds, requestId = randomUUID(), requestedId) {
  identifier(requestId, 'reservation request id');
  const journal = resolve(s.repo, git(s.repo, ['rev-parse', '--git-common-dir']), 'maestro', 'requests');
  mkdirSync(journal, { recursive: true });
  const requestPath = resolve(journal, `${digest([s.repositoryId, s.board, requestId])}.json`);
  const request = { requestId, requestedId: requestedId ?? null, board: s.board, repositoryId: s.repositoryId };
  try { writeFileSync(requestPath, canonical(request), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireValue(canonical(JSON.parse(readFileSync(requestPath, 'utf8'))) === canonical(request), 'Reservation retry changed its durable request identity.');
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const reservations = readLedger(s).ledger.reservation;
    for (const [id, prior] of Object.entries(reservations)) {
      if (prior.record.requestId === requestId) {
        requireValue(!requestedId || requestedId === id, 'Reservation request was already used for another id.');
        return { id, requestId, oid: prior.oid };
      }
    }
    const used = new Set([...usedIds, ...Object.keys(reservations)]);
    const next = Math.max(0, ...[...used].map(id => Number(id.match(/^T-(\d+)$/)?.[1] ?? 0))) + 1;
    const id = requestedId ?? `T-${String(next).padStart(3, '0')}`;
    requireValue(!used.has(id), `Ticket ${id} is already allocated.`);
    try {
      const saved = writeRecord(s, 'reservation', id, null, { requestId, createdAt: new Date().toISOString() });
      return { id, requestId, oid: saved.oid };
    } catch (e) {
      if (!(e instanceof BoardConflictError)) throw e;
    }
  }
  throw new BoardConflictError('Reservation retry limit reached.');
}
export function assertReservation(s, id, receipt) {
  requireValue(receipt?.id === id && receipt.requestId && receipt.oid, 'A matching reservation receipt is required.');
  const saved = readRecord(s, 'reservation', id);
  requireValue(saved?.oid === receipt.oid && saved.record.requestId === receipt.requestId,
    'Reservation belongs to another request or was changed.');
}

/** Batch results always expose durable receipts, including partial allocation. */
export function reserveTickets(s, usedIds, requests) {
  const receipts = [];
  for (const request of requests) {
    try { receipts.push(reserveTicket(s, [...usedIds, ...receipts.map(r => r.id)], request.requestId, request.requestedId)); }
    catch (error) { return { status: 'partial', receipts, failedRequest: request, error: error.message }; }
  }
  return { status: 'complete', receipts };
}
