import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCallVad, muteTransition, MUTED_DB } from './call-vad.ts';

const source = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

test('mute: a started sentence is sent, an idle segment is discarded, unmute resumes', () => {
  assert.equal(muteTransition(false, true, true), 'send');
  assert.equal(muteTransition(false, true, false), 'discard');
  assert.equal(muteTransition(true, false, false), 'resume');
  assert.equal(muteTransition(true, true, true), 'none');
  assert.equal(muteTransition(false, false, true), 'none');
});

test('the muted level never reaches the speech threshold', () => {
  const vad = createCallVad({ floorDb: -70 }); vad.reset(0);
  const actions = []; for (let t = 0; t < 10_000; t += 100) { const a = vad.step(MUTED_DB, t); if (a !== 'none') actions.push(a); }
  assert.ok(!actions.includes('speech') && !actions.includes('utterance') && !actions.includes('cut'));
  assert.ok(MUTED_DB < vad.threshold);
});

test('web engine: muted disables the mic track, records no segment and skips VAD/barge-in', () => {
  const web = source('call-engine.web.ts');
  assert.match(web, /if \(!stream \|\| ended \|\| muted\) return;/);
  const tick = web.slice(web.indexOf('function tick()'), web.indexOf('function interrupt('));
  assert.ok(tick.indexOf('if (muted)') > -1 && tick.indexOf('if (muted)') < tick.indexOf('vad.step') && tick.indexOf('if (muted)') < tick.indexOf('barge.step'));
  assert.match(web, /track\.enabled = false/);
  assert.match(web, /track\.enabled = true/);
  assert.match(web, /setMuted,/);
});

test('native engine: muted stops the recorder loop and plays replies without detection', () => {
  const native = source('call-engine.ts');
  const loop = native.slice(native.indexOf('async function segment('), native.indexOf('async function whileMuted('));
  assert.ok(loop.indexOf('if (muted)') > -1 && loop.indexOf('if (muted)') < loop.indexOf('recorder.getStatus()'));
  const idle = native.slice(native.indexOf('async function whileMuted('), native.indexOf('async function listen('));
  assert.ok(!idle.includes('vad.step') && !idle.includes('barge.step') && !idle.includes('NativeRecorder'));
  assert.match(native, /if \(muted\) \{ await whileMuted\(\);/);
  assert.match(native, /setMuted\(next: boolean\)/);
});

test('call screen shows a mute toggle with a clear muted state', () => {
  const screen = source('CallScreen.tsx');
  assert.match(screen, /'🔇' : '🎙'/);
  assert.match(screen, /🔇 Micro coupé/);
  assert.match(screen, /accessibilityLabel=\{muted \? 'Réactiver le micro' : 'Couper le micro'\}/);
});

test('call transcript follows new messages like the chat, with a jump button when scrolled up', () => {
  const screen = source('CallScreen.tsx');
  assert.match(screen, /createScrollFollow\(/);
  assert.match(screen, /createWebScrollFollow\(scrollFollow\)/);
  assert.match(screen, /onContentSizeChange=\{\(width, height\) => \{ webFollow\.invalidate\(\); scrollFollow\.onContentSizeChange/);
  assert.match(screen, /unseen && !following \?/);
  assert.match(screen, /↓ nouveaux messages/);
  assert.match(screen, /scrollFollow\.recent\(\)/);
  assert.ok(!screen.includes('atBottom'));
});
