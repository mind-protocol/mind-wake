import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpeningResponder, openingResponseText } from './call-opening-response.mjs';
import { createCallService } from './chat-call.mjs';

test('published room signatures match the call transcript filters', () => {
  assert.equal(openingResponseText({ prefix: '🤍 Gardien · ' }, 'Bonjour'), '🤍 Gardien · Bonjour');
  assert.equal(openingResponseText({ agent: { name: 'VOX' } }, 'Bonjour'), 'VOX : Bonjour');
});

test('opening and adding request one turn without waking autonomous agents; removal cancels it', async () => {
  const turns = [];
  let wakes = 0;
  const call = createCallService({ sendMain: async () => ({}), mainReplies: async () => [], speak: async () => Buffer.alloc(0),
    wakeMain: () => wakes++, noticeMain: () => true, noticeRoom: () => true,
    handleTable: () => new Map([['a', { room: 1, agent: { id: 'a', name: 'A' }, label: 'A' }]]),
    answerCall: request => { turns.push(request); }, mirrorIntervalMs: 0 });
  try {
    call.openSession('owner', 'b5ad6e40-7e6b-4582-a5f5-0196eae36402', 1, ['mind']);
    call.openSession('owner', 'b5ad6e40-7e6b-4582-a5f5-0196eae36402', 1, ['mind']);
    call.addSession('owner', 'b5ad6e40-7e6b-4582-a5f5-0196eae36402', 1, ['a'], 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(turns.map(t => t.target.handle), ['mind', 'a']);
    assert.equal(wakes, 0);
    assert.equal(turns[1].active(), true);
    call.removeSession('owner', 'b5ad6e40-7e6b-4582-a5f5-0196eae36402', 1, ['a'], 2);
    assert.equal(turns[1].active(), false);
    call.endSession('owner', 'b5ad6e40-7e6b-4582-a5f5-0196eae36402', 1);
    assert.equal(turns[0].active(), false);
  } finally { call.stop(); }
});

test('one response per called agent, durable across retries and gateway restarts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'call-opening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let generated = 0;
  const published = [];
  const options = { directory, prepare: async () => ({}), generate: async () => { generated++; return { text: 'Bonjour' }; },
    publish: async (request, text) => published.push([request.target.agentId, text]) };
  const request = { id: 'call-1', target: { kind: 'agent', agentId: 'a' }, active: () => true };
  const answer = createOpeningResponder(options);
  await Promise.all([answer(request), answer(request)]);
  await createOpeningResponder(options)(request);
  await answer({ ...request, target: { kind: 'agent', agentId: 'b' } });
  assert.equal(generated, 2);
  assert.deepEqual(published, [['a', 'Bonjour'], ['b', 'Bonjour']]);
});

test('hangup before or during generation prevents publication', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'call-opening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let active = false, generated = 0, published = 0;
  const answer = createOpeningResponder({ directory, prepare: async () => ({}),
    generate: async () => { generated++; active = false; return { text: 'Too late' }; },
    publish: async () => { published++; } });
  const request = { id: 'call-2', target: { kind: 'main', agentId: 'main' }, active: () => active };
  await answer(request);
  assert.equal(generated, 0);
  active = true;
  await answer(request);
  assert.equal(generated, 1);
  assert.equal(published, 0);
});

// --- Lot 2 (NLR, 18 nov. 2026 14:47) : un décroché, un préfixe ---------------------------------
test('the name already written at the head is not prefixed twice', () => {
  assert.equal(openingResponseText({ kind: 'main', label: 'Marco' }, 'Marco : Marco : Salut NLR, je décroche.'), 'Marco : Salut NLR, je décroche.');
  assert.equal(openingResponseText({ kind: 'main', label: 'Marco' }, 'Marco est là.'), 'Marco : Marco est là.');
  assert.equal(openingResponseText({ prefix: '🕸️ Coach des coachs · ' }, '🕸️ Coach des coachs · Je décroche.'), '🕸️ Coach des coachs · Je décroche.');
  assert.equal(openingResponseText({ agent: { name: 'VOX' } }, 'vox: Bonjour'), 'VOX : Bonjour');
});

