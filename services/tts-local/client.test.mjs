import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getVoice, listVoices, loadVoices, localTtsConfig, synth, voiceKey } from "./client.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tts-local-"));
const wav = () => {
  const b = Buffer.alloc(48);
  b.write("RIFF", 0, "latin1");
  return b;
};

test("getVoice covers every agent by id, alias or display name, else default", () => {
  const dataDir = tmp();
  assert.equal(getVoice("vox", { dataDir }).id, "vox");
  assert.equal(getVoice("@VOX", { dataDir }).id, "vox");
  assert.equal(getVoice("room-7", { dataDir }).id, "vox");
  assert.equal(getVoice("marco", { dataDir }).gender, "male");
  assert.equal(getVoice("Équinoxe", { dataDir }).id, "coach-colony-4");
  assert.equal(getVoice("Altaïr", { dataDir }).id, "coach-telegram-3");
  assert.equal(getVoice("coach-des-coachs", { dataDir }).name, "Coach des coachs");
  const unknown = getVoice("inconnu", { dataDir });
  assert.deepEqual([unknown.id, unknown.matched], ["default", false]);
  assert.equal(getVoice(undefined, { dataDir }).id, "default");
  assert.equal(voiceKey("Aldébaran"), "aldebaran");
  const ids = listVoices({ dataDir }).map((v) => v.id);
  assert.equal(ids.filter((id) => /^coach-(colony|telegram)/.test(id)).length, 18);
  for (const v of listVoices({ dataDir })) assert.ok(v.instruct && v.refText && v.piper, v.id);
  // Noms affichés uniques : un nom ne doit pas tomber sur deux voix.
  const names = Object.values(loadVoices().voices).map((v) => voiceKey(v.name));
  assert.equal(new Set(names).size, names.length);
});

test("getVoice uses the frozen reference once it exists", () => {
  const dataDir = tmp();
  assert.equal(getVoice("vox", { dataDir }).reference, null);
  const ref = path.join(dataDir, "tts-local", "voices", "vox.wav");
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(ref, "RIFF");
  assert.equal(getVoice("vox", { dataDir }).reference, ref);
});

test("localTtsConfig: absent or invalid → disabled, only loopback URLs", () => {
  const dataDir = tmp();
  assert.equal(localTtsConfig(dataDir).enabled, false);
  fs.writeFileSync(path.join(dataDir, "tts-local.json"), JSON.stringify({ enabled: true, url: "http://evil.example:80" }));
  const c = localTtsConfig(dataDir);
  assert.equal(c.enabled, true);
  assert.equal(c.url, "http://127.0.0.1:8766");
});

test("synth posts the resolved voice and returns WAV bytes; refuses when disabled or down", async () => {
  const dataDir = tmp();
  const config = { enabled: true, url: "http://127.0.0.1:8766", python: null, autostart: false };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(wav(), { status: 200, headers: { "x-tts-engine": "qwen3-tts" } });
  };
  const r = await synth("Équinoxe", "Bonjour.", { dataDir, config, fetchImpl, ensure: async () => true });
  assert.equal(r.engine, "qwen3-tts");
  assert.equal(r.voice.id, "coach-colony-4");
  assert.equal(calls[0].url, "http://127.0.0.1:8766/synth");
  assert.equal(calls[0].body.voice.id, "coach-colony-4");
  assert.equal(calls[0].body.lang, "fr");
  assert.equal(r.bytes.subarray(0, 4).toString("latin1"), "RIFF");

  await assert.rejects(synth("vox", "x", { dataDir, config: { ...config, enabled: false } }), /non installée/);
  await assert.rejects(synth("vox", "x", { dataDir, config, fetchImpl, ensure: async () => false }), /indisponible/);
  await assert.rejects(synth("vox", "  ", { dataDir, config, fetchImpl, ensure: async () => true }), /vide/);
  const bad = async () => new Response("oops", { status: 503 });
  await assert.rejects(synth("vox", "x", { dataDir, config, fetchImpl: bad, ensure: async () => true }), /HTTP 503/);
  const notWav = async () => new Response("pas un wav", { status: 200 });
  await assert.rejects(synth("vox", "x", { dataDir, config, fetchImpl: notWav, ensure: async () => true }), /invalide/);
});
