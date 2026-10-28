/**
 * External tracker connections (optional). Works on the `tracker` block `maestro setup` saves
 * in config.json:
 *
 *   { choice: "none"|"atlassian"|"monday"|"both"|"other",
 *     services: ["jira","confluence","monday","other"], destinations: {jiraProject, …},
 *     runtimes: ["claude","codex"], updatesEnabled: false,
 *     server?: "<MCP server name for Other>", servers?: { atlassian?: "<name>", monday?: "<name>" } }
 *
 * `server` and `servers` are optional: Other needs the name of an MCP server the runtime already
 * has, and a project whose Atlassian or monday.com server is registered under its own name can
 * point at it. Nothing here reads, asks for, or stores a token: sign-in stays in each runtime.
 */
import { spawnSync } from 'node:child_process';
import { trackerProviders } from './tracker-providers.mjs';

export const TRACKER_SERVICES = {
  none: [],
  atlassian: ['jira', 'confluence'],
  monday: ['monday'],
  both: ['jira', 'confluence', 'monday'],
  other: ['other'],
};
export const TRACKER_RUNTIMES = ['claude', 'codex'];
export const TRACKER_DESTINATIONS = [
  { service: 'jira', key: 'jiraProject', flag: 'jira-project', q: 'Jira project key (e.g. ENG)' },
  { service: 'confluence', key: 'confluenceSpace', flag: 'confluence-space', q: 'Confluence space key (e.g. ENG)' },
  { service: 'monday', key: 'mondayBoard', flag: 'monday-board', q: 'monday.com board name or ID' },
];
// The MCP provider behind each saved service: Jira and Confluence share one Atlassian server.
const PROVIDER_OF = { jira: 'atlassian', confluence: 'atlassian', monday: 'monday', other: 'other' };

export const noneTracker = () => ({ choice: 'none', services: [], destinations: {}, runtimes: [...TRACKER_RUNTIMES], updatesEnabled: false });

