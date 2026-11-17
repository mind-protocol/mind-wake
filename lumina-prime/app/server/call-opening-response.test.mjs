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
