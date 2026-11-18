import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createChatServer } from './chat-server.mjs';
import { createCallService, audioMime, callBody, speechChunks, CALL_INSTRUCTION, mirrorText, MIRROR_RULE, MIRROR_MAX_CHARS, isSilence, ringText } from './chat-call.mjs';

const id = 'chat-382582c4-90f8-4dfb-910d-6c976ad77247';
const code = 'pairing-code-123456789012';
const RIFF = Buffer.from('RIFF0000WAVEfmt ', 'latin1');

test('call cancellation reaches participants once without adding a transcript bubble', async t => {
  const f = fixture();
  const service = createChatServer({ bridge: { snapshot: async () => [], send: async () => ({ status: 'recorded' }) }, pairingCode: code, call: f.call });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const session = await (await fetch(url + '/chat/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const scope = 'call=382582c4-90f8-4dfb-910d-6c976ad77247&epoch=1';
  assert.equal((await fetch(`${url}/chat/call/session?${scope}&target=mind,vox`, { method: 'POST', headers })).status, 200);
  const endpoint = `${url}/chat/call/cancel-message?${scope}`;
  const body = JSON.stringify({ id, text: 'Va à "Paris"' });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  const results = await Promise.all([1, 2].map(() => fetch(endpoint, { method: 'POST', headers, body }).then(r => r.json())));
  assert.deepEqual(results[0], { schema: 'mind.chat.call.cancel.v1', status: 'queued' });
  assert.equal(f.sent.length, 1); assert.equal(f.routed.length, 1);
  assert.equal(f.sent[0].text, callBody(`le user annule ce message ${JSON.stringify('Va à "Paris"')}`));
  assert.equal(f.routed[0].text, f.sent[0].text);
  const replies = await (await fetch(`${url}/chat/call/replies?${scope}&target=mind&since=${encodeURIComponent(new Date(0).toISOString())}`, { headers })).json();
  assert.deepEqual(replies.items, []);
  await fetch(`${url}/chat/call/session/end?${scope}`, { method: 'POST', headers });
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 410);
});

function fixture() {
  const main = []; const room7 = []; const sent = []; const routed = []; const spoken = []; let wakes = 0;
  const vox = { room: 7, agent: null, label: 'Room 7 (VOX)' };
  const coach = { room: 2, agent: { id: 'coach-colony', name: 'Coach Colony' }, label: 'Coach Colony (Room 2)' };
  const holder = { room: 0, agent: null, holder: 'coach-des-coachs', label: '🧭 Coach des coachs (fil principal)' };
  const table = new Map([['room7', vox], ['vox', vox], ['room2', { room: 2, agent: null, label: 'Room 2' }],
    ['coach-colony', coach], ['coach-des-coachs', holder]]);
  const call = createCallService({ mainLabel: 'MIND', mainAgentId: 'marco', handleTable: () => table,
    routeHandle: async (handle, text, key) => { routed.push({ handle, text, key }); return { status: 'routed', label: table.get(handle).label }; },
    sendMain: async (messageId, text) => { sent.push({ messageId, text }); return { status: 'recorded', at: new Date().toISOString() }; },
    wakeMain: () => { wakes++; }, mainReplies: async () => main, roomEntries: async room => room === 7 ? room7 : [],
    speak: async (text, agentId) => { spoken.push({ text, agentId }); return { bytes: RIFF, mime: audioMime(RIFF), provider: 'local' }; } });
  return { call, main, room7, sent, routed, spoken, wakes: () => wakes };
}

test('targets list Marco first, then agents and holders, then rooms', () => {
  const { call } = fixture();
  assert.deepEqual(call.targets().map(t => [t.handle, t.kind]),
    [['mind', 'main'], ['coach-des-coachs', 'holder'], ['coach-colony', 'agent'], ['room2', 'room'], ['room7', 'room']]);
});

function withHolders() {
  const room7 = []; const sent = []; const routed = [];
  const vox = { room: 7, agent: null, label: 'VOX (Room 7)' };
  const table = new Map([['room7', vox], ['vox', vox], ['vox-holder', vox], ['room3', { room: 3, agent: null, label: 'Médicis (Room 3)' }],
    ['crypto', { room: 3, agent: null, label: 'Médicis (Room 3)' }],
    ['coach-colony', { room: 2, agent: { id: 'coach-colony', name: 'Coach Colony' }, label: 'Coach Colony (Room 2)' }],
    ['viz', { room: 0, agent: null, holder: 'viz', label: '🌳 Viz (fil principal)' }]]);
  const holders = [{ slug: 'vox-holder', name: 'Gardien de VOX', emoji: '🤍', thread: 'fork:7' },
    { slug: 'crypto', name: 'Crypto', emoji: '🪙', thread: 'fork:3' }, { slug: 'viz', name: 'Viz', emoji: '🌳', thread: 'principal' },
    { slug: 'coach-colony', name: 'Zénith', emoji: '☀️', thread: 'principal' }, { slug: 'off', name: 'Off', emoji: '⚪', thread: null }];
  let busy = false;
  const call = createCallService({ handleTable: () => table, holders: () => holders, owners: () => new Map([[7, { handle: 'vox', name: 'VOX' }]]),
    routeHandle: async (handle, text, key) => { routed.push({ handle, text, key }); return { status: 'routed', label: table.get(handle).label }; },
    sendMain: async (messageId, text) => { sent.push({ messageId, text }); return { at: new Date().toISOString() }; },
    mainReplies: async () => [], roomEntries: async room => (room === 7 ? room7 : []),
    speak: async () => ({ bytes: RIFF, mime: 'audio/wav', provider: 'local' }) });
  call.setTranscribing(() => busy);
  return { call, room7, sent, routed, setBusy: value => { busy = value; } };
}

test('VOX and every holder are listed as agents; rooms come last by room<n>', () => {
  const { call } = withHolders();
  assert.deepEqual(call.targets().map(t => [t.handle, t.kind, t.label]), [
    ['mind', 'main', 'Marco'], ['vox', 'agent', 'VOX'],
    ['vox-holder', 'holder', '🤍 Gardien de VOX · VOX'], ['crypto', 'holder', '🪙 Crypto · Médicis'], ['viz', 'holder', '🌳 Viz'],
    ['coach-colony', 'agent', '☀️ Zénith · Coach Colony (Room 2)'],
    ['room3', 'room', 'Room 3 · Médicis'], ['room7', 'room', 'Room 7 · VOX']]);
});

test('a room call also mentions its holder; a room holder is woken by @slug in its room thread', async () => {
  const f = withHolders();
  await f.call.deliver('vox', id, 'tu es là ?');
  assert.deepEqual(f.routed.at(-1), { handle: 'vox', text: `@vox-holder ${callBody('tu es là ?')}`, key: id });
  await f.call.deliver('crypto', id, 'le marché ?');
  assert.deepEqual(f.routed.at(-1), { handle: 'room3', text: `@crypto ${callBody('le marché ?')}`, key: id });
  f.routed.length = 0;
  const receipt = await f.call.deliver('room7,vox-holder,viz', id, 'ensemble');
  assert.deepEqual(f.routed.map(r => [r.handle, r.text]), [['room7', `@vox-holder ${callBody('ensemble')}`]]);
  assert.equal(f.sent.at(-1).text, `@viz ${callBody('ensemble')}`);
  assert.equal(receipt.label, '🌳 Viz + VOX (Room 7) + 🤍 Gardien de VOX');
  assert.equal(f.call.resolve('coach-colony').kind, 'agent');
  await assert.rejects(f.call.deliver('off', id, 'x'), { code: 'call_target_unknown' });
});

test('a room holder hears only its own lines; voice waits for a running transcription', async () => {
  const f = withHolders();
  const start = '2026-11-16T17:00:00.000Z';
  f.room7.push({ id: 1, role: 'agent', at: '2026-11-16T17:01:00.000Z', text: 'Je regarde.' },
    { id: 2, role: 'agent', at: '2026-11-16T17:01:02.000Z', text: '🤍 Gardien de VOX · Elle est en plein tour, je te réponds.' });
  assert.deepEqual((await f.call.replies('vox-holder', start)).map(i => [i.id, i.speaker]), [['r7:2', '🤍 Gardien de VOX']]);
  assert.equal((await f.call.replies('vox', start)).length, 2);
  f.setBusy(true);
  let done = false; const pending = f.call.speech('vox', 'r7:1').then(() => { done = true; });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(done, false);
  f.setBusy(false); await pending; assert.equal(done, true);
});

test('utterances are tagged, MIND wakes, holders are mentioned, rooms reuse the @handle route', async () => {
  const f = fixture();
  await f.call.deliver('mind', id, ' bonjour ');
  assert.deepEqual(f.sent.at(-1), { messageId: id, text: callBody('bonjour') });
  assert.equal(f.wakes(), 1);
  await f.call.deliver('coach-des-coachs', id, 'salut');
  assert.equal(f.sent.at(-1).text, `@coach-des-coachs ${callBody('salut')}`);
  await f.call.deliver('vox', id, 'ça va ?');
  assert.deepEqual(f.routed.at(-1), { handle: 'vox', text: callBody('ça va ?'), key: id });
  await assert.rejects(f.call.deliver('inconnu', id, 'x'), { code: 'call_target_unknown' });
  await assert.rejects(f.call.deliver('../etc', id, 'x'), { code: 'call_target_invalid' });
});

test('replies come from the target thread only, after the call start; agent replies drop their signature', async () => {
  const f = fixture();
  const start = '2026-11-16T17:00:00.000Z';
  f.main.push({ id: 'old', role: 'agent', at: '2026-11-16T16:59:00.000Z', text: 'avant' },
    { id: 'n1', role: 'agent', at: '2026-11-16T17:01:00.000Z', text: 'nouveau' },
    { id: 'h1', role: 'human', at: '2026-11-16T17:01:30.000Z', text: 'moi' });
  assert.deepEqual((await f.call.replies('mind', start)).map(i => i.id), ['m:n1']);
  assert.deepEqual(await f.call.replies('coach-des-coachs', start), await f.call.replies('mind', start));
  await f.call.speech('coach-des-coachs', 'm:n1');
  assert.equal(f.spoken.at(-1).agentId, 'marco');
  f.room7.push({ id: 5, role: 'agent', at: '2026-11-16T17:02:00.000Z', text: 'VOX : je suis là' },
    { id: 6, role: 'human', at: '2026-11-16T17:02:01.000Z', text: 'NLR' });
  assert.deepEqual((await f.call.replies('vox', start)).map(i => i.id), ['r7:5']);
  assert.deepEqual(await f.call.replies('coach-colony', start), []);
  await assert.rejects(f.call.replies('mind', 'pas une date'), { code: 'invalid_request' });
});

test('speech only voices a reply found in the thread, with the target voice, cached', async () => {
  const f = fixture();
  f.main.push({ id: 'n1', role: 'agent', at: '2026-11-16T17:01:00.000Z', text: 'Bonjour NLR' });
  const audio = await f.call.speech('mind', 'm:n1');
  assert.equal(audio.mime, 'audio/wav'); assert.equal(audio.provider, 'local');
  await f.call.speech('mind', 'm:n1');
  assert.deepEqual(f.spoken, [{ text: 'Bonjour NLR', agentId: 'marco' }]);
  await assert.rejects(f.call.speech('mind', 'm:absent'), { code: 'call_reply_unknown' });
  await assert.rejects(f.call.speech('mind', 'texte libre'), { code: 'invalid_request' });
});

test('voices: main agent, room agent id, room name, room-<n> alias for unnamed rooms', async () => {
  const f = fixture();
  assert.equal(f.call.resolve('mind').agentId, 'marco');
  assert.equal(f.call.resolve('coach-colony').agentId, 'coach-colony');
  assert.equal(f.call.resolve('vox').agentId, 'vox');
  assert.equal(f.call.resolve('room2').agentId, 'room-2');
  assert.equal(audioMime(Buffer.from('ID3', 'latin1')), 'audio/mpeg');
});

test('HTTP call routes require the bearer session and stream audio with exposed timing headers', async t => {
  const f = fixture();
  const service = createChatServer({ bridge: { snapshot: async () => f.main, send: async () => ({ status: 'recorded', at: new Date().toISOString() }) },
    pairingCode: code, origins: ['http://localhost:8081'], call: f.call,
    transcribe: async bytes => ({ text: bytes.length > 3 ? 'bonjour Marco' : '  ', durationSeconds: 2 }) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  assert.equal((await fetch(url + '/chat/call/targets')).status, 401);
  const session = await (await fetch(url + '/chat/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  const auth = { Authorization: `Bearer ${session.token}` };
  const targets = await (await fetch(url + '/chat/call/targets', { headers: auth })).json();
  assert.equal(targets.targets[0].handle, 'mind');
  const audioPost = (body, query = `target=mind&id=${id}`) => fetch(`${url}/chat/call/utterance?${query}`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/webm' }, body });
  const ok = await (await audioPost(Buffer.from('webm-bytes'))).json();
  assert.equal(ok.status, 'queued'); assert.equal(ok.text, 'bonjour Marco');
  assert.equal(f.sent.at(-1).text, callBody('bonjour Marco'));
  assert.equal((await (await audioPost(Buffer.from('ab'))).json()).status, 'empty');
  assert.equal((await audioPost(Buffer.from('webm-bytes'), `target=mind&id=bad`)).status, 400);
  assert.equal((await audioPost(Buffer.from('webm-bytes'), `target=mind&id=${id}&extra=1`)).status, 400);
  f.main.push({ id: 'n1', role: 'agent', at: new Date(Date.now() + 1000).toISOString(), text: 'Salut' });
  const replies = await (await fetch(`${url}/chat/call/replies?target=mind&since=${encodeURIComponent(new Date().toISOString())}`, { headers: auth })).json();
  assert.deepEqual(replies.items.map(i => i.id), ['m:n1']);
  const speech = await fetch(`${url}/chat/call/speech?target=mind&item=m:n1`, { headers: { ...auth, Origin: 'http://localhost:8081' } });
  assert.equal(speech.status, 200); assert.equal(speech.headers.get('content-type'), 'audio/wav');
  assert.match(speech.headers.get('access-control-expose-headers'), /X-Speech-Provider/);
  assert.equal(speech.headers.get('x-speech-provider'), 'local');
  assert.deepEqual(Buffer.from(await speech.arrayBuffer()), RIFF);
});


test('the spoken message carries the « answer fast, in small pieces » instruction', () => {
  assert.match(CALL_INSTRUCTION, /^\[Appel vocal en cours\] Réponds vite, à l'oral, en plusieurs messages courts/);
  assert.match(CALL_INSTRUCTION, /quelques phrases courtes/);
  assert.match(CALL_INSTRUCTION, /Pas de listes ni de markdown\.$/);
  assert.equal(callBody('  salut '), `${CALL_INSTRUCTION}\n\nsalut`);
});

test('several participants: one main-thread message for MIND + holders, one route per room, retry-safe keys', async () => {
  const f = fixture();
  const receipt = await f.call.deliver('mind,vox,coach-des-coachs,coach-colony', id, 'on fait le point');
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.startsWith('@coach-des-coachs Participants appelés : MIND, Room 7 (VOX), 🧭 Coach des coachs (fil principal), Coach Colony (Room 2).'));
  assert.ok(f.sent[0].text.endsWith(callBody('on fait le point')));
  assert.deepEqual(f.routed.map(r => [r.handle, r.key]), [['vox', `${id}:vox`], ['coach-colony', `${id}:coach-colony`]]);
  assert.equal(receipt.label, 'MIND + 🧭 Coach des coachs (fil principal) + Room 7 (VOX) + Coach Colony (Room 2)');
  await assert.rejects(f.call.deliver('mind,inconnu', id, 'x'), { code: 'call_target_unknown' });
  await assert.rejects(f.call.deliver(Array.from({ length: 9 }, (_, i) => `room${i}`), id, 'x'), { code: 'call_target_invalid' });
});

test('a whole room: each participant is named and voiced; long replies are split by sentence, name announced once', async () => {
  const f = fixture();
  const start = '2026-11-16T17:00:00.000Z';
  f.room7.push({ id: 10, role: 'agent', at: '2026-11-16T17:01:00.000Z', text: 'Je regarde, attends.' },
    { id: 11, role: 'agent', at: '2026-11-16T17:01:05.000Z', text: '🧭 Coach des coachs · Bonne question. Je vérifie la piste. Voilà.' },
    { id: 12, role: 'agent', at: '2026-11-16T17:01:09.000Z', text: 'Coach Colony : Prêt.' },
    { id: 13, role: 'agent', at: '2026-11-16T17:01:10.000Z', text: 'Le holder a raison : on garde.' });
  const items = await f.call.replies('vox', start);
  assert.deepEqual(items.map(i => [i.id, i.speaker, i.voice, i.text]), [
    ['r7:10', 'VOX', 'vox', 'Je regarde, attends.'],
    ['r7:11~0', '🧭 Coach des coachs', 'coach-des-coachs', 'Bonne question.'],
    ['r7:11~1', '🧭 Coach des coachs', 'coach-des-coachs', 'Je vérifie la piste. Voilà.'],
    ['r7:12', 'Coach Colony', 'coach-colony', 'Prêt.'],
    ['r7:13', 'VOX', 'vox', 'Le holder a raison : on garde.']]);
  await f.call.speech('vox', 'r7:11~0', true);
  await f.call.speech('vox', 'r7:11~1', true);
  await f.call.speech('vox', 'r7:12', false);
  assert.deepEqual(f.spoken, [{ text: 'Coach des coachs. Bonne question.', agentId: 'coach-des-coachs' },
    { text: 'Je vérifie la piste. Voilà.', agentId: 'coach-des-coachs' }, { text: 'Prêt.', agentId: 'coach-colony' }]);
});

test('speechChunks keeps the first sentence alone and groups the rest under the limit', () => {
  assert.deepEqual(speechChunks('Un. Deux trois. Quatre ! Cinq ?'), ['Un.', 'Deux trois. Quatre ! Cinq ?']);
  assert.deepEqual(speechChunks('Sans ponctuation finale'), ['Sans ponctuation finale']);
});

function shared(options = {}) {
  const main = []; const room3 = []; const room7 = []; const mainNotices = []; const roomNotices = []; let clock = Date.parse('2026-11-16T18:00:00.000Z');
  const medicis = { room: 3, agent: null, label: 'Médicis (Room 3)' }; const vox = { room: 7, agent: null, label: 'VOX (Room 7)' };
  const table = new Map([['room3', medicis], ['medicis', medicis], ['room7', vox], ['vox', vox]]);
  const call = createCallService({ mainLabel: 'Marco', handleTable: () => table, now: () => clock, mirrorIntervalMs: 0, mirrorPerMinute: 4, idleMs: 45_000, mirrorQuietMs: 0, ...options,
    routeHandle: async handle => ({ status: 'routed', label: table.get(handle).label }),
    sendMain: async () => ({ at: new Date(clock).toISOString() }), mainReplies: async () => main,
    roomEntries: async room => (room === 3 ? room3 : room === 7 ? room7 : []),
    // Comme le vrai fil : une notice est une entrée « human », jamais une réponse d'agent.
    noticeMain: async (key, text) => { if (!mainNotices.some(n => n.key === key)) mainNotices.push({ key, text }); },
    noticeRoom: async (room, key, text) => { if (roomNotices.some(n => n.key === key)) return;
      roomNotices.push({ room, key, text }); (room === 3 ? room3 : room7).push({ id: 900 + roomNotices.length, role: 'human', at: new Date(clock).toISOString(), text }); },
    speak: async () => ({ bytes: RIFF, mime: 'audio/wav', provider: 'local' }) });
  const at = () => new Date(clock).toISOString();
  return { call, main, room3, room7, mainNotices, roomNotices, at, tick: ms => { clock += ms; } };
}

test('call = shared room: replies are mirrored without an instruction about who may speak', async () => {
  const f = shared();
  await f.call.deliver('mind,medicis,vox', id, 'on parle du budget');
  f.tick(1000);
  f.room3.push({ id: 1, role: 'agent', at: f.at(), text: 'Le trésor tient trois mois.' });
  f.main.push({ id: 'a1', role: 'agent', at: f.at(), text: 'Je regarde les chiffres.' });
  await f.call.mirrorTick();
  assert.deepEqual(f.mainNotices.map(n => n.text), [mirrorText('Médicis', 'Le trésor tient trois mois.')]);
  assert.equal(f.mainNotices[0].text, '[Appel] Médicis : Le trésor tient trois mois.');
  assert.equal(f.mainNotices[0].text.includes(MIRROR_RULE), false);
  assert.deepEqual(f.roomNotices.map(n => [n.room, n.text.split('\n')[0]]).sort(), [
    [3, '[Appel] Marco : Je regarde les chiffres.'], [7, '[Appel] Marco : Je regarde les chiffres.'], [7, '[Appel] Médicis : Le trésor tient trois mois.']]);
  assert.equal(MIRROR_RULE.includes('SILENCE'), true);
});

test('mirrored copies are never mirrored again, never voiced, and the rate is capped per call', async () => {
  const f = shared();
  await f.call.deliver('mind,medicis', id, 'go');
  f.tick(1000);
  f.room3.push({ id: 1, role: 'agent', at: f.at(), text: 'Un.' });
  await f.call.mirrorTick(); await f.call.mirrorTick(); await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 1);
  // La notice posée dans la room 3 (Marco → Médicis) n'est ni une réponse ni recopiée.
  f.main.push({ id: 'a1', role: 'agent', at: f.at(), text: 'Deux.' });
  await f.call.mirrorTick(); await f.call.mirrorTick();
  assert.equal(f.roomNotices.length, 1); assert.equal(f.mainNotices.length, 1);
  assert.deepEqual((await f.call.replies('medicis', new Date(0).toISOString())).map(i => i.text), ['Un.']);
  // Plafond : 4 copies par minute pour cet appel, la suite attend (une prise de parole par passage).
  for (let n = 2; n < 9; n++) { f.room3.push({ id: n, role: 'agent', at: f.at(), text: `R${n}.` }); await f.call.mirrorTick(); }
  assert.equal(f.mainNotices.length + f.roomNotices.length, 4);
  assert.deepEqual(f.mainNotices.map(n => n.text), ['[Appel] Médicis : Un.', '[Appel] Médicis : R2.', '[Appel] Médicis : R3.']);
  f.tick(61_000); f.call.replies('mind', new Date(0).toISOString());
  await f.call.mirrorTick();
  assert.equal(f.mainNotices.length + f.roomNotices.length, 8);
});

test('mirroring stops on hang-up and after the idle timeout; replies before the call are not mirrored', async () => {
  const f = shared();
  f.room3.push({ id: 1, role: 'agent', at: f.at(), text: 'Avant l’appel.' });
  f.tick(1000);
  await f.call.deliver('mind,medicis', id, 'go');
  await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 0);
  assert.deepEqual(f.call.end('mind,medicis'), { ended: 1 });
  assert.deepEqual(f.call.active(), []);
  f.tick(1000); f.room3.push({ id: 2, role: 'agent', at: f.at(), text: 'Après.' });
  await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 0);
  await f.call.deliver('mind,medicis', id, 'encore');
  f.tick(46_000); f.room3.push({ id: 3, role: 'agent', at: f.at(), text: 'Trop tard.' });
  await f.call.mirrorTick();
  assert.deepEqual(f.call.active(), []); assert.equal(f.mainNotices.length, 0);
});

test('a single-channel call mirrors nothing; HTTP hang-up ends the call', async t => {
  const f = shared();
  await f.call.deliver('mind', id, 'seul');
  f.tick(1000); f.main.push({ id: 'a1', role: 'agent', at: f.at(), text: 'Oui.' });
  await f.call.mirrorTick();
  assert.equal(f.roomNotices.length, 0);
  await f.call.deliver('mind,vox', id, 'avec VOX');
  const service = createChatServer({ bridge: { snapshot: async () => [], send: async () => ({ status: 'recorded' }) }, pairingCode: code, call: f.call,
    transcribe: async () => ({ text: '', durationSeconds: 0 }) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const session = await (await fetch(url + '/chat/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  assert.equal((await fetch(url + '/chat/call/end?target=mind,vox', { method: 'POST' })).status, 401);
  const ended = await (await fetch(url + '/chat/call/end?target=mind,vox', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } })).json();
  assert.equal(ended.ended, 1); assert.deepEqual(f.call.active(), []);
});

test('a SILENCE reply is neither mirrored nor sent to the app transcript', async () => {
  const f = shared();
  await f.call.deliver('mind,vox', id, 'question');
  f.tick(1000);
  f.room7.push({ id: 1, role: 'agent', at: f.at(), text: 'SILENCE' },
    { id: 2, role: 'agent', at: f.at(), text: `VOX : Rien à ajouter.\n${MIRROR_RULE}\nSILENCE` },
    { id: 3, role: 'agent', at: f.at(), text: '🤍 Gardien de VOX · SILENCE.' },
    { id: 4, role: 'agent', at: f.at(), text: 'Le silence est une réponse, pas SILENCE.' });
  f.main.push({ id: 'a1', role: 'agent', at: f.at(), text: '  SILENCE \n' });
  await f.call.mirrorTick();
  assert.deepEqual(f.mainNotices.map(n => n.text.split('\n')[0]), ['[Appel] VOX : Le silence est une réponse, pas SILENCE.']);
  assert.equal(f.roomNotices.length, 0);
  assert.deepEqual((await f.call.replies('vox', new Date(0).toISOString())).map(i => i.id), ['r7:4']);
  assert.deepEqual(await f.call.replies('mind', new Date(0).toISOString()), []);
  assert.equal(isSilence(`SILENCE\n${MIRROR_RULE}`), true);
});

test('opening a call sends one "NLR t\'appelle" notice per callee, idempotent on the call id', async () => {
  const f = shared();
  const callId = 'b5ad6e40-7e6b-4582-a5f5-0196eae36402';
  f.call.openSession('owner', callId, 1, 'mind,medicis,room3');
  f.call.openSession('owner', callId, 1, 'mind,medicis,room3');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.mainNotices.map(n => n.text), [ringText(callId)]);
  assert.match(f.mainNotices[0].text, /NLR t'appelle — prépare-toi à décrocher et envoie-lui ce que tu as à lui dire \(appel b5ad6e40-/);
  // Médicis et sa room partagent un fil : une seule notice.
  assert.deepEqual(f.roomNotices.map(n => [n.room, n.text]), [[3, ringText(callId)]]);
  // Un participant ajouté est prévenu ; les présents ne le sont pas deux fois.
  f.call.addSession('owner', callId, 1, 'vox,mind', 1);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.roomNotices.map(n => n.room), [3, 7]);
  assert.equal(f.mainNotices.length, 1);
  // Le préavis n'est jamais recopié comme réplique.
  await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 1); assert.equal(f.roomNotices.length, 2);
});

test('an agent speaking in several short messages reaches the other agents as one whole copy after a lull', async () => {
  const f = shared({ mirrorQuietMs: 5000, mirrorMaxWaitMs: 20_000 });
  await f.call.deliver('mind,medicis', id, 'on parle du budget');
  f.tick(1000);
  const long = `Deuxième morceau ${'très détaillé '.repeat(150)}fin.`;
  f.room3.push({ id: 1, role: 'agent', at: f.at(), text: 'Je regarde.' });
  await f.call.mirrorTick();
  f.tick(2000); f.room3.push({ id: 2, role: 'agent', at: f.at(), text: long });
  await f.call.mirrorTick();
  f.tick(3000); f.room3.push({ id: 3, role: 'agent', at: f.at(), text: 'Voilà la réponse.' });
  await f.call.mirrorTick();
  // Pas encore d'accalmie : rien n'est parti vers les agents, mais l'humain lit déjà chaque morceau.
  assert.equal(f.mainNotices.length, 0);
  assert.equal((await f.call.replies('medicis', new Date(0).toISOString())).length >= 3, true);
  f.tick(5000); await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 1);
  assert.equal(f.mainNotices[0].text, `[Appel] Médicis : Je regarde.\n\n${long}\n\nVoilà la réponse.`);
  assert.equal(f.mainNotices[0].text.length > 1500, true);
  assert.equal(f.mainNotices[0].text.includes('…'), false);
  // Idempotence : passages suivants, rien de plus ; la clé est stable pour le groupe.
  f.tick(10_000); await f.call.mirrorTick(); await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 1);
  assert.match(f.mainNotices[0].key, /^call-mirror:/);
});

test('a speaker who never pauses is flushed at the max wait; speakers are grouped separately', async () => {
  const f = shared({ mirrorQuietMs: 5000, mirrorMaxWaitMs: 20_000, mirrorPerMinute: 20 });
  await f.call.deliver('mind,medicis,vox', id, 'go');
  for (let n = 1; n <= 6; n++) {
    f.tick(4000);
    f.room3.push({ id: n, role: 'agent', at: f.at(), text: `M${n}.` });
    f.room7.push({ id: n, role: 'agent', at: f.at(), text: `V${n}.` });
    await f.call.mirrorTick();
  }
  // 20 s après le premier morceau, sans accalmie : une copie par orateur avec ses 6 morceaux, dans l'ordre.
  assert.deepEqual(f.mainNotices.map(n => n.text).sort(), ['[Appel] Médicis : M1.\n\nM2.\n\nM3.\n\nM4.\n\nM5.\n\nM6.', '[Appel] VOX : V1.\n\nV2.\n\nV3.\n\nV4.\n\nV5.\n\nV6.']);
  f.tick(4000); f.room3.push({ id: 7, role: 'agent', at: f.at(), text: 'M7.' }); f.room7.push({ id: 7, role: 'agent', at: f.at(), text: 'V7.' });
  await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 2);
  f.tick(5000); await f.call.mirrorTick();
  assert.deepEqual(f.mainNotices.map(n => n.text).slice(2).sort(), ['[Appel] Médicis : M7.', '[Appel] VOX : V7.']);
  // Chaque room reçoit l'autre orateur, jamais le sien.
  assert.equal(f.roomNotices.filter(n => n.room === 3 && n.text.includes('Médicis')).length, 0);
  assert.equal(f.roomNotices.filter(n => n.room === 7 && n.text.includes('Médicis')).length, 2);
});

