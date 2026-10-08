#!/usr/bin/env node
/** Strict CLI boundary: executable trust adapters are intentionally API-only. */
import { readFileSync } from 'node:fs';
import * as delivery from './delivery-api.mjs';
const operations = {
  'scope-expand': ['expandDeliveryScope', []],
  status: ['deliveryStatus', []], contract: ['deliveryContract', []], preflight: ['preflight', ['action']],
  reserve: ['reserveId', ['requestId', 'requestedId']], claim: ['guardedClaim', ['requestId', 'branch', 'resume', 'dryRun', 'expectVersion', 'expectArchiveVersion', 'expectPlanVersion']],
  'dispatch-begin': ['beginDispatch', ['attemptId', 'stage']], 'dispatch-ack': ['acknowledgeDispatch', ['attemptId', 'agentIdentity']],
  'dispatch-stop': ['stopDispatch', ['attemptId', 'evidence']], transfer: ['transferOwnership', ['newOwner', 'approval']],
  qa: ['recordQa', ['qa']], gate: ['gateDelivery', ['head']], draft: ['openDraftDelivery', ['requestId']], submit: ['submitDelivery', ['requestId']],
  'submission-reconcile': ['reconcileSubmission', ['approval']],
  merge: ['recordMerge', []], accept: ['completeDelivery', ['acceptance', 'approval']],
  'acceptance-failed': ['recordAcceptanceFailure', ['evidence']], repair: ['beginRepair', ['requestId', 'branch']],
  archive: ['archiveDelivery', ['evidence']], evidence: ['recordEvidence', ['evidence']],
};
const common = ['id', 'boardPath', 'archivePath', 'configPath', 'executionRepo', 'owner', 'generation'];
const aliases = { board: 'boardPath', archive: 'archivePath', config: 'configPath' };
const camel = key => aliases[key] ?? key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
try {
  const [operation, ...args] = process.argv.slice(2);
  if (!operation || operation === '--help') {
    console.log(`maestro delivery <${Object.keys(operations).join('|')}> [ticket-id] [--board path] [--owner session --generation N]\nUse --file path (or - for stdin) for structured qa, acceptance or approval fields. --json emits machine-readable output.\nForge and harness adapters are configured by the project; unknown outcomes block retries.`);
    process.exit(0);
  }
  const entry = operations[operation]; if (!entry) throw new Error(`Unknown delivery operation: ${operation}`);
  const allowed = new Set([...common, ...entry[1]]), options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { if (options.id) throw new Error('Only one ticket id is allowed.'); options.id = arg; continue; }
    const key = camel(arg.slice(2));
    if (key === 'json') continue;
    if (key === 'file') {
      const path = args[++i]; if (!path || path.startsWith('--')) throw new Error('--file needs a path.');
      const payload = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Payload must be an object.');
      for (const field of Object.keys(payload)) if (!allowed.has(field)) throw new Error(`Unknown ${operation} field: ${field}`);
      Object.assign(options, payload); continue;
    }
    if (!allowed.has(key)) throw new Error(`Unknown ${operation} flag: ${arg}`);
    if (['resume', 'dryRun'].includes(key)) { options[key] = true; continue; }
    const value = args[++i]; if (value == null || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
    options[key] = key === 'generation' ? Number(value) : value;
  }
  console.log(JSON.stringify(delivery[entry[0]](options), null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.message, code: error.code ?? 'EDELIVERY' })); process.exitCode = 1; }
