import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import { createChatReportStore } from './chat-reports.mjs';
import { createChatServer } from './chat-server.mjs';
import { pairChat } from '../src/chat/client.ts';
import { draftReport, sendReport } from '../src/chat/report.ts';
const code = 'fixture-pairing-code-only';
const id = 'report-382582c4-90f8-4dfb-910d-6c976ad77247';
const message = { id: 'fixture-agent', role: 'agent', status: 'published', text: 'Selected fixture', version: 1, at: new Date().toISOString() };
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-report-'));
  const file = path.join(dir, 'reports.sqlite');
  let store = createChatReportStore(file); let sends = 0;
  const messages = [message, { ...message, id: 'unselected', text: 'PRIVATE UNSELECTED' }];
  const bridge = { snapshot: async () => messages, send: async () => { sends++; throw Error('must not dispatch'); } };
  const service = createChatServer({ bridge, pairingCode: code, reportStore: {
    existing: input => store.existing(input), record: input => store.record(input),
  }, ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => { await service.close(); store.close(); fs.rmSync(dir, { recursive: true }); });
  const session = await pairChat(url, code);
  const request = (input, token = session.token, route = '/chat/reports') => fetch(url + route, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { file, session, request, messages, sends: () => sends,
    restartStore() { store.close(); store = createChatReportStore(file); } };
}
test('selected response only; durable reception, concurrent retries and lost acknowledgement', async t => {
  const h = await setup(t); const input = draftReport(message, id);
  // Editing/reviewing/cancelling are pure local operations: no transport call.
  assert.equal(h.sends(), 0);
  const cancelled = draftReport(message, id); cancelled.comment = 'cancelled';
  const dbBefore = new DatabaseSync(h.file); assert.equal(dbBefore.prepare('SELECT count(*) AS n FROM chat_reports').get().n, 0); dbBefore.close();
  let calls = 0;
  const loseReceipt = async (...args) => { calls++; await fetch(...args); throw Error('lost acknowledgement'); };
  await assert.rejects(sendReport(h.session, input, loseReceipt));
  h.restartStore(); h.messages.length = 0; // retry remains valid after history pruning / storage reopen
  const results = await Promise.all([sendReport(h.session, input), sendReport(h.session, input)]);
  assert.ok(results.every(r => r.duplicate && r.status === 'stored_local'));
  assert.equal(calls, 1); assert.equal(h.sends(), 0);
  const db = new DatabaseSync(h.file); const rows = db.prepare('SELECT * FROM chat_reports').all(); db.close();
  assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0].payload), input);
  assert.equal(JSON.stringify(rows).includes('PRIVATE UNSELECTED'), false);
  assert.equal(JSON.stringify(rows).includes(h.session.token), false);
  assert.equal((await h.request({ ...input, comment: 'different' })).status, 409);
});
test('rejects unpaired, extra history/identity, human, changed, oversized and query inputs', async t => {
  const h = await setup(t); const input = draftReport(message, id);
  assert.throws(() => draftReport({ ...message, role: 'human' }, id));
  assert.equal((await h.request(input, '')).status, 401);
  for (const extra of [{ history: [] }, { email: 'fixture' }, { reason: 'invalid' }, { comment: 'x'.repeat(1001) }, { text: 'x'.repeat(12001) }, { id: 123 }])
    assert.equal((await h.request({ ...input, ...extra })).status, 400);
  assert.equal((await h.request(input, h.session.token, '/chat/reports?owner=other')).status, 400);
  assert.equal((await h.request({ ...input, text: 'not selected' })).status, 409);
  h.messages[0] = { ...message, role: 'human' };
  assert.equal((await h.request(input)).status, 409);
  assert.equal(h.sends(), 0);
});
test('unconfigured or failing receiver and malformed acknowledgements never succeed; retry works', async t => {
  const off = await setup(t, { reportStore: null }); const input = draftReport(message, id);
  await assert.rejects(sendReport(off.session, input), /reports_unavailable/);
  let fail = true; const disk = await setup(t, { reportStore: {
    existing: () => null, record: () => { if (fail) throw Error('disk full fixture'); return {}; },
  } });
  await assert.rejects(sendReport(disk.session, input)); fail = false;
  await assert.rejects(sendReport(disk.session, input), /invalid_response/);
  const h = await setup(t);
  const external = { ...h.session, url: 'https://external.invalid' };
  await assert.rejects(sendReport(external, input));
  assert.equal((await sendReport(h.session, input)).status, 'stored_local');
});
test('a failed write can be retried with the same id; long responses use an explicit bounded excerpt', async t => {
  const h = await setup(t);
  const long = { ...message, text: 'é'.repeat(14000) };
  h.messages[0] = long;
  const input = draftReport(long, id);
  assert.equal(input.text.length, 12000);
  const response = await sendReport(h.session, input);
  assert.equal(response.status, 'stored_local');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-report-retry-'));
  const file = path.join(dir, 'retry.sqlite');
  const store = createChatReportStore(file); let fail = true;
  const service = createChatServer({ pairingCode: code,
    bridge: { snapshot: async () => [message], send: async () => assert.fail('model dispatch') },
    reportStore: { existing: v => store.existing(v), record: v => {
      if (fail) { fail = false; throw Error('temporary write failure'); } return store.record(v);
    } },
  });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.close(); store.close(); fs.rmSync(dir, { recursive: true }); });
  const session = await pairChat(`http://127.0.0.1:${service.server.address().port}`, code);
  const report = draftReport(message, id);
  await assert.rejects(sendReport(session, report));
  assert.equal((await sendReport(session, report)).duplicate, false);
  assert.equal((await sendReport(session, report)).duplicate, true);
});
test('UTF-8 and maximum JSON escaping fit report-only budget; other routes keep 20k', async t => {
  const h = await setup(t);
  const worst = { ...message, id: '\u0000'.repeat(256), text: '\u0000'.repeat(12000) };
  h.messages[0] = worst;
  const input = { ...draftReport(worst, id), comment: '\u0000'.repeat(1000) };
  const bytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(bytes > 79000 && bytes < 80000);
  assert.equal((await sendReport(h.session, input)).status, 'stored_local');
  const response = await h.request({ id: 'chat-382582c4-90f8-4dfb-910d-6c976ad77247', text: 'é'.repeat(11000) }, h.session.token, '/chat/messages');
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'body_too_large');
});
