import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ChatError } from './chat-server.mjs';
import { readSttVocabulary, whisperHotwords } from '../../../services/voice/stt-vocabulary.mjs';

export function createLocalTranscriber({ dataDir }) {
  let config;
  for (const name of ['voice-input.json', 'telegram.json']) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')).transcription;
      if (value?.model && value?.python && path.isAbsolute(value.model) && path.isAbsolute(value.python)
        && fs.statSync(value.model).isDirectory() && fs.statSync(value.python).isFile()) { config = value; break; }
    } catch { /* Missing local configuration stays unavailable. */ }
  }
  if (!config) return null;
  const script = fileURLToPath(new URL('./chat-transcribe.py', import.meta.url));
  let worker = null;
  let pending = null;
  // Vocabulaire du profil (stt-vocabulary.json) relu à chaque extrait : s'il a changé dans
  // Réglages, le worker repart avec les nouveaux hotwords (pas de redémarrage du serveur).
  let vocabulary = readSttVocabulary(dataDir);
  let workerHotwords = '';
  function start() {
    if (worker) return worker;
    workerHotwords = whisperHotwords(vocabulary);
    const child = spawn(config.python, [script, config.model, config.device ?? 'auto', workerHotwords],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    worker = child;
    function lost() {
      if (worker !== child) return;
      worker = null;
      pending?.finish(new ChatError('transcription_unavailable', 503));
    }
    child.once('error', lost);
    child.once('close', lost);
    child.stdin.on('error', () => { lost(); child.kill(); });
    createInterface({ input: child.stdout }).on('line', line => {
      if (worker !== child || !pending) return;
      try {
        const result = JSON.parse(line);
        if (result.error) return pending.finish(new ChatError('transcription_failed', 422));
        if (typeof result.text !== 'string' || result.text.length > 4000 || !(result.durationSeconds > 0 && result.durationSeconds <= 65))
          throw Error('invalid worker response');
        pending.finish(null, result);
      } catch { pending?.finish(new ChatError('transcription_invalid', 422)); }
    });
    return child;
  }
  function stop(error) {
    const child = worker;
    worker = null; child?.kill();
    pending?.finish(error);
  }
  async function transcribe(bytes, mime, signal) {
    if (!['audio/webm','audio/mp4','audio/m4a','audio/aac','audio/ogg','audio/wav'].includes(mime))
      throw new ChatError('audio_type_unsupported', 415);
    if (signal?.aborted) throw new ChatError('transcription_cancelled', 499);
    if (pending) throw new ChatError('transcription_busy', 429);
    vocabulary = readSttVocabulary(dataDir);
    if (worker && whisperHotwords(vocabulary) !== workerHotwords) { const old = worker; worker = null; old.kill(); }
    const child = start();
    return new Promise((resolve, reject) => {
      const abort = () => stop(new ChatError('transcription_cancelled', 499));
      const timer = setTimeout(() => stop(new ChatError('transcription_timeout', 504)), 120_000);
      pending = { finish(error, result) {
        pending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
      child.stdin.write(header); child.stdin.write(bytes);
    });
  }
  transcribe.warm = start;
  transcribe.close = () => stop(new ChatError('transcription_cancelled', 499));
  return transcribe;
}
