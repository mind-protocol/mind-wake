import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyVoiceCursor, voiceText } from './model.ts';
import { createSpeechEngine } from './speech-engine.web.ts';
import { reportMobilePresence } from './report.ts';
import { createPresenceRegistry } from '../../server/presence-registry.mjs';

const reply = (id, text = 'Bonjour') => ({ id, text, role: 'agent', status: 'published' });
test('restored history is silent; only new published agent replies are taken once', () => {
  const cursor = new ReplyVoiceCursor(); cursor.reset([], false);
  assert.deepEqual(cursor.take([reply('old')], true), []);
  assert.deepEqual(cursor.take([reply('old'), { ...reply('human'), role: 'human' }, reply('new')], true).map(x => x.id), ['new']);
  assert.deepEqual(cursor.take([reply('new', 'edited message')], true), []);
  cursor.reset([reply('new')], true); assert.deepEqual(cursor.take([reply('new'), reply('last')], true).map(x => x.id), ['last']);
});
test('speech text keeps prose, does not read code and is bounded', () => {
  const text = voiceText('## Bonjour **NLR** [ouvrir](http://local/secret)\n```js\nprivate-code\n```');
  assert.match(text, /Bonjour NLR ouvrir/); assert.doesNotMatch(text, /private-code|http:/);
  assert.equal(voiceText('a'.repeat(2000)).length, 1800);
});
function webHost(local = true) {
  const spoken = []; let stops = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const host = { SpeechSynthesisUtterance: Utterance, speechSynthesis: {
    getVoices: () => [{ name: 'Voix du téléphone', lang: 'fr-FR', localService: local }],
    speak: utterance => { spoken.push(utterance); }, cancel: () => { stops++; spoken.at(-1)?.onerror?.({ error: 'interrupted' }); },
  } };
  return { host, spoken, stops: () => stops };
}
test('web voice starts only when called and requires a local engine', () => {
  const { host, spoken } = webHost(); const engine = createSpeechEngine(host); let started = 0, done = 0;
  assert.equal(spoken.length, 0); assert.equal(engine.available(), true);
  engine.speak('Test vocal', { start: () => started++, done: () => done++, error: assert.fail });
  assert.equal(spoken.length, 1); assert.equal(started, 0);
  spoken[0].onstart(); spoken[0].onend(); assert.equal(started, 1); assert.equal(done, 1);
  const remote = webHost(false); let error = '';
  createSpeechEngine(remote.host).speak('Texte privé', { start: assert.fail, done: assert.fail, error: value => { error = value; } });
  assert.equal(remote.spoken.length, 0); assert.match(error, /voix locale/);
});
test('stop cancels voice and ignores callbacks of a replaced utterance', () => {
  const { host, spoken, stops } = webHost(); const engine = createSpeechEngine(host); let errors = 0;
  const events = { start() {}, done() {}, error() { errors++; } };
  engine.speak('Première réponse', events); engine.speak('Nouvelle réponse', events); engine.stop();
  assert.equal(spoken.length, 2); assert.equal(stops(), 3); assert.equal(errors, 0);
  assert.equal(spoken[1].onerror, null);
});
test('presence belongs to an authenticated session and expires to unknown, not background', () => {
  let now = 100000; const registry = createPresenceRegistry({ now: () => now }); const key = 'a'.repeat(64);
  const value = { schema: 'mind.mobile.presence.v1', window: 'foreground', lastInteractionAt: null, voiceEnabled: true, voiceReady: true, platform: 'web' };
  assert.throws(() => registry.update('', value), /unauthorized/);
  assert.throws(() => registry.update(key, { ...value, target: 'another owner' }), /invalid_presence/);
  registry.update(key, value); assert.equal(registry.routeHint(key).text, 'mobile');
  now += 45001; assert.equal(registry.read(key).window, 'unknown'); assert.equal(registry.read(key).fresh, false);
  assert.equal(registry.routeHint(key).voice, 'none'); assert.equal(registry.read(key).deviceWideActivity, false);
});
test('background voice is only a hint; web fallback stays explicitly unconfigured', () => {
  const registry = createPresenceRegistry({ now: () => 100000 }); const key = 'b'.repeat(64);
  const value = { schema: 'mind.mobile.presence.v1', window: 'background', lastInteractionAt: 90000, voiceEnabled: true, voiceReady: true, platform: 'web' };
  registry.update(key, value); assert.equal(registry.routeHint(key).voice, 'fallback-not-configured');
  registry.update(key, { ...value, platform: 'android' }); assert.equal(registry.routeHint(key).voice, 'mobile-tts-if-running');
  assert.equal(registry.routeHint(key).delivered, false);
  registry.remove(key); assert.equal(registry.read(key).fresh, false);
});
test('report sends no message content, uses existing bearer and refuses an external destination', async () => {
  const session = { url: 'http://192.168.1.183:8789', token: 'c'.repeat(64), expiresAt: 200000 }; let sent;
  const fetchImpl = async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({ schema: 'mind.mobile.presence.receipt.v1', deviceWideActivity: false }) }; };
  const ok = await reportMobilePresence(session, { window: 'foreground', lastInteractionAt: 100000, changedAt: 100000 }, { enabled: true, ready: true }, 'web', undefined, fetchImpl);
  assert.equal(ok, true); assert.equal(sent.url, session.url + '/chat/presence');
  assert.equal(sent.options.headers.Authorization, 'Bearer ' + session.token);
  const body = JSON.parse(sent.options.body); assert.equal(body.window, 'foreground'); assert.equal('text' in body, false);
  assert.equal(await reportMobilePresence({ ...session, url: 'https://external.example' }, { window: 'foreground', lastInteractionAt: null, changedAt: 0 }, { enabled: false, ready: false }, 'web', undefined, fetchImpl), false);
});
