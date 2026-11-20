import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCallTranscriber } from './call-transcriber.mjs';

test('calls select STT live, keep TTS off, never fall back after failure and cancel the worker', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-stt-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = value => fs.writeFileSync(path.join(dataDir, 'elevenlabs.json'), JSON.stringify({ enabled: false, transcriptionEnabled: value }));
  let localCalls = 0, mode = 'ok', cancelled = false, localClosed = false;
  const local = async () => { localCalls++; return { text: 'local', durationSeconds: 1 }; };
  local.close = () => { localClosed = true; };
  const transcribe = createCallTranscriber({ dataDir, wakeRoot: dataDir, localFactory: () => local,
    spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.connected = true;
      child.send = message => { cancelled = message.cancel; child.emit('close', 1); };
      child.stdin.end = () => { if (mode === 'wait') return;
        queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(mode === 'ok' ? { text: 'cloud', provider: 'elevenlabs' } : { error: 'failed' })); child.emit('close', mode === 'ok' ? 0 : 1); });
      };
      return child;
    },
  });
  config(false);
  assert.equal((await transcribe(Buffer.from('audio'), 'audio/wav')).provider, 'whisper');
  config(true);
  assert.equal((await transcribe(Buffer.from('audio'), 'audio/wav')).provider, 'elevenlabs');
  assert.equal(localClosed, true);
  mode = 'fail';
  await assert.rejects(transcribe(Buffer.from('audio'), 'audio/wav'), { code: 'transcription_failed' });
  assert.equal(localCalls, 1);
  mode = 'wait';
  const controller = new AbortController();
  const pending = transcribe(Buffer.from('audio'), 'audio/wav', controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'transcription_cancelled' });
  assert.equal(cancelled, true);
  config(false);
  assert.equal((await transcribe(Buffer.from('audio'), 'audio/wav')).provider, 'whisper');
  transcribe.close();
});
