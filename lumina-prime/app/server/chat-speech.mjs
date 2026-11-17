import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { audioMime } from './chat-call.mjs';

const PROVIDER_TIMEOUT_MS = 90_000;

function run(command, args, { input, timeoutMs, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'], env, cwd });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('délai dépassé')); }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-400); });
    child.once('error', () => { clearTimeout(timer); reject(Error('processus indisponible')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(Error(stderr.trim().split('\n').at(-1)?.slice(0, 200) || `échec ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
const short = error => String(error?.message ?? error).replace(/sk_[A-Za-z0-9]+|[0-9a-f]{32,}/g, '[redacted]').slice(0, 160);

/**
 * speak(text, agentId) → { bytes, mime, provider }. Texte lisible à voix haute (spokenText du
 * pont Telegram), puis : ElevenLabs (voix du profil, réservée à l'agent principal pour ne pas
 * donner la voix de MIND aux autres), voix locale neuronale de l'agent (services/tts-local,
 * registre voices.json), Windows SAPI en dernier recours. Pas de ffmpeg : le navigateur lit
 * le MP3 et le WAV.
 */
export async function createCallSpeaker({ wakeRoot, dataDir, mainVoiceId }) {
  const { spokenText } = await import(pathToFileURL(path.join(wakeRoot, 'services/telegram/owner-voice.mjs')).href);
  let tts = null;
  try { tts = await import(pathToFileURL(path.join(wakeRoot, 'services/tts-local/client.mjs')).href); }
  catch { /* Registre de voix absent : SAPI seul pour les autres agents. */ }
  const sapiScript = fileURLToPath(new URL('./call-speak.ps1', import.meta.url));
  const temp = async (prefix, work) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try { return await work(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const elevenlabs = text => temp('mind-call-el-', async dir => {
    const mp3 = path.join(dir, 'voice.mp3');
    await run(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import',
      path.join(wakeRoot, 'test/fixtures/store-ledger/ts-hooks.ts'), path.join(wakeRoot, 'services/elevenlabs/telegram-voice-main.ts'), mp3],
    { input: text, timeoutMs: 75_000, cwd: wakeRoot, env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir } });
    return fs.readFileSync(mp3);
  });
  const sapi = text => temp('mind-call-tts-', async dir => {
    const input = path.join(dir, 'text.txt'); const wav = path.join(dir, 'voice.wav');
    fs.writeFileSync(input, text);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', sapiScript, '-InputFile', input, '-OutputFile', wav], { timeoutMs: 60_000 });
    return fs.readFileSync(wav);
  });
  const voiceOf = agentId => { try { return tts?.getVoice(agentId, { dataDir }) ?? null; } catch { return null; } };
  const speak = async (text, agentId) => {
    const spoken = spokenText(text);
    if (!spoken) return { bytes: Buffer.alloc(0), mime: 'audio/wav', provider: 'none' };
    const voice = voiceOf(agentId);
    const main = voice?.id === mainVoiceId || agentId === mainVoiceId;
    const providers = [
      ...(main ? [['elevenlabs', () => elevenlabs(spoken)]] : []),
      ...(tts ? [[`local:${voice?.id ?? 'default'}`, async () => (await tts.synth(agentId, spoken, { dataDir })).bytes]] : []),
      ['sapi', () => sapi(spoken)],
    ];
    const failures = [];
    for (const [provider, attempt] of providers) {
      let timer;
      try {
        const bytes = await Promise.race([attempt(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('délai dépassé')), PROVIDER_TIMEOUT_MS); })]);
        if (!bytes?.length) throw Error('audio vide');
        return { bytes, mime: audioMime(bytes), provider, failures };
      } catch (error) { failures.push(`${provider}: ${short(error)}`); }
      finally { clearTimeout(timer); }
    }
    throw Error(`synthèse impossible (${failures.join(' ; ')})`);
  };
  return speak;
}
