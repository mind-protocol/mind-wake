import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createRequest, validateRequest, amountAtomic, RequestRegistry, registryPath, MIND_MINT, NETWORK } from '../services/agent-requests/index.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'agent-request.mjs');
const trial = (id = 'trial-1') => createRequest({ id, type: 'free_trial', agent: 'example-agent', purpose: 'Relire un paragraphe et citer une ambiguïté.' });
const faucet = () => createRequest({ id: 'faucet-1', type: 'faucet', agent: 'example-agent', purpose: 'Demande manuelle de test non financée.', wallet: '11111111111111111111111111111111', network: NETWORK, mint: MIND_MINT, amount: '1.000000001', amount_mode: 'gross' });
const privateDir = () => mkdtempSync(join(tmpdir(), 'mind-requests-test-'));
function run(args, input) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input }); }
function parallel(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore','pipe','pipe'] });
    let out = '', error = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, out, error }));
  });
}

test('free trial is usable without a wallet; envelopes reject unrelated/secret fields and invalid dates', () => {
  const request = trial();
  assert.equal(request.wallet, undefined);
  assert.equal(validateRequest(request).type, 'free_trial');
  assert.throws(() => validateRequest({ ...request, private_key: 'not-a-key' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateRequest({ ...request, created_at: '2026-02-31T12:00:00Z' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateRequest({ ...request, wallet: '11111111111111111111111111111111' }), { code: 'INVALID_REQUEST' });
});

test('faucet validates the asset, address, explicit amount basis and exact u64 amount', () => {
  const request = faucet();
  assert.equal(amountAtomic(request.amount), '1000000001');
  for (const patch of [{ mint: '11111111111111111111111111111111' }, { network: 'devnet' }, { wallet: 'invalid' }, { amount: 1 }, { amount: '0' }, { amount: '1e3' }, { amount: '0.0000000001' }, { amount: '18446744073.709551616' }, { amount_mode: 'automatic' }]) {
    assert.throws(() => validateRequest({ ...request, ...patch }), { code: 'INVALID_REQUEST' });
  }
  assert.equal(amountAtomic('18446744073.709551615'), '18446744073709551615');
});

test('record survives reopen, deduplicates reordered envelopes and refuses changed identity', () => {
  const dir = privateDir(), request = trial();
  let registry = new RequestRegistry(dir);
  assert.equal(registry.record(request).inserted, true); registry.close();
  registry = new RequestRegistry(dir);
  try {
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    assert.equal(registry.record(reordered).inserted, false);
    assert.equal(registry.history(request.id).length, 1);
    assert.throws(() => registry.record({ ...request, purpose: 'Autre besoin.' }), { code: 'ID_CONFLICT' });
    assert.equal(registry.get(request.id).funding, 'not_processed');
  } finally { registry.close(); }
});

test('manual review has no funding transition and refusal cannot be silently rewritten', () => {
  const registry = new RequestRegistry(privateDir()), request = trial();
  try {
    registry.record(request);
    assert.equal(registry.review(request.id, 'seen').changed, true);
    assert.equal(registry.review(request.id, 'seen').changed, false);
    assert.throws(() => registry.review(request.id, 'paid'), { code: 'INVALID_STATE' });
    assert.equal(registry.review(request.id, 'declined', 'Périmètre indisponible.').changed, true);
    assert.equal(registry.review(request.id, 'declined', 'Périmètre indisponible.').changed, false);
    assert.throws(() => registry.review(request.id, 'declined', 'Autre motif.'), { code: 'REVIEW_CONFLICT' });
    assert.throws(() => registry.review(request.id, 'seen'), { code: 'INVALID_TRANSITION' });
    assert.equal(registry.history(request.id).length, 3);
  } finally { registry.close(); }
});

test('unknown registry schema is refused without resetting its version', () => {
  const dir = privateDir(), path = registryPath(dir);
  const db = new Database(path); db.pragma('user_version = 42'); db.close();
  assert.throws(() => new RequestRegistry(dir), { code: 'REGISTRY_VERSION' });
  const check = new Database(path, { readonly: true });
  assert.equal(check.pragma('user_version', { simple: true }), 42); check.close();
});

test('CLI creates and validates public JSON; listing an absent queue does not create it', () => {
  const dir = join(privateDir(), 'absent');
  const made = run(['create','--type','free_trial','--agent','example','--purpose','Lire une scène.','--id','cli-trial']);
  assert.equal(made.status, 0, made.stderr);
  const validated = run(['validate','-'], made.stdout);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).funding, 'not_processed');
  assert.equal(run(['list','--data-dir',dir]).status, 0);
  assert.equal(existsSync(dir), false);
  assert.notEqual(run(['create','--type','free_trial','--agent','example','--purpose','Read','--state','paid']).status, 0);
});

test('eight concurrent CLI deliveries of one envelope create one request and one event', async () => {
  const dir = privateDir(), file = join(privateDir(), 'request.json');
  writeFileSync(file, JSON.stringify(trial('same-delivery')));
  const results = await Promise.all(Array.from({ length: 8 }, () => parallel(['record',file,'--data-dir',dir])));
  for (const result of results) assert.equal(result.code, 0, result.error);
  assert.equal(results.filter(result => JSON.parse(result.out).inserted).length, 1);
  const registry = new RequestRegistry(dir);
  try { assert.equal(registry.list().length, 1); assert.equal(registry.history('same-delivery').length, 1); }
  finally { registry.close(); }
});