test('pending pieces are dropped on hang-up; an oversized reply is cut with an explicit notice', async () => {
  const f = shared({ mirrorQuietMs: 5000 });
  await f.call.deliver('mind,medicis', id, 'go');
  f.tick(1000); f.room3.push({ id: 1, role: 'agent', at: f.at(), text: 'Morceau en attente.' });
  await f.call.mirrorTick();
  f.call.end('mind,medicis');
  f.tick(10_000); await f.call.mirrorTick();
  assert.equal(f.mainNotices.length, 0);
  const huge = 'x'.repeat(MIRROR_MAX_CHARS + 50);
  assert.equal(mirrorText('VOX', huge), `[Appel] VOX : ${'x'.repeat(MIRROR_MAX_CHARS)}… [copie d'appel coupée : 50 caractères non recopiés]`);
  assert.equal(mirrorText('VOX', ['Un.', ' ', 'Deux.']), '[Appel] VOX : Un.\n\nDeux.');
});

test('lot 2: a main-thread reply that already carries « Marco : » is mirrored and voiced with one name only', async () => {
  const f = shared();
  await f.call.deliver('mind,medicis', id, 'go');
  f.tick(1000);
  f.main.push({ id: 'own_15ba0533', role: 'agent', at: f.at(), text: 'Marco : Marco : Salut NLR, je décroche.' });
  await f.call.mirrorTick();
  assert.deepEqual(f.roomNotices.map(n => n.text), ['[Appel] Marco : Salut NLR, je décroche.']);
  assert.deepEqual((await f.call.replies('mind', new Date(0).toISOString())).map(i => [i.speaker, i.text]), [['Marco', 'Salut NLR, je décroche.']]);
  assert.equal(mirrorText('Marco', 'Marco : x'), '[Appel] Marco : Marco : x', 'mirrorText itself stays literal; the strip happens upstream');
});
