/** Public project-neutral guarded delivery API. Project policy controls worktree restrictions; runtime adapters are trusted executable code. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBoardContext } from './board-context.mjs';
import { readBoard, archiveTicket, claimTicket, getTicketEligibility } from './board-api.mjs';
import { deliveryInputs as inputs } from './delivery-contract.mjs';
import { ticketEligibilityVerdict } from './board-core.mjs';
import { globMatches } from './lane-core.mjs';
import { git, digest, canonical, requireValue, identifier, deliverySettings, readRecord, writeRecord,
  reserveTicket, assertWorktree } from './delivery-store.mjs';
import { ownedRecord, acquireOwnership, expandScope } from './delivery-coordination.mjs';
import { criteriaFor, validateQa, validateCompletion, scopeDigest, assertEvidenceChange, approvalFor, REQUIRED_GATES } from './delivery-policy.mjs';
import { ticketPulls, gh, forgeRepository, assertNoConflictingWork, discoverTicketPulls, discoveryCapabilities } from './delivery-facts.mjs';
import { BoardInputError } from './board-errors.mjs';

function contextFor(options, write = true) {
  const snapshot = readBoard(options);
  requireValue(snapshot.errors.length === 0, `Board validation failed: ${snapshot.errors.join('; ')}`);
  const context = { ...loadBoardContext(options), data: snapshot.data, archive: snapshot.archive, plan: snapshot.plan, config: snapshot.config };
  const settings = deliverySettings(context, { write });
  requireValue(settings, 'Enable delivery.enabled in the project config before using guarded delivery.');
  if (options.forgeAdapter) {
    requireValue(typeof options.forgeAdapter.listPullRequests === 'function', 'Forge adapter must be trusted executable code.');
    settings.forgeAdapter = options.forgeAdapter;
  }
  const ticket = context.data.tickets.find(t => t.id === options.id);
  if (options.id) requireValue(ticket, 'Ticket is not on the active board.');
  return { context, s: settings, ticket };
}
function clean(s) { requireValue(!git(s.repo, ['status', '--porcelain', '--untracked-files=all']), 'Commit the worktree before QA/gating/submission.'); }
function update(s, id, prior, patch) {
  return writeRecord(s, 'ownership', id, prior.oid, { ...prior.record, ...patch,
    history: [...(prior.record.history ?? []), { oid: prior.oid, state: prior.record.state, dispatch: prior.record.dispatch, qaDigest: prior.record.qaDigest, submission: prior.record.submission }] });
}
function owner(options, s) { return ownedRecord(s, options.id, options.owner, Number(options.generation)); }
/** Re-read mutable gates after network/verification work; scope digests omit status. */
function assertCurrentEligibility(options, { scheduling = true } = {}) {
  const fresh = contextFor(options, false), owned = owner(options, fresh.s);
  requireValue(['in-progress', 'review'].includes(fresh.ticket.status), 'Ticket status blocks protected delivery.');
  const verdict = ticketEligibilityVerdict({ ...fresh.ticket, status: 'todo' }, {
    data: fresh.context.data, archivedTickets: fresh.context.archive.tickets ?? [],
    archivedEpics: fresh.context.archive.epics ?? [], plan: fresh.context.plan,
  });
  requireValue(verdict.eligible, verdict.reasons.map(reason => reason.message).join('; '));
  if (scheduling) {
    const granted = owned.record.schedule?.touches ?? [], declared = fresh.ticket.touches ?? [];
    requireValue(!granted.length || declared.length && declared.every(path => granted.includes(path)), 'Declared scope exceeds ownership; expand the scheduling claim first.');
  }
  return fresh;
}

