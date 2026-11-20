import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ChatError } from './chat-server.mjs';
import { createLocalTranscriber } from './chat-voice.mjs';

export function createCallTranscriber({ dataDir, wakeRoot, localFactory = createLocalTranscriber, spawnProcess = spawn }) {
  let local;
  const children = new Set();
  function provider() {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'elevenlabs.json'), 'utf8')).transcriptionEnabled === true ? 'elevenlabs' : 'local';
    } catch (error) {
      if (error.code === 'ENOENT') return 'local';
      throw new ChatError('transcription_unavailable', 503);
    }
  }
  const transcribe = async (bytes, mime, signal) => {
    if (signal?.aborted) throw new ChatError('transcription_cancelled', 499);
    if (provider() === 'local') {
      local ??= localFactory({ dataDir });
      if (!local) throw new ChatError('transcription_unavailable', 503);
      return { ...await local(bytes, mime, signal), provider: 'whisper' };
    }
    local?.close(); local = undefined;
    return new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import',
        pathToFileURL(path.join(wakeRoot, 'test/fixtures/store-ledger/ts-hooks.ts')).href, path.join(wakeRoot, 'services/elevenlabs/call-transcribe-main.ts'), mime],
      { cwd: wakeRoot, env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'ipc'] });
      children.add(child);
      let output = '', done = false;
      const finish = (error, result) => {
        if (done) return; done = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); children.delete(child);
        if (error) { if (child.connected) child.send({ cancel: true }, () => {}); reject(error); } else resolve(result);
      };
      const abort = () => finish(new ChatError('transcription_cancelled', 499));
      const timer = setTimeout(() => finish(new ChatError('transcription_timeout', 504)), 60_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', () => finish(new ChatError('transcription_unavailable', 503)));
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 100_000) finish(new ChatError('transcription_failed', 502)); });
      child.once('close', code => {
        if (done) return;
        try {
          const result = JSON.parse(output);
          if (code !== 0 || result.provider !== 'elevenlabs' || typeof result.text !== 'string') throw Error();
          if (provider() !== 'elevenlabs') throw Error();
          finish(null, result);
        } catch { finish(new ChatError('transcription_failed', 502)); }
      });
      child.stdin.on('error', () => finish(new ChatError('transcription_failed', 502)));
      if (signal?.aborted) abort(); else child.stdin.end(bytes);
    });
  };
  transcribe.warm = () => {}; // Lazy: never start Whisper when ElevenLabs is selected.
  transcribe.close = () => { local?.close(); for (const child of children) if (child.connected) child.send({ cancel: true }, () => {}); };
  transcribe.provider = provider;
  return transcribe;
}
