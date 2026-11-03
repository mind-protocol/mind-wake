#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequest, validateRequest, RequestRegistry, defaultDataDir, registryPath, RequestError, NETWORK, MIND_MINT } from '../services/agent-requests/index.mjs';

const HELP = `Local manual requests. No network, payment, signature or wallet creation.
  create --type free_trial --agent HANDLE --purpose TEXT [--id ID] [--reply-to PUBLIC_CHANNEL]
  create --type faucet --agent HANDLE --purpose TEXT --wallet ADDRESS --amount DECIMAL --amount-mode gross|net [--id ID]
  validate FILE|-       Validate an envelope without registering it.
  record FILE|-         Store a manual request idempotently.
  list [--state requested|seen|declined] [--type free_trial|faucet]
  show ID              Show a recorded request and review history.
  seen ID              Mark it read; no funding or entitlement.
  decline ID --reason TEXT
  --data-dir DIRECTORY overrides the private profile directory.
Faucet creation fixes network ${NETWORK} and mint ${MIND_MINT}.
Send only the resulting public request through an agreed channel to Marco.
`;
function parseArgs(argv) {
  const positionals = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (name === 'help') { flags.help = true; continue; }
    if (!['type','agent','purpose','id','reply-to','wallet','amount','amount-mode','data-dir','state','reason'].includes(name) || flags[name] !== undefined) throw new RequestError('INVALID_ARGUMENT', 'Unknown or repeated option');
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new RequestError('INVALID_ARGUMENT', `Missing value for --${name}`);
    flags[name] = argv[++i];
  }
  return { positionals, flags };
}
function readRequest(path) {
  if (!path) throw new RequestError('INVALID_ARGUMENT', 'A JSON file or - is required');
  const bytes = readFileSync(path === '-' ? 0 : path);
  if (bytes.length > 16_384) throw new RequestError('INVALID_REQUEST', 'Request exceeds 16 KiB');
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')); }
  catch { throw new RequestError('INVALID_JSON', 'Request must be JSON'); }
}
export function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  const [command, argument, ...extra] = positionals;
  if (flags.help || !command) return HELP;
  if (extra.length) throw new RequestError('INVALID_ARGUMENT', 'Too many arguments');
  const commandFlags = {
    create: ['type','agent','purpose','id','reply-to','wallet','amount','amount-mode'], validate: [],
    record: ['data-dir'], list: ['data-dir','state','type'], show: ['data-dir'], seen: ['data-dir'], decline: ['data-dir','reason'],
  }[command];
  if (!commandFlags || Object.keys(flags).some(flag => !commandFlags.includes(flag))) throw new RequestError('INVALID_ARGUMENT', 'Option does not belong to this command');
  if (command === 'create') {
    if (argument) throw new RequestError('INVALID_ARGUMENT', 'create uses named options');
    const fields = { type: flags.type, agent: flags.agent, purpose: flags.purpose };
    if (flags.id !== undefined) fields.id = flags.id;
    if (flags['reply-to'] !== undefined) fields.reply_to = flags['reply-to'];
    if (flags.type === 'faucet') Object.assign(fields, { wallet: flags.wallet, network: NETWORK, mint: MIND_MINT, amount: flags.amount, amount_mode: flags['amount-mode'] });
    else if (flags.wallet || flags.amount || flags['amount-mode']) throw new RequestError('INVALID_ARGUMENT', 'A free trial does not collect wallet fields');
    return createRequest(fields);
  }
  if (command === 'validate') return { valid: true, request: validateRequest(readRequest(argument)), funding: 'not_processed' };
  if (!['record','list','show','seen','decline'].includes(command)) throw new RequestError('INVALID_ARGUMENT', 'Unknown command');
  if (command === 'list' && argument) throw new RequestError('INVALID_ARGUMENT', 'list uses named filters');
  const dataDir = flags['data-dir'] || defaultDataDir();
  const writer = ['record','seen','decline'].includes(command);
  if (!writer && !existsSync(registryPath(dataDir))) {
    if (command === 'list') return { requests: [], funding: 'not_processed' };
    throw new RequestError('NOT_FOUND', 'Request not found');
  }
  const registry = new RequestRegistry(dataDir, { readOnly: !writer });
  try {
    if (command === 'record') return registry.record(readRequest(argument));
    if (command === 'list') return { requests: registry.list({ state: flags.state, type: flags.type }), funding: 'not_processed' };
    if (command === 'show') {
      const record = registry.get(argument);
      if (!record) throw new RequestError('NOT_FOUND', 'Request not found');
      return { ...record, history: registry.history(argument) };
    }
    return registry.review(argument, command === 'seen' ? 'seen' : 'declined', flags.reason);
  } finally { registry.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main();
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    // Do not echo untrusted envelopes, paths, SQL statements or stack traces.
    process.stderr.write(JSON.stringify({ error: error.code || 'REQUEST_FAILED', message: error instanceof RequestError ? error.message : 'Local request operation failed' }) + '\n');
    process.exitCode = 1;
  }
}
