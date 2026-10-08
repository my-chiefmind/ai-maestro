import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { planItems } from './plan-core.mjs';
import { scopeDigest } from './delivery-policy.mjs';
import { requireValue } from './delivery-values.mjs';
export function deliveryInputs(context, s, ticket) {
  const relativePath = path => {
    const full = resolve(s.repo, path);
    requireValue(relative(s.repo, full) && !relative(s.repo, full).startsWith('..'), 'Delivery context path must be inside the repo.');
    return existsSync(full) ? readFileSync(full, 'utf8') : '';
  };
  const specPath = join(dirname(context.dataPath), 'specs', `${ticket.id}.md`);
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';
  const items = planItems(context.plan);
  const traced = (ticket.traces_to ?? []).map(id => {
    const item = items.get(id); requireValue(item, `Unknown plan trace ${id}.`); return item;
  });
  const command = ticket.testCmd || context.config?.orchestrator?.testCmd?.[ticket.area];
  requireValue(typeof command === 'string' && command.trim(), 'A real ticket or area test command is required.');
  const extra = s.policy.checks ?? [];
  requireValue(Array.isArray(extra) && extra.every(c => typeof c === 'string' && c.trim()), 'delivery.checks must be command strings.');
  const checks = [...new Set([command, ...extra, ...traced.map(i => i.enforce).filter(Boolean)])];
  const paths = s.policy.contextPaths ?? [];
  requireValue(Array.isArray(paths) && paths.every(p => typeof p === 'string'), 'delivery.contextPaths must be paths.');
  const { trustedApprovals: _trust, ...deliveryPolicy } = s.policy;
  const policy = { delivery: deliveryPolicy, checks, context: paths.map(p => [p, relativePath(p)]) };
  return { checks, scope: scopeDigest(ticket, { spec, planItems: traced, policy }) };
}
