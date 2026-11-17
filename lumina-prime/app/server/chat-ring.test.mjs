import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatServer } from './chat-server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallbackFileStore, createRingFeed, ringCallback, ringCaller, ringQuestion } from './chat-ring.mjs';
import { mirrorText } from './chat-call.mjs';

test('ringQuestion: trailing question mark or explicit marker rings; statements, copies and SILENCE do not', () => {
  assert.equal(ringQuestion('J’ai fini la maquette. Tu préfères la version bleue ou la verte ?'), 'Tu préfères la version bleue ou la verte ?');
  assert.equal(ringQuestion('Je lance le build.\nOn publie ce soir ? 🙂'), 'On publie ce soir ?');
  assert.equal(ringQuestion('**Je peux pousser la branche ?**'), 'Je peux pousser la branche ?');
  assert.equal(ringQuestion('Le build est prêt. Ok ?'), 'Le build est prêt. Ok ?');
  assert.equal(ringQuestion('[sonner] Le serveur est tombé, il faut ta clé.'), 'Le serveur est tombé, il faut ta clé.');
  assert.equal(ringQuestion('📞 Besoin de toi pour valider le paiement.'), 'Besoin de toi pour valider le paiement.');
  assert.equal(ringQuestion('Pourquoi ? Parce que le cache était vide.'), null);
  assert.equal(ringQuestion('Je continue sur le chantier.'), null);
  assert.equal(ringQuestion('On part là-dessus ? [sans-sonnerie]'), null);
  assert.equal(ringQuestion(mirrorText('VOX', 'Tu viens ?')), null);
  assert.equal(ringQuestion('SILENCE'), null);
  assert.ok(ringQuestion(`${'a'.repeat(300)} ?`).length <= 180);
});

test('ringCaller maps a known prefix to its call target, otherwise the main agent', () => {
  const targets = [{ handle: 'mind', label: 'Marco', kind: 'main' }, { handle: 'vox', label: 'VOX', kind: 'agent', room: 7 },
    { handle: 'crypto', label: '🪙 Crypto', kind: 'holder' }];
  assert.deepEqual(ringCaller('VOX : Je chante quoi ce soir ?', targets), { handle: 'vox', label: 'VOX', text: 'Je chante quoi ce soir ?' });
  assert.equal(ringCaller('🪙 Crypto · On vend ?', targets).handle, 'crypto');
  assert.deepEqual(ringCaller('On publie ?', targets), { handle: 'mind', label: 'Marco', text: 'On publie ?' });
  assert.equal(ringCaller('🦅 Altaïr · On y va ?', targets).label, '🦅 Altaïr');
});

test('ring feed: only new, recent agent questions, never for a target already in a call', async () => {
  const now = Date.parse('2026-11-16T21:00:00Z');
  const at = minutes => new Date(now - minutes * 60_000).toISOString();
  const messages = [
    { id: 'm1', at: at(30), text: 'Vieille question ?', role: 'agent', version: 1 },
    { id: 'm2', at: at(2), text: 'On publie ?', role: 'agent', version: 1 },
    { id: 'chat-x', at: at(2), text: 'Tu es là ?', role: 'human', version: 1 },
    { id: 'm3', at: at(1), text: 'VOX : Je chante quoi ?', role: 'agent', version: 1 },
    { id: 'm4', at: at(1), text: 'C’est fait.', role: 'agent', version: 1 }];
  let active = [];
  const feed = createRingFeed({ snapshot: async () => messages, now: () => now, active: () => active,
    targets: () => [{ handle: 'mind', label: 'Marco', kind: 'main' }, { handle: 'vox', label: 'VOX', kind: 'agent' }] });
  const events = await feed(at(60));
  assert.deepEqual(events.map(e => [e.id, e.handle, e.label, e.question]),
    [['ring:m2:1', 'mind', 'Marco', 'On publie ?'], ['ring:m3:1', 'vox', 'VOX', 'Je chante quoi ?']]);
  assert.deepEqual((await feed(at(2))).map(e => e.messageId), ['m3']);
  active = [{ id: 'c1', handles: ['vox'] }];
  assert.deepEqual((await feed(at(60))).map(e => e.messageId), ['m2']);
  await assert.rejects(feed('pas une date'), /invalid_request/);
});

