import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChatError } from './chat-server.mjs';

export function createLocalTranscriber({ dataDir }) {
  // Read only the existing transcription settings, never expose or copy bot credentials.
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
  return async function transcribe(bytes, mime, signal) {
    const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
    if (!extensions[mime]) throw new ChatError('audio_type_unsupported', 415);
    const tempRoot = path.resolve(os.tmpdir());
    const temp = fs.mkdtempSync(path.join(tempRoot, 'mind-chat-voice-'));
    try {
      const file = path.join(temp, 'voice.' + extensions[mime]); fs.writeFileSync(file, bytes);
      return await new Promise((resolve, reject) => {
        const child = spawn(config.python, [script, file, config.model], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = ''; let settled = false; let stopError = null;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value); };
        const abort = () => { stopError = new ChatError('transcription_cancelled', 499); child.kill(); };
        const timer = setTimeout(() => { stopError = new ChatError('transcription_timeout', 504); child.kill(); }, 120_000);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', chunk => { out += chunk; if (out.length > 24_000) { stopError = new ChatError('transcription_invalid', 422); child.kill(); } });
        child.once('error', () => finish(new ChatError('transcription_unavailable', 503)));
        child.once('close', code => {
          if (stopError) { finish(stopError); return; }
          if (code !== 0) { finish(new ChatError('transcription_failed', 422)); return; }
          try {
            const result = JSON.parse(out);
            if (typeof result.text !== 'string' || result.text.length > 4000 || typeof result.durationSeconds !== 'number'
              || result.durationSeconds <= 0 || result.durationSeconds > 65) throw new Error('Invalid bounded transcription');
            finish(null, { text: result.text, durationSeconds: result.durationSeconds });
          } catch { finish(new ChatError('transcription_invalid', 422)); }
        });
      });
    } finally {
      // Computed deletion is confined to this newly created, known temporary directory.
      if (path.dirname(path.resolve(temp)) !== tempRoot || !path.basename(temp).startsWith('mind-chat-voice-'))
        throw new Error('Unexpected voice temporary path');
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
}
