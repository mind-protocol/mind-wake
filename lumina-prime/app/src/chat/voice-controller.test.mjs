import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController, VoiceError } from './voice-controller.ts';
const clip = () => ({ audio: new ArrayBuffer(16), mime: 'audio/webm' });
test('permission refusal never records, transcribes or emits a draft', async () => {
  const states = []; let transcriptions = 0; const drafts = [];
  const control = createVoiceController({ begin: async () => { throw new VoiceError('permission_denied'); },
    transcribe: async () => { transcriptions++; return 'never'; }, onTranscript: value => drafts.push(value), onState: value => states.push(value) });
  await control.start(); assert.equal(transcriptions, 0); assert.deepEqual(drafts, []);
  assert.equal(states.at(-1).phase, 'idle'); assert.match(states.at(-1).message, /refusé/);
});
test('one gesture, repeated stop and repeated start produce a single editable transcript, no automatic message', async () => {
  let starts = 0, stops = 0, transcriptions = 0, cleaned = 0; const drafts = [];
  const control = createVoiceController({ begin: async () => { starts++; return {
    stop: async () => { stops++; return { ...clip(), cleanup: async () => { cleaned++; } }; }, cancel: async () => {} }; },
    transcribe: async () => { transcriptions++; return '  Texte à relire  '; }, onTranscript: value => drafts.push(value), onState: () => {} });
  await control.start(); await control.start(); await Promise.all([control.finish(), control.finish()]);
  assert.deepEqual([starts, stops, transcriptions, cleaned], [1, 1, 1, 1]); assert.deepEqual(drafts, ['Texte à relire']);
});
test('cancel while permission or transcription is pending discards every late result', async () => {
  let allow; let cancelled = 0; const drafts = [];
  const permission = new Promise(resolve => { allow = resolve; });
  const control = createVoiceController({ begin: () => permission,
    transcribe: async () => 'Never', onTranscript: value => drafts.push(value), onState: () => {} });
  const start = control.start(); await control.cancel();
  allow({ stop: async () => clip(), cancel: async () => { cancelled++; } }); await start;
  assert.equal(cancelled, 1); assert.deepEqual(drafts, []);
  let finish; const pending = new Promise(resolve => { finish = resolve; }); let cleanup = 0;
  const second = createVoiceController({ begin: async () => ({ stop: async () => ({ ...clip(), cleanup: async () => { cleanup++; } }), cancel: async () => {} }),
    transcribe: () => pending, onTranscript: value => drafts.push(value), onState: () => {} });
  await second.start(); const stopping = second.finish(); await new Promise(resolve => setImmediate(resolve));
  await second.cancel(); finish('Discarded'); await stopping;
  assert.deepEqual(drafts, []); assert.equal(cleanup, 1);
});
test('maximum duration stops once and empty speech is not turned into an invented message', async () => {
  let stops = 0; const states = []; const drafts = [];
  const control = createVoiceController({ maxDurationMs: 15, begin: async () => ({ stop: async () => { stops++; return clip(); }, cancel: async () => {} }),
    transcribe: async () => '', onTranscript: value => drafts.push(value), onState: state => states.push(state) });
  await control.start(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(stops, 1); assert.deepEqual(drafts, []); assert.match(states.at(-1).message, /Aucune parole/);
});