test('an agent that already answered gets no automatic pick-up, before or during generation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'call-opening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let spoke = true, generated = 0, published = 0;
  const answer = createOpeningResponder({ directory, prepare: async () => ({}),
    generate: async () => { generated++; spoke = true; return { text: 'Salut' }; }, publish: async () => { published++; } });
  const base = { target: { kind: 'main', agentId: 'marco' }, active: () => true, answered: async () => spoke };
  await answer({ ...base, id: 'before' });
  assert.equal(generated, 0);
  spoke = false;
  await answer({ ...base, id: 'during' });
  assert.equal(generated, 1);
  assert.equal(published, 0);
  const states = fs.readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(directory, f))).state);
  assert.deepEqual(states.sort(), ['answered', 'answered']);
});

/** Rejeu de 14:47 : NLR appelle, Marco décroche lui-même, NLR raccroche et rappelle 29 s plus tard. */
function replay(t, { marcoAnswers }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'call-opening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-18T14:47:15.524Z');
  const iso = () => new Date(clock).toISOString();
  const main = []; const notices = []; const pending = []; const generated = [];
  const responder = createOpeningResponder({ directory, prepare: async () => ({}),
    generate: async request => {
      generated.push(request.id);
      clock += 4000;
      if (marcoAnswers) main.push({ id: 'own_8c3e2c36', role: 'agent', at: iso(), text: 'Marco : Salut, je décroche. Le point : le pair-à-pair et la transcription sont finis.' });
      clock += 12_000;
      return { text: 'Marco : Salut NLR, je décroche. Le pair-à-pair est terminé et ses tests passent.' };
    },
    publish: async (request, text) => { main.push({ id: `own_${main.length}`, role: 'agent', at: iso(), text: openingResponseText(request.target, text) }); } });
  const call = createCallService({ mainLabel: 'Marco', mainAgentId: 'marco', now: () => clock, mirrorIntervalMs: 0,
    sendMain: async () => ({ at: iso() }), mainReplies: async () => main, speak: async () => Buffer.alloc(0),
    noticeMain: async (key, text) => { notices.push(text); }, answerCall: request => { pending.push(responder(request)); } });
  t.after(() => call.stop());
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await Promise.all(pending); };
  return { call, main, notices, generated, settle, tick: ms => { clock += ms; } };
}

test('replay 14:47: Marco picked up himself, so neither the call nor its redial publishes another pick-up', async t => {
  const r = replay(t, { marcoAnswers: true });
  r.call.openSession('owner', '25bd94df-8a0f-4748-a306-1e24ac2a39ec', 1, ['mind']);
  await r.settle();
  r.call.endSession('owner', '25bd94df-8a0f-4748-a306-1e24ac2a39ec', 1);
  r.tick(13_000);
  r.call.openSession('owner', '6f0efe48-3de4-4d1b-aec1-d61350a73472', 1, ['mind']);
  await r.settle();
  assert.deepEqual(r.main.map(m => m.text), ['Marco : Salut, je décroche. Le point : le pair-à-pair et la transcription sont finis.']);
  assert.equal(r.generated.length, 1, 'the redial does not even generate');
  assert.equal(r.notices.length, 1, 'one « NLR t’appelle » for the exchange');
});

test('replay with Marco asleep: one pick-up, prefixed once; a redial reuses it; a later call rings again', async t => {
  const r = replay(t, { marcoAnswers: false });
  r.call.openSession('owner', '25bd94df-8a0f-4748-a306-1e24ac2a39ec', 1, ['mind']);
  await r.settle();
  r.call.endSession('owner', '25bd94df-8a0f-4748-a306-1e24ac2a39ec', 1);
  r.tick(13_000);
  r.call.openSession('owner', '6f0efe48-3de4-4d1b-aec1-d61350a73472', 1, ['mind']);
  await r.settle();
  assert.deepEqual(r.main.map(m => m.text), ['Marco : Salut NLR, je décroche. Le pair-à-pair est terminé et ses tests passent.']);
  assert.deepEqual((await r.call.replies('mind', new Date(0).toISOString())).map(i => [i.speaker, i.text]).slice(0, 1),
    [['Marco', 'Salut NLR, je décroche.']]);
  assert.equal(r.notices.length, 1);
  r.call.endSession('owner', '6f0efe48-3de4-4d1b-aec1-d61350a73472', 1);
  r.tick(10 * 60_000);
  r.call.openSession('owner', '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 1, ['mind']);
  await r.settle();
  assert.equal(r.notices.length, 2);
  assert.equal(r.main.length, 2);
});
