import test from 'node:test'; import assert from 'node:assert/strict';
import { createBargeIn, createCallVad, levelDb } from './call-vad.ts';

function feed(vad, from, to, db, step = 100) { const actions = []; for (let t = from; t < to; t += step) { const a = vad.step(db, t); if (a !== 'none') actions.push([a, t]); } return actions; }

test('an utterance ends after 5 s of silence following speech', () => {
  const vad = createCallVad({ silenceMs: 5000 }); vad.reset(0);
  assert.deepEqual(feed(vad, 0, 2000, -70), []);
  const speech = feed(vad, 2000, 4000, -25);
  assert.equal(speech[0][0], 'speech');
  const end = feed(vad, 4000, 10_000, -70);
  assert.equal(end[0][0], 'utterance'); assert.ok(end[0][1] >= 3900 + 5000 && end[0][1] <= 9100);
});

test('short pauses below the silence window do not split the utterance', () => {
  const vad = createCallVad({ silenceMs: 5000 }); vad.reset(0);
  feed(vad, 0, 1000, -70); feed(vad, 1000, 2000, -25);
  assert.deepEqual(feed(vad, 2000, 5000, -70), []);
  assert.deepEqual(feed(vad, 5000, 6000, -25), []);
});

test('silent segments are discarded, long speech is cut before the transcription limit', () => {
  const quiet = createCallVad({ idleResetMs: 3000 }); quiet.reset(0);
  assert.equal(feed(quiet, 0, 3100, -70)[0][0], 'discard');
  const long = createCallVad({ maxSegmentMs: 4000 }); long.reset(0);
  const actions = feed(long, 0, 4100, -25);
  assert.deepEqual(actions.map(a => a[0]), ['speech', 'cut']);
});

test('a click shorter than minSpeechMs is not speech; level is RMS dBFS', () => {
  const vad = createCallVad({ minSpeechMs: 250 }); vad.reset(0);
  feed(vad, 0, 1000, -70);
  assert.deepEqual(feed(vad, 1000, 1200, -20), []);
  assert.ok(Math.abs(levelDb([1, -1, 1, -1])) < 0.01);
  assert.ok(levelDb([0, 0]) < -100);
});

test('barge-in needs a louder voice held ~300 ms; off never interrupts', () => {
  const normal = createBargeIn('normal'); const th = -50;
  assert.equal(normal.step(-45, th, 0), false); // Écho du haut-parleur : sous seuil + 12 dB.
  assert.equal(normal.step(-30, th, 100), false);
  assert.equal(normal.step(-30, th, 300), false);
  assert.equal(normal.step(-30, th, 460), true);
  normal.reset(); assert.equal(normal.step(-30, th, 500), false);
  assert.equal(normal.step(-60, th, 600), false); assert.equal(normal.step(-30, th, 700), false); // Silence : on repart de zéro.
  const off = createBargeIn('off'); assert.equal(off.step(0, th, 0) || off.step(0, th, 5000), false);
  const vad = createCallVad({ silenceMs: 1000 }); vad.reset(0); vad.forceSpeech(100);
  assert.equal(vad.speaking, true); assert.equal(feed(vad, 200, 1300, -90).at(-1)[0], 'utterance');
});

test('a quieter end of sentence does not end the utterance (NLR 16 nov.)', () => {
  const vad = createCallVad({ silenceMs: 2000, floorDb: -52 }); vad.reset(0);
  feed(vad, 0, 2000, -70);
  feed(vad, 2000, 3000, -25);
  // threshold ≈ -52 ; la fin de phrase tombe à -56 dB pendant 3 s : encore de la parole
  assert.deepEqual(feed(vad, 3000, 6000, -56), []);
  const end = feed(vad, 6000, 10_000, -75);
  assert.equal(end[0][0], 'utterance');
});

test('the background-noise threshold can be raised during a call (NLR 17 nov.)', () => {
  const vad = createCallVad({ silenceMs: 1000, floorDb: -52 }); vad.reset(0);
  feed(vad, 0, 1000, -90); // bruit de fond appris très bas
  assert.equal(feed(vad, 1000, 1500, -48)[0][0], 'speech'); // bruit à -48 dB compté comme parole
  assert.deepEqual(feed(vad, 1500, 4000, -48), []); // le micro reste « actif », rien ne part
  vad.configure({ floorDb: -30 }); // seuil relevé en cours d'appel
  assert.equal(vad.threshold, -30);
  assert.equal(feed(vad, 4000, 6000, -48)[0][0], 'utterance');
  vad.configure({ floorDb: 5 }); assert.equal(vad.threshold, -20); // borné à la plage
  const barge = createBargeIn('off'); barge.setMode('sensible');
  assert.equal(barge.step(-30, -50, 0), false); assert.equal(barge.step(-30, -50, 300), true);
});
