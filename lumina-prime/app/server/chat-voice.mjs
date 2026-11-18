import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ChatError } from './chat-server.mjs';
import { readSttVocabulary, whisperHotwords } from '../../../services/voice/stt-vocabulary.mjs';

/**
 * Langue imposée à Whisper : `transcription.language` du profil (`fr`, `en`, `auto`...), sinon
 * MIND_WAKE_STT_LANGUAGE, sinon `fr` (comme services/telegram/transcribe.py). Sans langue,
 * Whisper devine à chaque extrait et se trompe sur les extraits courts. `auto` = détection.
 */
export function transcriptionLanguage(value, fallback = process.env.MIND_WAKE_STT_LANGUAGE) {
  for (const candidate of [value, fallback]) {
    const language = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (language === 'auto' || /^[a-z]{2,3}$/.test(language)) return language;
  }
  return 'fr';
}

export function createLocalTranscriber({ dataDir, spawnProcess = spawn }) {
  let config;
  let configFile;
  for (const name of ['voice-input.json', 'telegram.json']) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')).transcription;
      if (value?.model && value?.python && path.isAbsolute(value.model) && path.isAbsolute(value.python)
        && fs.statSync(value.model).isDirectory() && fs.statSync(value.python).isFile()) { config = value; configFile = name; break; }
    } catch { /* Missing local configuration stays unavailable. */ }
  }
  if (!config) return null;
  // Langue relue à chaque extrait : la changer dans le profil ne demande pas de redémarrer le serveur.
  function readLanguage() {
    try { return transcriptionLanguage(JSON.parse(fs.readFileSync(path.join(dataDir, configFile), 'utf8')).transcription?.language); }
    catch { return transcriptionLanguage(config.language); }
  }
  let language = readLanguage();
  let workerLanguage = '';
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
    workerLanguage = language;
    const child = spawnProcess(config.python, [script, config.model, config.device ?? 'auto', workerHotwords, workerLanguage],
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
    language = readLanguage();
    if (worker && (whisperHotwords(vocabulary) !== workerHotwords || language !== workerLanguage)) { const old = worker; worker = null; old.kill(); }
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
