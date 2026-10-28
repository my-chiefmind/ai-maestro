#!/usr/bin/env node
/**
 * maestro tracker check|connect — the MCP side of the optional external tracker.
 *
 * Reads the `tracker` block of config.json (see scripts/tracker-core.mjs). `check` reports each
 * configured service per runtime; `connect` adds a missing hosted server and never replaces an
 * existing one; `connect --login` hands sign-in to the runtime's own OAuth flow. Destination and
 * write access always stay "unverified" here: only the tracker skill, inside a session with the
 * real tools, can establish them.
 *
 * Exit 0: nothing needs attention. 1: a connection needs attention. 2: bad arguments or config.
 * MCP CLI output is never printed, since it can carry tokens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { connectTracker, inspectService, loginTracker, noneTracker, trackerServices, validateTrackerSettings } from './tracker-core.mjs';

const args = process.argv.slice(2);
const op = args.shift();
const options = {};
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--json', '--login'].includes(key)) options[key] = true;
    else if (['--config', '--runtime'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error('Unknown argument or missing value. Use tracker help.');
  }
  if (!op || ['help', '--help'].includes(op)) {
    console.log('maestro tracker check|connect [--config <path>] [--runtime claude|codex] [--json]\nconnect --login starts the selected runtimes’ OAuth flows; Claude also supports /mcp.\nRun the tracker skill in each runtime to verify destination access and write permissions.');
  } else {
    if (!['check', 'connect'].includes(op)) throw new Error('Expected tracker check or connect.');
    if (options['--runtime'] && !['claude', 'codex'].includes(options['--runtime'])) throw new Error('Runtime must be claude or codex.');
    if (options['--login'] && (op !== 'connect' || options['--json'])) throw new Error('--login requires connect without --json.');
    if (options['--login'] && !process.stdin.isTTY) throw new Error('--login requires an interactive terminal.');
    const path = resolve(options['--config'] || (existsSync('maestro/config.json') ? 'maestro/config.json' : 'config.json'));
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const settings = validateTrackerSettings(config.tracker || noneTracker());
    const services = trackerServices(settings);
    const cwd = resolve(dirname(path), config.outDir || '.');
    const runtimes = !services.length ? [] : options['--runtime'] ? [options['--runtime']] : settings.runtimes;
    const results = [];
    for (const runtime of runtimes) {
      if (!settings.runtimes.includes(runtime) || config.targets?.[runtime] === false) throw new Error('Runtime is not enabled for this tracker.');
      for (const service of services) {
        const state = op === 'connect' ? connectTracker(runtime, service, cwd) : inspectService(runtime, service, cwd);
        const row = { runtime, provider: service.provider, server: service.server, ...state, destinationAccess: 'unverified', writeAccess: 'unverified' };
        if (!service.server) row.action = 'manual-configuration-required';
        if (options['--login'] && state.configured === true && state.connection !== 'disabled') {
          row.login = loginTracker(runtime, state.server || service.server, cwd);
          if (row.login === 'completed') Object.assign(row, inspectService(runtime, service, cwd));
        }
        results.push(row);
      }
    }
    if (options['--json']) console.log(JSON.stringify({ results }, null, 2));
    else {
      if (!results.length) console.log('No external tracker selected.');
      for (const row of results) {
        const hint = row.provider === 'other' && !row.server ? ' Set the existing MCP server name with: maestro setup --force --tracker other --tracker-server <name>.' : '';
        console.log(`${row.runtime}/${row.provider}: ${row.connection}${row.action ? ` (${row.action})` : ''}; destination and write access unverified.${hint}`);
      }
      if (results.length) console.log('Sign in: maestro tracker connect --login (older Claude versions: /mcp).\nThen run the tracker skill in each runtime for an authenticated destination read. Retry with maestro tracker check.');
    }
    if (results.some((r) => r.configured !== true || ['failed', 'disabled', 'needs-authentication', 'pending-approval', 'check-failed', 'ambiguous'].includes(r.connection) || r.login === 'failed')) process.exitCode = 1;
  }
} catch {
  console.error('Tracker command failed: check arguments, project config, and runtime availability. Run maestro tracker help. No credentials are printed.');
  process.exitCode = 2;
}
