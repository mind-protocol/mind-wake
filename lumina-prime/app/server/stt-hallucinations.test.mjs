import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, MIN_SPEECH_RMS } from './stt-hallucinations.mjs';
import { createCallService } from './chat-call.mjs';

test('silence hallucinations are dropped', () => {
  for (const text of [
    "Sous-titres réalisés par la communauté d'Amara.org",
    "Sous-titres réalisés par la communauté d’Amara.org.",
    'SOUS-TITRES RÉALISÉS PAR LA COMMUNAUTÉ D\'AMARA.ORG',
    "Sous-titrage ST' 501",
    'Sous-titrage Société Radio-Canada',
    "Merci d'avoir regardé cette vidéo !",
    "Merci d'avoir regardé.",
    'Abonnez-vous !',
    'Subtitles by the Amara.org community',
    '…',
  ]) assert.equal(cleanTranscript(text).text, null, text);
});

test('very low speech energy is dropped whatever the text', () => {
  const r = cleanTranscript('Bonjour, tu peux relancer le build ?', { speechRms: MIN_SPEECH_RMS / 2 });
  assert.equal(r.text, null);
  assert.match(r.reason, /^energie_basse/);
});

test('real speech passes, and a credit glued to real speech is removed', () => {
  assert.deepEqual(cleanTranscript('Merci, tu peux relancer le build ?', { speechRms: 0.05 }),
    { text: 'Merci, tu peux relancer le build ?', reason: null });
  assert.equal(cleanTranscript("Merci d'avoir regardé le ticket Soda, c'est parfait.").text,
    "Merci d'avoir regardé le ticket Soda, c'est parfait.");
  assert.deepEqual(cleanTranscript("Envoie le ticket. Sous-titres réalisés par la communauté d'Amara.org"),
    { text: 'Envoie le ticket.', reason: 'credit_retire' });
});

test('call delivery: a peer hallucination reaches nobody, real speech is delivered', async () => {
  const sent = []; let wakes = 0;
  const call = createCallService({ mainLabel: 'MIND', handleTable: () => new Map(),
    routeHandle: async () => ({ status: 'routed', label: 'x' }),
    sendMain: async (messageId, text) => { sent.push({ messageId, text }); return { at: new Date().toISOString() }; },
    wakeMain: () => { wakes++; }, mainReplies: async () => [], roomEntries: async () => [],
    speak: async () => ({ bytes: Buffer.alloc(0), mime: 'audio/wav', provider: 'local' }) });
  const dropped = await call.deliver('mind', 'peer-1', "Sous-titres réalisés par la communauté d'Amara.org", null, { speechRms: 0.04 });
  assert.equal(dropped.status, 'dropped');
  assert.equal(sent.length, 0); assert.equal(wakes, 0);
  const silent = await call.deliver('mind', 'peer-2', 'Tu as fini le déploiement ?', null, { speechRms: 0.0005 });
  assert.equal(silent.status, 'dropped');
  assert.equal(sent.length, 0);
  await call.deliver('mind', 'peer-3', 'Tu as fini le déploiement ?', null, { speechRms: 0.04 });
  assert.equal(sent.length, 1); assert.match(sent[0].text, /Tu as fini le déploiement \?$/);
  // Sans mesure ni orateur (message d'annulation, texte système) : pas de filtre.
  await call.deliver('mind', 'cancel-1', "Merci d'avoir regardé");
  assert.equal(sent.length, 2);
});
