import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalTranscriber, transcriptionLanguage } from './chat-voice.mjs';

/** Profil minimal : modèle = dossier vide, python = exécutable node (jamais lancé, spawn est simulé). */
function profile(transcription = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-voice-'));
  const model = path.join(dataDir, 'model');
  fs.mkdirSync(model);
  const write = extra => fs.writeFileSync(path.join(dataDir, 'voice-input.json'),
    JSON.stringify({ transcription: { python: process.execPath, model, ...transcription, ...extra } }));
  write({});
  return { dataDir, write };
}

/** spawn simulé : note les arguments et répond un texte à chaque extrait reçu. */
function fakeSpawn() {
  const calls = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('close'); };
    let received = 0;
    child.stdin.on('data', chunk => {
      received += chunk.length;
      if (received > 4) { received = 0; child.stdout.write(`${JSON.stringify({ text: 'bonjour', durationSeconds: 1 })}\n`); }
    });
    calls.push({ command, args, child });
    return child;
  };
  return { calls, spawnProcess };
}

test('transcriptionLanguage : fr par défaut, en et auto acceptés, valeur invalide ignorée', () => {
  assert.equal(transcriptionLanguage(undefined, undefined), 'fr');
  assert.equal(transcriptionLanguage('', undefined), 'fr');
  assert.equal(transcriptionLanguage('EN', undefined), 'en');
  assert.equal(transcriptionLanguage(' auto ', undefined), 'auto');
  assert.equal(transcriptionLanguage('français!', undefined), 'fr');
  assert.equal(transcriptionLanguage(undefined, 'en'), 'en');
  assert.equal(transcriptionLanguage('fr', 'en'), 'fr');
});

test('le worker de transcription reçoit la langue fr par défaut', async () => {
  const { dataDir } = profile();
  const { calls, spawnProcess } = fakeSpawn();
  const previous = process.env.MIND_WAKE_STT_LANGUAGE;
  delete process.env.MIND_WAKE_STT_LANGUAGE;
  try {
    const transcribe = createLocalTranscriber({ dataDir, spawnProcess });
    const result = await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(result.text, 'bonjour');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.at(-1), 'fr');
    transcribe.close();
  } finally {
    if (previous !== undefined) process.env.MIND_WAKE_STT_LANGUAGE = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('la langue du profil est transmise et relue à chaque extrait (worker relancé si elle change)', async () => {
  const { dataDir, write } = profile({ language: 'en' });
  const { calls, spawnProcess } = fakeSpawn();
  try {
    const transcribe = createLocalTranscriber({ dataDir, spawnProcess });
    await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(calls[0].args.at(-1), 'en');
    await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(calls.length, 1, 'même langue : même worker');
    write({ language: 'auto' });
    await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].child.killed, true);
    assert.equal(calls[1].args.at(-1), 'auto');
    transcribe.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('chat-transcribe.py passe language à model.transcribe sauf en auto', t => {
  const python = process.env.MIND_WAKE_TEST_PYTHON ?? 'python';
  const script = fileURLToPath(new URL('./chat-transcribe.py', import.meta.url));
  // Seule la fonction transcribe_options est exécutée : pas d'import de faster_whisper ni de modèle.
  const code = [
    'import ast, json, sys',
    'tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())',
    'fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "transcribe_options")',
    'scope = {}',
    'exec(compile(ast.Module(body=[fn], type_ignores=[]), sys.argv[1], "exec"), scope)',
    'f = scope["transcribe_options"]',
    'print(json.dumps([f("", "fr"), f("MIND", "en"), f("", "auto"), f("", "")]))',
  ].join('\n');
  const run = spawnSync(python, ['-I', '-c', code, script], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return t.skip(`python indisponible : ${run.error?.message ?? run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout), [
    { beam_size: 5, language: 'fr' },
    { beam_size: 5, hotwords: 'MIND', language: 'en' },
    { beam_size: 5 },
    { beam_size: 5, language: 'fr' },
  ]);
});
