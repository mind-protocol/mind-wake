// Registre « sujet → agent » pendant un appel (NLR, 18 nov. 2026 14:55 : « tout ce qui parle de la
// visualisation, c'est l'agent Viz, il faut le rajouter au call »).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallService, callBody, topicHits } from './chat-call.mjs';

const callId = 'b5ad6e40-7e6b-4582-a5f5-0196eae36402';
const utterance = 'chat-382582c4-90f8-4dfb-910d-6c976ad77247';
const later = 'chat-482582c4-90f8-4dfb-910d-6c976ad77247';

function service({ topics = [['viz', ['visualisation', 'carte des agents']], ['crypto', ['$MIND', 'wallet']], ['coach-colony', ['Colony']]] } = {}) {
  const sent = []; const routed = [];
  const table = new Map([['room3', { room: 3, agent: null, label: 'Médicis (Room 3)' }], ['crypto', { room: 3, agent: null, label: 'Médicis (Room 3)' }],
    ['coach-colony', { room: 2, agent: { id: 'coach-colony', name: 'Coach Colony' }, label: 'Coach Colony (Room 2)' }],
    ['viz', { room: 0, agent: null, holder: 'viz', label: '🌳 Viz (fil principal)' }]]);
  const holders = [{ slug: 'crypto', name: 'Crypto', emoji: '🪙', thread: 'fork:3' }, { slug: 'viz', name: 'Viz', emoji: '🌳', thread: 'principal' }];
  const call = createCallService({ handleTable: () => table, holders: () => holders, mirrorIntervalMs: 0,
    topics: () => topics.map(([handle, list]) => ({ handle, topics: list })),
    routeHandle: async (handle, text, key) => { routed.push({ handle, text, key }); return { status: 'routed', label: table.get(handle).label }; },
    sendMain: async (messageId, text) => { sent.push({ messageId, text }); return { at: new Date().toISOString() }; },
    mainReplies: async () => [], roomEntries: async () => [], speak: async () => ({ bytes: Buffer.from('RIFF'), mime: 'audio/wav' }) });
  const scope = { owner: 'owner', id: callId, epoch: 1 };
  return { call, sent, routed, scope };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('topic hits: whole words or expressions, accents and case ignored, longest first, one per agent', () => {
  const registry = [{ handle: 'viz', topics: ['carte', 'Carte des agents'] }, { handle: 'crypto', topics: ['$MIND', 'token'] }, { handle: 'x', topics: 'pas une liste' }];
  assert.deepEqual(topicHits('Où est la CARTE des agents ?', registry), [{ handle: 'viz', topic: 'Carte des agents' }]);
  assert.deepEqual(topicHits('le cours du $mind', registry), [{ handle: 'crypto', topic: '$MIND' }]);
  assert.deepEqual(topicHits('les tokens et les cartes', registry), []);
  assert.deepEqual(topicHits('rien', null), []);
});

test('a declared topic invites the absent agent once per call; the added agent gets the phrase', async () => {
  const f = service();
  f.call.openSession('owner', callId, 1, 'mind');
  const first = await f.call.deliver('mind', utterance, 'Marco, où est la carte des agents ?', f.scope);
  assert.deepEqual(first.invites, [{ handle: 'viz', label: '🌳 Viz', topic: 'carte des agents' }]);
  // Même sujet plus tard, agent pas encore ajouté : pas de deuxième invitation (une fois par appel).
  const again = await f.call.deliver('mind', later, 'Et la visualisation ?', f.scope);
  assert.equal(again.invites, undefined);
  f.call.addSession('owner', callId, 1, 'viz', 1);
  await flush();
  // Holder du fil principal et Marco dans l'appel : la phrase y est déjà, son sujet le réveille ; rien n'est renvoyé.
  assert.equal(f.sent.length, 2);
});

test('a room agent added by topic receives the phrase that called it, once', async () => {
  const f = service();
  f.call.openSession('owner', callId, 1, 'mind');
  const receipt = await f.call.deliver('mind', utterance, 'On parle de Colony et du wallet', f.scope);
  assert.deepEqual(receipt.invites.map(i => i.handle).sort(), ['coach-colony', 'crypto']);
  f.call.addSession('owner', callId, 1, 'coach-colony,crypto', 1);
  await flush();
  const forwarded = f.routed.map(r => r.handle).sort();
  assert.deepEqual(forwarded, ['coach-colony', 'room3']);
  assert.equal(f.routed.find(r => r.handle === 'coach-colony').text, callBody('On parle de Colony et du wallet'));
  assert.equal(f.routed.find(r => r.handle === 'room3').text, `@crypto ${callBody('On parle de Colony et du wallet')}`);
  assert.ok(f.routed.every(r => r.key.startsWith('chat-') && !r.key.startsWith(utterance)));
  // Retiré puis le sujet revient : pas de nouvelle invitation dans cet appel.
  f.call.removeSession('owner', callId, 1, 'coach-colony', 2);
  const after = await f.call.deliver('mind', later, 'Colony encore', f.scope);
  assert.equal(after.invites, undefined);
  f.call.addSession('owner', callId, 1, 'coach-colony', 3);
  await flush();
  assert.equal(f.routed.filter(r => r.handle === 'coach-colony').length, 1); // re-ajout manuel : aucun renvoi
});

test('no invite for participants, unknown handles, unscoped calls or peer calls', async () => {
  const f = service({ topics: [['viz', ['visualisation']], ['inconnu', ['visualisation']]] });
  f.call.openSession('owner', callId, 1, 'mind,viz');
  assert.equal((await f.call.deliver('mind,viz', utterance, 'la visualisation', f.scope)).invites, undefined);
  const g = service();
  assert.equal((await g.call.deliver('mind', utterance, 'la visualisation')).invites, undefined);
  g.call.openSession('peer:abc', callId, 1, 'mind');
  assert.equal((await g.call.deliver('mind', later, 'la visualisation', { owner: 'peer:abc', id: callId, epoch: 1 })).invites, undefined);
  const h = service();
  h.call.openSession('owner', callId, 1, 'mind,room3,coach-colony,viz,crypto,mind'.split(',').slice(0, 4));
  const full = await h.call.deliver('mind', utterance, 'wallet', h.scope);
  assert.deepEqual(full.invites.map(i => i.handle), ['crypto']);
});
