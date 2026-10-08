/** Forge facts are collected here, never inside the pure board validator. */
import { spawnSync } from 'node:child_process';
import { git, remoteRefs, requireValue } from './delivery-store.mjs';
import { BoardInputError } from './board-errors.mjs';

export function gh(repo, args, { input } = {}) {
  const result = spawnSync('gh', args, { cwd: repo, encoding: 'utf8', input,
    timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new BoardInputError(`Forge query/action ${args[0]} failed; its outcome must be reconciled (${result.error?.code ?? result.status}).`);
  return result.stdout.trim();
}
export function forgeRepository(s) {
  if (s.forgeAdapter?.repository) return s.forgeAdapter.repository(s);
  // Resolve from the configured remote, not gh's possibly different default repository.
  const url = git(s.repo, ['config', '--get', `remote.${s.remote}.url`]);
  const match = url.match(/^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  requireValue(match, 'Guarded forge operations require a configured GitHub remote.');
  return { host: match[1], name: match[2], url };
}
export function listPullRequests(s) {
  if (s.forgeAdapter?.listPullRequests) {
    const pulls = s.forgeAdapter.listPullRequests(s);
    requireValue(Array.isArray(pulls) && pulls.every(p => Number.isInteger(p.number) && ['open', 'closed', 'merged'].includes(p.state) && p.branch && p.head && p.base && p.repository && p.baseRepository), 'Incomplete adapter pull request inventory.');
    return pulls;
  }
  const repository = forgeRepository(s);
  let pages;
  try { pages = JSON.parse(gh(s.repo, ['api', '--hostname', repository.host, '--paginate', '--slurp',
    `repos/${repository.name}/pulls?state=all&per_page=100`])); }
  catch (e) { throw new BoardInputError(`Cannot obtain complete pull request inventory: ${e.message}`); }
  requireValue(Array.isArray(pages) && pages.every(Array.isArray), 'Malformed paginated pull request response.');
  return pages.flat().map(pr => {
    requireValue(Number.isInteger(pr.number) && ['open', 'closed'].includes(pr.state) &&
      typeof pr.title === 'string' && typeof pr.head?.ref === 'string' && pr.head?.sha && pr.base?.ref && pr.head?.repo?.full_name && pr.base?.repo?.full_name,
    'Incomplete pull request identity.');
    return { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.head.ref,
      draft: pr.draft === true, head: pr.head.sha, base: pr.base.ref, state: pr.merged_at ? 'merged' : pr.state,
      url: pr.html_url, repository: pr.head.repo?.full_name, baseRepository: pr.base.repo?.full_name,
      mergeSha: pr.merge_commit_sha };
  });
}
export function mentionsTicket(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(text ?? '');
}
export function ticketPulls(s, id, branch) {
  return listPullRequests(s).filter(pr => mentionsTicket(pr.title, id) ||
    pr.body.includes(`<!-- maestro:ticket ${id} -->`) || pr.branch === branch);
}
export function assertNoConflictingWork(s, id, branch, { resume = false, repairOf = null } = {}) {
  const prs = s.policy?.forge || s.forgeAdapter ? ticketPulls(s, id, branch) : [];
  const historicalBranches = new Set(prs.filter(pr => pr.state === 'merged' && pr.number === repairOf).map(pr => pr.branch));
  if (repairOf !== null) requireValue(historicalBranches.size === 1, 'Repair must reference a confirmed merged delivery.');
  const local = git(s.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');
  const remote = (s.mode === 'git' || s.policy?.forge ? remoteRefs(s, 'refs/heads/*') : []).map(row => row.ref.slice('refs/heads/'.length));
  const conflicting = [...new Set([...local, ...remote])].filter(name => name &&
    !name.startsWith(`${s.prefix}/coordination/`) && mentionsTicket(name, id) && name !== branch && !historicalBranches.has(name));
  requireValue(!conflicting.length, `Existing branches for ${id}: ${conflicting.join(', ')}. Preserve and reconcile them.`);
  const worktrees = git(s.repo, ['worktree', 'list', '--porcelain']).split('\n\n');
  const ownRepo = git(s.repo, ['rev-parse', '--show-toplevel']);
  for (const block of worktrees) {
    const name = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    const path = block.match(/^worktree (.+)$/m)?.[1];
    requireValue(!name || !mentionsTicket(name, id) || path === ownRepo || historicalBranches.has(name),
      `Another worktree already carries ${id}; resume its owner instead.`);
  }
  requireValue(!prs.some(pr => pr.state === 'merged' && pr.number !== repairOf), `${id} already has a merged delivery PR; use acceptance/closure.`);
  const active = prs.filter(pr => pr.number !== repairOf);
  requireValue(resume ? active.every(pr => pr.branch === branch && pr.state === 'open') : active.length === 0,
    `${id} has existing PR work; reconcile its ownership before dispatch.`);
  return prs;
}

/** Absence is returned only after complete discovery succeeds. */
export function discoveryCapabilities(s) {
  return { localBranches: true, remoteBranches: s.mode === 'git' || Boolean(s.policy?.forge),
    pullRequests: Boolean(s.policy?.forge || s.forgeAdapter) };
}
export function discoverTicketPulls(s, id, branch) {
  if (!discoveryCapabilities(s).pullRequests) return { status: 'unknown', pulls: [], complete: false, error: 'No forge adapter configured; PR exclusivity cannot be established.' };
  try {
    const pulls = ticketPulls(s, id, branch);
    return { status: pulls.length ? 'found' : 'absent', pulls, complete: true };
  } catch (error) { return { status: 'unknown', pulls: [], complete: false, error: error.message }; }
}