export function deliveryStatus(options) {
  const { s } = contextFor(options, false);
  return readRecord(s, 'ownership', options.id);
}
export function reserveId(options) {
  const { context, s } = contextFor(options);
  return reserveTicket(s, [...context.data.tickets, ...context.archive.tickets].map(t => t.id), options.requestId, options.requestedId);
}
export function beginDispatch(options) {
  const { s } = contextFor(options);
  const prior = owner(options, s);
  const permitted = { implementation: ['claimed', 'repair-required', 'reviewable'], qa: ['claimed', 'repair-required', 'reviewable', 'qa-passed'], delivery: ['qa-passed'], acceptance: ['awaiting-dev-acceptance'] };
  requireValue(permitted[options.stage]?.includes(prior.record.state), 'This delivery state cannot dispatch that stage.');
  requireValue(options.stage === 'acceptance' || !prior.record.merged, 'Merged implementation requires an explicit repair transition.');
  const verdict = preflight({ ...options, action: { implementation: 'resume', qa: 'qa', delivery: 'submit', acceptance: 'acceptance' }[options.stage] });
  requireValue(verdict.ready, verdict.reasons.join('; '));
  assertCurrentEligibility(options, { scheduling: options.stage !== 'acceptance' });
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Previous dispatch is running or uncertain; reconcile before dispatch.');
  identifier(options.attemptId, 'dispatch attempt');
  requireValue(['implementation', 'qa', 'delivery', 'acceptance'].includes(options.stage), 'Unknown dispatch stage.');
  requireValue(!(prior.record.history ?? []).some(h => h.dispatch?.attemptId === options.attemptId) &&
    prior.record.dispatch?.attemptId !== options.attemptId, 'Use a fresh dispatch attempt id.');
  return update(s, options.id, prior, { state: 'dispatching', dispatch: { attemptId: options.attemptId, stage: options.stage, resumeState: prior.record.state, agentIdentity: null } });
}
export function acknowledgeDispatch(options) {
  const { s } = contextFor(options); const prior = owner(options, s);
  requireValue(prior.record.dispatch?.attemptId === options.attemptId && prior.record.state === 'dispatching', 'No matching uncertain dispatch.');
  identifier(options.agentIdentity, 'agent identity');
  return update(s, options.id, prior, { state: 'running', dispatch: { ...prior.record.dispatch, agentIdentity: options.agentIdentity } });
}
export function stopDispatch(options) {
  const { s } = contextFor(options); const prior = owner(options, s);
  requireValue(['running', 'dispatching'].includes(prior.record.state) && prior.record.dispatch?.attemptId === options.attemptId,
    'No matching running or uncertain dispatch.');
  const proof = options.harnessAdapter?.resolveAttempt?.(options.attemptId) ?? s.policy.trustedDispatchEvidence?.[options.evidence];
  requireValue(proof && !(proof instanceof Promise) && proof.attemptId === options.attemptId &&
    ['stopped', 'not-started'].includes(proof.state) && proof.evidence, 'Trusted harness evidence that this worker stopped or never started is required.');
  return update(s, options.id, prior, { state: ['acceptance', 'delivery'].includes(prior.record.dispatch.stage) ? prior.record.dispatch.resumeState : 'reviewable', dispatch: { ...prior.record.dispatch, stoppedEvidence: proof.evidence } });
}
export function transferOwnership(options) {
  const { s } = contextFor(options); const prior = owner(options, s);
  approvalFor(options.approval, 'transfer', options.id, { policy: s.policy });
  requireValue(!prior.record.submission || prior.record.pr, 'Reconcile uncertain submission before transfer.');
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Confirm the previous worker stopped before transfer.');
  identifier(options.newOwner, 'new owner');
  return update(s, options.id, prior, { ownerSessionId: options.newOwner, generation: prior.record.generation + 1,
    transferApproval: options.approval, gate: null });
}
export function recordQa(options) {
  const verdict = preflight({ ...options, action: 'qa' }); requireValue(verdict.ready, verdict.reasons.join('; '));
  const { context, s, ticket } = contextFor(options); const prior = owner(options, s);
  clean(s);
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Stop the active worker before recording QA.');
  requireValue(!prior.record.merged && (!prior.record.submission || prior.record.pr?.draft), 'A submitted/merged delivery needs reconciliation before replacing QA.');
  const qa = options.qa;
  requireValue(qa?.ticketId === ticket.id && ['PASS', 'FAIL', 'BLOCKED'].includes(qa.verdict), 'Invalid QA record.');
  requireValue(qa.reviewedCodeSha === git(s.repo, ['rev-parse', 'HEAD']), 'QA must identify the current committed HEAD.');
  const contract = inputs(context, s, ticket);
  requireValue(qa.deliveryAttemptId === prior.record.deliveryAttemptId, 'QA must identify the current delivery attempt.');
  if (qa.verdict === 'PASS') validateQa(ticket, qa, contract.scope, { checks: contract.checks, policy: s.policy });
  else requireValue(typeof qa.evidence === 'string' && qa.evidence.trim(), 'Failed QA needs concrete evidence.');
  return update(s, options.id, prior, { state: qa.verdict === 'PASS' ? 'qa-passed' : 'repair-required',
    qa, qaDigest: digest(qa), gate: null });
}
export function deliveryContract(options) {
  const { context, s, ticket } = contextFor(options, false);
  return { ticketId: ticket.id, ...inputs(context, s, ticket), criteria: criteriaFor(ticket), gates: REQUIRED_GATES,
    head: git(s.repo, ['rev-parse', 'HEAD']), deliveryAttemptId: readRecord(s, 'ownership', ticket.id)?.record.deliveryAttemptId };
}
function committedJson(s, revision, path) {
  return JSON.parse(git(s.repo, ['show', `${revision}:${path}`]));
}
function validateMetadata(s, ticket, qa, head) {
  const qaPath = `${dirname(s.board)}/reports/${ticket.id}/qa.json`;
  const attemptPath = `${dirname(s.board)}/reports/${ticket.id}/${qa.deliveryAttemptId}.json`;
  const reportPaths = [qaPath, attemptPath];
  const commits = git(s.repo, ['rev-list', '--reverse', `${qa.reviewedCodeSha}..${head}`]).split('\n').filter(Boolean);
  for (const commit of commits) {
    const parents = git(s.repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
    requireValue(parents.length === 1, 'Post-QA merges require fresh QA.');
    const changes = git(s.repo, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', parents[0], commit]).split('\n').filter(Boolean);
    for (const change of changes) {
      const [status, path] = change.split('\t');
      requireValue(['A', 'M'].includes(status) && [s.board, ...reportPaths].includes(path), `Post-QA change requires fresh review: ${path}.`);
      const mode = git(s.repo, ['ls-tree', commit, '--', path]).split(' ')[0];
      requireValue(mode === '100644', 'Evidence must be a regular non-executable file.');
      if (reportPaths.includes(path)) {
        requireValue(canonical(committedJson(s, commit, path)) === canonical(qa), 'QA report differs from the frozen attestation.');
        if (status === 'M') requireValue(canonical(committedJson(s, parents[0], path)) === canonical(qa), 'Historical QA evidence cannot be replaced.');
      }
      else {
        assertEvidenceChange(committedJson(s, parents[0], path), committedJson(s, commit, path), ticket.id);
        const metadata = committedJson(s, commit, path).tickets.find(t => t.id === ticket.id).delivery;
        if (metadata?.reviewedCodeSha) requireValue(metadata.reviewedCodeSha === qa.reviewedCodeSha, 'Evidence changes the reviewed SHA.');
        if (metadata?.qaDigest) requireValue(metadata.qaDigest === digest(qa), 'Evidence changes the QA digest.');
        if (metadata?.report) requireValue(reportPaths.includes(metadata.report), 'Evidence report must name the frozen QA report.');
      }
    }
  }
}
function baseRevision(s) {
  const lines = git(s.repo, ['ls-remote', '--symref', s.remote, 'HEAD']);
  const branch = lines.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  const sha = lines.match(/^([a-f0-9]{40,64})\tHEAD$/m)?.[1];
  requireValue(branch && sha, 'Cannot resolve the remote default branch.');
  git(s.repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', s.remote, sha]);
  return { branch, sha };
}
export function gateDelivery(options) {
  const verdict = preflight({ ...options, action: 'qa' }); requireValue(verdict.ready, verdict.reasons.join('; '));
  const { context, s, ticket } = contextFor(options); const prior = owner(options, s);
  clean(s);
  requireValue(prior.record.state === 'qa-passed' && prior.record.qaDigest === digest(prior.record.qa), 'No frozen passing QA attestation.');
  requireValue(git(s.repo, ['branch', '--show-current']) === prior.record.branch, 'Gate must run on the claimed delivery branch.');
  const head = git(s.repo, ['rev-parse', 'HEAD']);
  if (options.head) requireValue(options.head === head, 'Requested head differs from the checked-out revision.');
  const qa = prior.record.qa, contract = inputs(context, s, ticket);
  validateQa(ticket, qa, contract.scope, { checks: contract.checks, policy: s.policy });
  requireValue(git(s.repo, ['merge-base', '--is-ancestor', qa.reviewedCodeSha, head], { allowFailure: true }).status === 0,
    'Reviewed SHA is not an ancestor of the final head.');
  validateMetadata(s, ticket, qa, head);
  const base = baseRevision(s);
  if (ticket.touches?.length) {
    const changed = git(s.repo, ['diff', '--name-only', '-z', `${base.sha}...${head}`]).split('\0').filter(Boolean);
    requireValue(changed.every(path => path === s.board || path.startsWith(`${dirname(s.board)}/reports/${ticket.id}/`) || ticket.touches.some(glob => globMatches(path, glob))), 'Implementation changes files outside its declared scope.');
  }
  requireValue(git(s.repo, ['merge-tree', '--write-tree', base.sha, head], { allowFailure: true }).status === 0, 'Delivery does not merge cleanly with the current base.');
  const completed = new Set([...context.data.tickets, ...context.archive.tickets].filter(t => t.status === 'done').map(t => t.id));
  requireValue((ticket.depends_on ?? []).every(id => completed.has(id)) && !ticket.human_gate, 'Dependencies or human gate remain unresolved.');
  const checks = contract.checks.map(command => {
    const result = spawnSync(command, { cwd: s.repo, shell: true, encoding: 'utf8',
      timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    requireValue(result.status === 0, `Delivery check failed: ${command} (exit ${result.status ?? result.error?.code}).`);
    return { command, exitCode: 0, revision: head, outputDigest: digest(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) };
  });
  clean(s); requireValue(git(s.repo, ['rev-parse', 'HEAD']) === head, 'Verification changed HEAD.');
  requireValue(baseRevision(s).sha === base.sha, 'Base changed during verification; re-run the gate.');
  const fresh = assertCurrentEligibility(options);
  requireValue(inputs(fresh.context, fresh.s, fresh.ticket).scope === contract.scope, 'Delivery contract changed during verification.');
  const gate = { verdict: 'PASS', head, base, scopeDigest: contract.scope, qaDigest: prior.record.qaDigest, checks };
  const saved = update(s, ticket.id, prior, { gate });
  return { ...gate, ownershipOid: saved.oid };
}
function forgeAction(s, action, details) {
  if (s.forgeAdapter?.[action]) return s.forgeAdapter[action](details, s);
  const repository = forgeRepository(s);
  const repoArgs = ['--repo', `${repository.host}/${repository.name}`];
  if (action === 'createPullRequest') return gh(s.repo, ['pr', 'create', ...repoArgs, '--head', details.branch,
    '--base', details.base, '--title', details.title, '--body-file', '-', ...(details.draft ? ['--draft'] : [])], { input: details.body });
  if (action === 'readyPullRequest') return gh(s.repo, ['pr', 'ready', String(details.number), ...repoArgs]);
  throw new BoardInputError('Forge adapter does not support this action.');
}
function submit(options, draft) {
  const readiness = preflight({ ...options, action: 'submit' }); requireValue(readiness.ready, readiness.reasons.join('; '));
  const { context, s, ticket } = contextFor(options); let prior = owner(options, s);
  requireValue(discoveryCapabilities(s).pullRequests, 'Configure a forge adapter before submission.');
  clean(s);
  const head = git(s.repo, ['rev-parse', 'HEAD']);
  requireValue(git(s.repo, ['branch', '--show-current']) === prior.record.branch, 'Submission must use the claimed branch.');
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Stop the worker before submission.');
  const base = baseRevision(s), gate = prior.record.gate;
  if (!draft) requireValue(gate?.verdict === 'PASS' && gate.head === head && gate.base.sha === base.sha &&
    gate.scopeDigest === inputs(context, s, ticket).scope && gate.qaDigest === digest(prior.record.qa),
    'The current head/base has not passed the delivery gate.');
  if (draft) requireValue(!prior.record.pr || prior.record.pr.draft === true, 'A ready PR cannot accept ungated draft updates.');
  const repository = forgeRepository(s);
  const marker = `<!-- maestro:attempt ${prior.record.deliveryAttemptId} -->`;
  const inventory = () => ticketPulls(s, ticket.id, prior.record.branch).filter(p =>
    !(prior.record.deliveries ?? []).some(d => d.pr?.number === p.number && p.state === 'merged'));
  const exact = p => p.branch === prior.record.branch && p.repository === repository.name &&
    p.baseRepository === repository.name && p.base === base.branch && p.body?.includes(marker);
  let prs = inventory();
  if (draft) requireValue(prs.every(p => p.draft === true), 'A ready PR cannot accept ungated draft updates.');
  requireValue(prs.length <= 1 && prs.every(p => p.state === 'open' && exact(p)), 'Conflicting delivery or PR identity requires reconciliation.');
  if (prior.record.submission) {
    requireValue(prs.length === 1 && (prior.record.pr || prior.record.submission.head === head),
      'Previous submission is uncertain; reconcile before retrying or changing its head.');
  } else {
    requireValue(!prs.length, 'Unowned existing PR requires explicit adoption.');
    identifier(options.requestId, 'submission request');
    requireValue(!(prior.record.history ?? []).some(h => h.submission?.requestId === options.requestId), 'Use a fresh request after reconciled submission failure.');
    prior = update(s, ticket.id, prior, { submission: { requestId: options.requestId, head, base, draft, outcome: 'unknown' } });
  }
  if (prs.length && prior.record.pr) requireValue(prs[0].head === prior.record.pr.head || prs[0].head === head, 'Remote PR head changed outside this delivery; reconcile before push.');
  assertCurrentEligibility(options);
  git(s.repo, ['push', s.remote, `${head}:refs/heads/${prior.record.branch}`]);
  clean(s);
  requireValue(git(s.repo, ['rev-parse', 'HEAD']) === head && baseRevision(s).sha === base.sha, 'Head or base changed during push; re-run the gate.');
  const fresh = contextFor(options, false);
  requireValue(draft || inputs(fresh.context, fresh.s, fresh.ticket).scope === gate.scopeDigest, 'Delivery contract changed during push.');
  const remoteHead = git(s.repo, ['ls-remote', '--refs', s.remote, `refs/heads/${prior.record.branch}`]).split('\t')[0];
  requireValue(remoteHead === head, 'Remote branch differs from submitted revision.');
  if (!prs.length) {
    assertCurrentEligibility(options);
    try { forgeAction(s, 'createPullRequest', { branch: prior.record.branch, head, base: base.branch,
      title: `${ticket.name} (${ticket.id})`, draft, body: `<!-- maestro:ticket ${ticket.id} -->\n${marker}\n\n${ticket.desc}` }); }
    catch { /* A failed response may follow successful creation. Reconcile, never duplicate. */ }
  }
  prs = inventory();
  requireValue(prs.length === 1 && exact(prs[0]) && prs[0].state === 'open' && prs[0].head === head,
    'Forge does not confirm the submitted PR identity/head; reconcile before retrying.');
  if (!draft && prs[0].draft) {
    assertCurrentEligibility(options);
    forgeAction(s, 'readyPullRequest', { number: prs[0].number }); prs = inventory();
    requireValue(prs.length === 1 && exact(prs[0]) && prs[0].head === head && prs[0].draft === false, 'Forge did not confirm draft promotion.');
  }
  const saved = update(s, ticket.id, prior, { state: draft ? 'reviewable' : 'submitted', pr: prs[0],
    submission: { ...prior.record.submission, head, base, draft, outcome: 'confirmed' } });
  return { pr: prs[0], head, ownershipOid: saved.oid };
}
export const submitDelivery = options => submit(options, false);
export const openDraftDelivery = options => submit(options, true);
export function recordMerge(options) {
  const { s, ticket } = contextFor(options); const prior = owner(options, s);
  requireValue(prior.record.state === 'submitted' && prior.record.pr && prior.record.gate && prior.record.pr.head === prior.record.gate.head, 'A gated submitted PR is required.');
  const repository = forgeRepository(s);
  const pr = ticketPulls(s, ticket.id, prior.record.branch).find(p => p.number === prior.record.pr.number &&
    p.repository === repository.name && p.baseRepository === repository.name && p.branch === prior.record.branch && p.base === prior.record.gate.base.branch);
  requireValue(pr?.state === 'merged' && pr.head === prior.record.gate.head && pr.mergeSha,
    'The forge does not confirm a human merge of the gated head.');
  const merged = { pr: pr.number, head: pr.head, mergeSha: pr.mergeSha, scopeDigest: prior.record.gate.scopeDigest };
  return update(s, ticket.id, prior, { state: 'awaiting-dev-acceptance', merged });
}
export function completeDelivery(options) {
  assertCurrentEligibility(options, { scheduling: false });
  const { context, s, ticket } = contextFor(options); const prior = owner(options, s);
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Reconcile acceptance dispatch before completion.');
  requireValue(prior.record.merged && prior.record.qa, 'Record the verified human merge before completion.');
  requireValue(inputs(context, s, ticket).scope === prior.record.merged.scopeDigest, 'Completion scope differs from the reviewed delivery.');
  validateCompletion(ticket, options.acceptance, options.approval, prior.record.merged, { policy: s.policy });
  return update(s, ticket.id, prior, { state: 'ready-for-closure', acceptance: options.acceptance, completionApproval: options.approval });
}
export function archiveDelivery(options) {
  assertCurrentEligibility(options, { scheduling: false });
  const { s } = contextFor(options); const prior = owner(options, s);
  requireValue(prior.record.state === 'ready-for-closure', 'Acceptance is incomplete.');
  if (s.policy.requireClosureWorktree) requireValue(git(s.repo, ['branch', '--show-current']) !== prior.record.branch, 'Project policy requires a separate closure worktree.');
  return archiveTicket({ ...options, status: 'done', evidence: options.evidence,
    deliveryOwnership: { owner: options.owner, generation: Number(options.generation) } });
}
export function recordEvidence(options) {
  const { s } = contextFor(options); const prior = owner(options, s);
  requireValue(typeof options.evidence === 'string' && options.evidence.trim(), 'Evidence is required.');
  return update(s, options.id, prior, { evidence: [...(prior.record.evidence ?? []), options.evidence] });
}

const boardOptions = options => Object.fromEntries(['boardPath', 'dataPath', 'archivePath', 'configPath', 'agentsDir', 'lockOptions', 'executionRepo', 'id']
  .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
export function preflight(options) {
  const { context, s, ticket } = contextFor(options, false);
  const actions = ['implement', 'resume', 'qa', 'submit', 'acceptance', 'repair', 'closure'];
  requireValue(actions.includes(options.action), 'Unknown preflight action.');
  const ownership = readRecord(s, 'ownership', options.id);
  const capabilities = discoveryCapabilities(s);
  const reasons = [];
  const discovery = discoverTicketPulls(s, options.id, options.branch ?? ownership?.record.branch);
  try {
    if (options.action === 'implement') {
      const { verdict } = getTicketEligibility(boardOptions(options));
      requireValue(verdict.eligible, verdict.reasons.map(r => r.message).join('; '));
      assertNoConflictingWork(s, ticket.id, options.branch ?? git(s.repo, ['branch', '--show-current']));
    } else {
      owner(options, s);
      if (['resume', 'qa', 'submit'].includes(options.action)) {
        const granted = ownership.record.schedule?.touches ?? [];
        const declared = ticket.touches ?? [];
        requireValue(!granted.length || declared.length && declared.every(path => granted.includes(path)), 'Declared scope exceeds ownership; expand the scheduling claim first.');
        requireValue(['in-progress', 'review'].includes(ticket.status), 'Ticket status blocks protected dispatch.');
        const current = ticketEligibilityVerdict({ ...ticket, status: 'todo' }, { data: context.data, archivedTickets: context.archive.tickets ?? [], archivedEpics: context.archive.epics ?? [], plan: context.plan });
        requireValue(current.eligible, current.reasons.map(r => r.message).join('; '));
      }
      if (['resume', 'qa', 'submit'].includes(options.action)) requireValue(git(s.repo, ['branch', '--show-current']) === ownership.record.branch, 'Use the owned execution branch.');
      if (['qa', 'submit'].includes(options.action)) clean(s);
      if (['acceptance', 'repair'].includes(options.action)) requireValue(ownership.record.merged, 'A confirmed merged delivery is required.');
      if (options.action === 'closure') requireValue(ownership.record.state === 'ready-for-closure', 'Completion has not passed.');
    }
    if (capabilities.pullRequests || options.action === 'submit') {
      requireValue(discovery.status !== 'unknown', discovery.error);
      const record = ownership?.record;
      const relevant = discovery.pulls.filter(p => !(record?.deliveries ?? []).some(d => d.pr?.number === p.number && p.state === 'merged'));
      if (['implement', 'resume', 'qa', 'submit'].includes(options.action)) {
        requireValue(!record?.merged && !relevant.some(p => p.state === 'merged'), 'Merged delivery must be reconciled before implementation or QA.');
        const repository = relevant.length ? forgeRepository(s) : null;
        requireValue(relevant.every(p => p.state === 'open' && p.branch === record?.branch &&
          (record?.pr?.number === p.number && p.repository === record.pr.repository && p.baseRepository === record.pr.baseRepository ||
           record?.submission && p.body?.includes(`<!-- maestro:attempt ${record.deliveryAttemptId} -->`) &&
           p.repository === repository.name && p.baseRepository === repository.name && p.base === record.submission.base.branch && p.head === record.submission.head)),
        'Existing delivery artifacts require reconciliation.');
      }
    }
  } catch (error) { reasons.push(error.message); }
  return { ready: reasons.length === 0, action: options.action, reasons, capabilities, discovery, ownership };
}
export function guardedClaim(options) {
  const { context, s, ticket } = contextFor(options);
  if (options.resume) {
    requireValue(['in-progress', 'review', 'blocked'].includes(ticket.status), 'Resume requires an active ticket.');
    const prior = owner(options, s);
    requireValue(prior.record.branch === options.branch, 'Resume must use the owned branch.');
    return { claimed: true, ownership: prior };
  }
  const snapshot = getTicketEligibility(boardOptions(options));
  const result = claimTicket({ ...boardOptions(options), forgeAdapter: options.forgeAdapter, owner: options.owner, requestId: options.requestId,
    branch: options.branch, expectVersion: options.expectVersion ?? snapshot.version,
    expectArchiveVersion: options.expectArchiveVersion ?? snapshot.archiveVersion,
    expectPlanVersion: options.expectPlanVersion ?? snapshot.planVersion, dryRun: options.dryRun });
  if (options.dryRun) return { ...result, dryRun: true, acquired: false };
  if (!(result.result?.claimed ?? result.claimed)) return result;
  let ownership = readRecord(s, 'ownership', ticket.id);
  if (!ownership.record.deliveryAttemptId) ownership = update(s, ticket.id, ownership, { deliveryAttemptId: options.requestId });
  return { ...result, claimed: true, ownership };
}
export function recordAcceptanceFailure(options) {
  const { s } = contextFor(options); const prior = owner(options, s);
  requireValue(prior.record.merged && typeof options.evidence === 'string' && options.evidence.trim(), 'Merged delivery and acceptance failure evidence are required.');
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Reconcile active acceptance worker first.');
  return update(s, options.id, prior, { state: 'repair-required', acceptanceFailure: options.evidence });
}
export function beginRepair(options) {
  const { s, ticket } = contextFor(options); const prior = owner(options, s);
  requireValue(!prior.record.dispatch || prior.record.dispatch.stoppedEvidence, 'Reconcile active worker before repair.');
  identifier(options.requestId, 'repair request');
  requireValue(!(prior.record.deliveries ?? []).some(d => d.deliveryAttemptId === options.requestId) && prior.record.deliveryAttemptId !== options.requestId, 'Repair attempt must be fresh.');
  const branch = git(s.repo, ['branch', '--show-current']);
  requireValue(branch === options.branch, 'Repair must name the checked out branch.');
  if (!prior.record.merged) {
    requireValue(branch === prior.record.branch && ['repair-required', 'reviewable'].includes(prior.record.state), 'In-scope repair must retain the existing delivery branch.');
    return update(s, ticket.id, prior, { state: 'repair-required', qa: null, qaDigest: null, gate: null });
  }
  requireValue(prior.record.acceptanceFailure, 'Record acceptance failure before opening a post-merge repair.');
  requireValue(branch !== prior.record.branch, 'Post-merge repair requires a new delivery branch.');
  requireValue(discoveryCapabilities(s).pullRequests, 'Configure a forge adapter before post-merge repair.');
  const pulls = ticketPulls(s, ticket.id, branch);
  requireValue(!pulls.some(p => p.state === 'open'), 'An active delivery already exists.');
  const original = pulls.find(p => p.number === prior.record.merged.pr && p.state === 'merged');
  requireValue(original?.repository === prior.record.pr.repository && original?.baseRepository === prior.record.pr.baseRepository && original?.branch === prior.record.branch && original?.head === prior.record.merged.head && original.mergeSha === prior.record.merged.mergeSha, 'Prior merged delivery identity no longer matches.');
  const { history, ...previous } = prior.record;
  return update(s, ticket.id, prior, { state: 'repair-required', branch, deliveryAttemptId: options.requestId,
    repairOf: prior.record.merged.pr, deliveries: [...(prior.record.deliveries ?? []), previous],
    dispatch: null, qa: null, qaDigest: null, gate: null, submission: null, pr: null, merged: null,
    acceptance: null, completionApproval: null, acceptanceFailure: null });
}

/** An uncertain creation is cleared only by scoped operator approval plus fresh absence. */
export function reconcileSubmission(options) {
  const { s, ticket } = contextFor(options); const prior = owner(options, s);
  requireValue(prior.record.submission && !prior.record.pr, 'No uncertain submission to reconcile.');
  const discovery = discoverTicketPulls(s, ticket.id, prior.record.branch);
  requireValue(discovery.status !== 'unknown', discovery.error);
  const matching = discovery.pulls.filter(p => !(prior.record.deliveries ?? []).some(d => d.pr?.number === p.number && p.state === 'merged'));
  requireValue(matching.length === 0, 'Existing PR must be reconciled by its exact identity through submit.');
  approvalFor(options.approval, 'retry-submission', ticket.id, { policy: s.policy, scopeDigest: digest(prior.record.submission) });
  return update(s, ticket.id, prior, { submission: null, reconciliationApproval: options.approval });
}

export function expandDeliveryScope(options) {
  const { s, ticket } = contextFor(options);
  return expandScope(s, { id: ticket.id, owner: options.owner, generation: Number(options.generation),
    schedule: { id: ticket.id, touches: ticket.touches ?? [], area: ticket.area, epicId: ticket.epicId } });
}