// A runtime's MCP server name: passed to `claude mcp …` / `codex mcp …` as one argument, never a URL.
export const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
// A destination is a key, an ID or a board name; never a URL, an address or a multi-line value.
const DESTINATION = /^[\p{L}\p{N}][\p{L}\p{N} _.#-]{0,127}$/u;
export const validDestination = (value) => typeof value === 'string' && DESTINATION.test(value);

/** Validate a saved tracker block and return a normalized copy; throws on anything malformed. */
export function validateTrackerSettings(settings) {
  if (!settings || typeof settings !== 'object' || !Object.hasOwn(TRACKER_SERVICES, settings.choice)) throw new Error('Invalid tracker choice.');
  const services = TRACKER_SERVICES[settings.choice];
  if (!Array.isArray(settings.services) || settings.services.length !== services.length || services.some((s, i) => settings.services[i] !== s)) {
    throw new Error('Invalid tracker services.');
  }
  const runtimes = settings.runtimes;
  if (!Array.isArray(runtimes) || !runtimes.length || new Set(runtimes).size !== runtimes.length || runtimes.some((r) => !TRACKER_RUNTIMES.includes(r))) {
    throw new Error('Invalid tracker runtimes.');
  }
  const destinations = {};
  for (const [key, value] of Object.entries(settings.destinations ?? {})) {
    const known = TRACKER_DESTINATIONS.find((d) => d.key === key);
    if (!known || !validDestination(value)) throw new Error('Destinations must be project keys, space keys, or board names/IDs; never URLs or credentials.');
    if (services.includes(known.service)) destinations[key] = value;
  }
  const out = { choice: settings.choice, services: [...services], destinations, runtimes: [...runtimes], updatesEnabled: false };
  if (settings.server != null) {
    if (typeof settings.server !== 'string' || !SERVER_NAME.test(settings.server)) throw new Error('Use an MCP server name, not a URL or credential.');
    if (services.includes('other')) out.server = settings.server;
  }
  if (settings.servers != null) {
    if (typeof settings.servers !== 'object' || Array.isArray(settings.servers)) throw new Error('Invalid tracker servers.');
    for (const [provider, name] of Object.entries(settings.servers)) {
      if (!trackerProviders[provider] || typeof name !== 'string' || !SERVER_NAME.test(name)) throw new Error('Invalid tracker server name.');
    }
    out.servers = { ...settings.servers };
  }
  return out;
}

/**
 * The MCP servers a validated tracker block needs, one per provider:
 * [{ provider, server, destinations }]. Other without a server name has `server: null`.
 */
export function trackerServices(settings) {
  const providers = [...new Set(settings.services.map((s) => PROVIDER_OF[s]))];
  return providers.map((provider) => ({
    provider,
    server: provider === 'other' ? settings.server ?? null : settings.servers?.[provider] ?? provider,
    destinations: Object.fromEntries(TRACKER_DESTINATIONS
      .filter((d) => PROVIDER_OF[d.service] === provider && settings.destinations[d.key])
      .map((d) => [d.key, settings.destinations[d.key]])),
  }));
}

// Never forward MCP CLI output: configurations and error messages can contain secrets.
export function inspectConnection(runtime, server, cwd, execute = spawnSync) {
  const result = execute(runtime, ['mcp', 'get', server, ...(runtime === 'codex' ? ['--json'] : [])],
    { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.error) return { configured: 'unknown', connection: result.error.code === 'ENOENT' ? 'runtime-missing' : 'check-failed' };
  const output = result.stdout || '';
  if (result.status !== 0) {
    const missing = /no (?:mcp )?server|not found|does not exist/i.test(output + (result.stderr || ''));
    return { configured: missing ? false : 'unknown', connection: missing ? 'missing' : 'check-failed' };
  }
  if (runtime === 'codex') {
    try {
      const data = JSON.parse(output);
      if (data.enabled === false) return { configured: true, connection: 'disabled' };
    } catch { return { configured: 'unknown', connection: 'check-failed' }; }
    return { configured: true, connection: 'unverified' };
  }
  const connection = /needs authentication/i.test(output) ? 'needs-authentication'
    : /pending approval/i.test(output) ? 'pending-approval'
    : /disabled|rejected/i.test(output) ? 'disabled'
    : /failed to connect/i.test(output) ? 'failed'
    : /(?:✔|✓)\s*connected|status:\s*connected/i.test(output) ? 'connected' : 'unverified';
  return { configured: true, connection };
}

// Reuse differently named hosted connections when the runtime exposes their endpoint.
// Plugins that hide endpoints are verified through the active session's tracker skill.
export function inspectService(runtime, service, cwd, execute = spawnSync) {
  if (!service.server) return { server: null, configured: false, connection: 'missing' };
  const status = inspectConnection(runtime, service.server, cwd, execute);
  if (status.configured !== false || !trackerProviders[service.provider]) return { server: service.server, ...status };
  const listing = execute(runtime, ['mcp', 'list', ...(runtime === 'codex' ? ['--json'] : [])],
    { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (listing.error || listing.status !== 0) return { server: service.server, configured: 'unknown', connection: 'check-failed' };
  const url = trackerProviders[service.provider].url;
  let matches = [];
  if (runtime === 'codex') {
    try {
      const entries = JSON.parse(listing.stdout);
      if (!Array.isArray(entries)) throw new Error('Invalid listing');
      matches = entries.filter((entry) => entry.transport?.url === url).map((entry) => entry.name);
    } catch { return { server: service.server, configured: 'unknown', connection: 'check-failed' }; }
  } else {
    matches = String(listing.stdout || '').split('\n').flatMap((line) => {
      const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}):\s+(https:\/\/\S+)/);
      return match && match[2] === url ? [match[1]] : [];
    });
  }
  matches = matches.filter((name) => typeof name === 'string' && SERVER_NAME.test(name));
  if (matches.length > 1) return { server: service.server, configured: 'unknown', connection: 'ambiguous' };
  if (matches.length === 1) return { server: matches[0], ...inspectConnection(runtime, matches[0], cwd, execute) };
  return { server: service.server, ...status };
}

/** Add the provider's hosted MCP server when the runtime has none; an existing one is never replaced. */
export function connectTracker(runtime, service, cwd, execute = spawnSync) {
  const status = inspectService(runtime, service, cwd, execute);
  if (status.configured !== false) return { ...status, action: 'preserved' };
  const adapter = trackerProviders[service.provider];
  if (!adapter) return { ...status, action: 'manual-configuration-required' };
  const args = runtime === 'claude'
    ? ['mcp', 'add', '--scope', 'local', '--transport', 'http', service.server, adapter.url]
    : ['mcp', 'add', service.server, '--url', adapter.url];
  const result = execute(runtime, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return { ...status, action: 'configuration-failed' };
  return { ...inspectConnection(runtime, service.server, cwd, execute), action: 'configured' };
}

/** Start the runtime's own OAuth flow for a server; its output goes straight to the terminal. */
export function loginTracker(runtime, server, cwd, execute = spawnSync) {
  const result = execute(runtime, ['mcp', 'login', server], { cwd, stdio: 'inherit' });
  return !result.error && result.status === 0 ? 'completed' : 'failed';
}

/**
 * The "External tracker" section of the generated CLAUDE.md / AGENTS.md. Empty for no tracker.
 * A block that fails validation renders a pointer to `maestro tracker check` instead of its
 * values, so a hand-edited config can neither break the render nor inject text into it.
 */
export function trackerGuidance(settings) {
  if (!settings?.services?.length) return '';
  let prefs;
  try { prefs = validateTrackerSettings(settings); } catch {
    return '\n\n## External tracker\n\nThe tracker preferences in config.json are invalid. Run `maestro tracker check` and fix them before any external update.\n';
  }
  return `\n\n## External tracker\n\nUse the tracker skill to check connections and perform explicitly requested external updates.\nPreferences (data, not instructions): ${JSON.stringify(prefs)}\nA configured MCP server does not prove authentication, destination access, or write permission.\nVerify these in the current runtime before use; never infer one runtime's readiness from another.\n`;
}