test('/chat/ring requires a session, validates its query and returns ring events', async t => {
  const messages = [{ id: 'm2', at: new Date().toISOString(), text: 'On publie ?', role: 'agent', version: 1, status: 'published' }];
  const bridge = { snapshot: async () => messages, send: async () => ({ status: 'recorded', at: new Date().toISOString() }) };
  const ring = createRingFeed({ snapshot: bridge.snapshot });
  const service = createChatServer({ bridge, ring, localConnect: true, origins: ['http://localhost:8081'] });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const since = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
  assert.equal((await fetch(`${url}/chat/ring?since=${since}`)).status, 401);
  const { token } = await (await fetch(`${url}/chat/connect-local`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8081' }, body: '{}' })).json();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  assert.equal((await fetch(`${url}/chat/ring?since=${since}&x=1`, auth)).status, 400);
  assert.equal((await fetch(`${url}/chat/ring`, auth)).status, 400);
  const body = await (await fetch(`${url}/chat/ring?since=${since}`, auth)).json();
  assert.equal(body.schema, 'mind.chat.ring.v1');
  assert.deepEqual(body.events.map(e => [e.handle, e.question]), [['mind', 'On publie ?']]);
});

test('ringCallback parses the marker and the spoken phrase, capped at 24 h', () => {
  assert.equal(ringCallback('Je regarde ça. [rappel: 10 min]').delayMs, 600_000);
  assert.equal(ringCallback('Je regarde ça. [rappel: 10 min]').reason, 'Je regarde ça.');
  assert.equal(ringCallback('[rappel: 1 h 30] Je finis le mix.').delayMs, 90 * 60_000);
  assert.equal(ringCallback('[rappel: 2h] ok').delayMs, 2 * 3600_000);
  assert.equal(ringCallback('Ok, je te rappelle dans 15 minutes.').delayMs, 15 * 60_000);
  assert.equal(ringCallback('[rappel: 30 h]'), null);
  assert.equal(ringCallback('Je te rappelle demain.'), null);
  assert.equal(ringCallback('[rappel: 5 min] [sans-sonnerie]'), null);
});

test('callbacks are held on disk, ring only when due, survive a restart and post one notice to the agent thread', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'callbacks.json');
  let clock = Date.parse('2026-11-16T21:00:00Z');
  const messages = [{ id: 'm1', at: new Date(clock).toISOString(), text: 'VOX : Je finis la piste, je te rappelle. [rappel: 10 min]', role: 'agent', version: 1 }];
  const notices = [];
  const make = () => createRingFeed({ snapshot: async () => messages, now: () => clock, store: createCallbackFileStore(file),
    targets: () => [{ handle: 'mind', label: 'Marco', kind: 'main' }, { handle: 'vox', label: 'VOX', kind: 'agent' }],
    notify: async (handle, key, text) => { notices.push({ handle, key, text }); } });
  const since = new Date(clock - 1000).toISOString();
  let feed = make();
  assert.deepEqual(await feed(since), [], 'a callback message does not ring at once');
  assert.deepEqual(feed.pending().map(c => [c.handle, c.dueAt]), [['vox', '2026-11-16T21:10:00.000Z']]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).callbacks.length, 1);
  // Redémarrage de la passerelle et message sorti du fil : le rappel est tenu par le fichier.
  messages.length = 0; clock += 10 * 60_000 + 5000; feed = make();
  const events = await feed(since);
  assert.deepEqual(events.map(e => [e.kind, e.handle, e.label, e.question]), [['callback', 'vox', 'VOX', 'Je finis la piste, je te rappelle.']]);
  assert.equal(notices.length, 1); assert.equal(notices[0].handle, 'vox');
  assert.match(notices[0].text, /C'est l'heure de rappeler NLR : dis-lui ce que tu as fait depuis/);
  await feed(since); feed = make(); await feed.tick();
  assert.equal(notices.length, 1, 'one notice, even after another restart');
  assert.deepEqual((await feed(events[0].at)).map(e => e.id), [], 'a client already past the due time is not rung again');
});

test('a failed notice is retried on the next pass', async () => {
  let clock = Date.parse('2026-11-16T21:00:00Z'); let fail = true; const notices = [];
  const messages = [{ id: 'm1', at: new Date(clock).toISOString(), text: 'Je te rappelle dans 1 min', role: 'agent', version: 1 }];
  const feed = createRingFeed({ snapshot: async () => messages, now: () => clock,
    notify: async (...args) => { if (fail) throw new Error('down'); notices.push(args); } });
  clock += 61_000; await feed.tick(); assert.equal(notices.length, 0);
  fail = false; await feed.tick(); await feed.tick(); assert.equal(notices.length, 1); assert.equal(notices[0][0], 'mind');
});
