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

test('call defaults are 2 s and -35 dBFS; an old persisted default migrates, a chosen value stays', async () => {
  const { SILENCE_S_DEFAULT, FLOOR_DB_DEFAULT, readCallTuning, createCallVad: vad } = await import('./call-vad.ts');
  assert.equal(SILENCE_S_DEFAULT, 2); assert.equal(FLOOR_DB_DEFAULT, -35); assert.equal(vad().threshold, -35);
  assert.deepEqual(readCallTuning({ silence: 5, bargeMode: 'normal', floorDb: -52 }), { bargeMode: 'normal' });
  assert.deepEqual(readCallTuning({ silence: 3, floorDb: -44 }), { silence: 3, floorDb: -44 });
  assert.deepEqual(readCallTuning({ v: 2, silence: 5, floorDb: -52 }), { silence: 5, floorDb: -52 });
  assert.deepEqual(readCallTuning(null), {});
  assert.match(source('CallScreen.tsx'), /useState\(SILENCE_S_DEFAULT\)/);
  assert.match(readFileSync(new URL('./storage.ts', import.meta.url), 'utf8'), /v: CALL_TUNING_VERSION/);
});

test('captures relayed by the desktop become inline transcript lines for the current call only', async () => {
  const { captureLines } = await import('./call-frames.ts');
  const id = '11111111-2222-4333-8444-555555555555';
  const frames = [{ id: 7, at: 0, author: 'Marco', target: 'Chrome', jpeg: 'QUJD' }, { id: 8, at: 0, author: 'Marco', target: 'Bureau', grid_text: '+--+\n|ok|' },
    { id: 9, at: 0, author: 'Marco', target: 'x', changes: [{ row: 2, column: 3, text: 'abc' }] }, { id: 10, at: 0, author: 'M', target: 'y' }];
  const lines = captureLines({ type: 'mind.call.frames', id, frames }, id);
  assert.deepEqual(lines.map(l => l.key), ['capture-7', 'capture-8', 'capture-9']);
  assert.equal(lines[0].capture.image, 'data:image/jpeg;base64,QUJD');
  assert.equal(lines[1].capture.ascii, '+--+\n|ok|'); assert.equal(lines[2].capture.ascii, 'L2 C3  abc');
  assert.deepEqual(captureLines({ type: 'mind.call.frames', id: 'other', frames }, id), []);
  assert.deepEqual(captureLines({ type: 'other', id, frames }, id), []);
  const screen = source('CallScreen.tsx');
  assert.match(screen, /item\.capture \? <Capture capture=\{item\.capture\}/);
  assert.match(screen, /event\.key === 'Escape'/);
  assert.match(screen, /fontFamily: MONO, fontSize: 12/);
});

test('new messages scroll smoothly; late growth re-pins instantly', async () => {
  const { pinScrollToEnd, SMOOTH_SCROLL_MS } = await import('./call-scroll.ts');
  const smooth = { current: true }; const until = { current: 0 };
  assert.equal(pinScrollToEnd(smooth, until, 1000), true); assert.equal(until.current, 1000 + SMOOTH_SCROLL_MS);
  assert.equal(pinScrollToEnd(smooth, until, 1100), false);
});

test('hang-up and mute sit in a fixed bar outside the transcript scroll view', () => {
  const screen = source('CallScreen.tsx');
  const scrollEnd = screen.indexOf('</ScrollView>', screen.indexOf('ref={transcript}'));
  const bar = screen.indexOf('accessibilityLabel="Commandes de l’appel"');
  assert.ok(bar > scrollEnd);
  assert.ok(screen.indexOf('accessibilityLabel="Raccrocher"') > bar && screen.indexOf("'Couper le micro'") > bar);
  assert.match(screen.slice(bar, bar + 200), /flexShrink: 0/);
});
