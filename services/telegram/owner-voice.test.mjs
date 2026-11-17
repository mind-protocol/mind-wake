import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { TelegramBridge } from "./bridge.mjs";
import { ownerSpeaker, ownerVoicePass, spokenText } from "./owner-voice.mjs";

test("spokenText strips markdown, bullets, URLs, paths and code", () => {
  const text = [
    "## Point du jour",
    "- **Pont** relancé, voir https://example.com/x et `pid 123`.",
    "* Fichier C:\\Users\\reyno\\mind-wake\\scripts\\telegram-bridge.mjs modifié",
    "1. Détail dans services/telegram/owner-voice.mjs",
    "```js",
    "console.log(1)",
    "```",
    "> Et [le lien](https://a.b) reste lisible",
    "| a | b |",
  ].join("\n");
  const spoken = spokenText(text);
  assert.equal(spoken, "Point du jour. Pont relancé, voir et. Fichier modifié. Détail dans. Et le lien reste lisible.");
  for (const bad of ["http", "**", "`", "C:", "/", "\\", "#", ".mjs", "console"]) assert.ok(!spoken.includes(bad), bad);
  assert.equal(spokenText("Les dates 17/11 et 1/2 restent."), "Les dates 17/11 et 1/2 restent.");
});

test("spokenText caps length at a sentence boundary", () => {
  const sentence = "Ceci est une phrase de test assez longue pour remplir. ";
  const spoken = spokenText(sentence.repeat(60));
  assert.ok(spoken.length <= 1500);
  assert.ok(spoken.endsWith("remplir."));
  const words = spokenText("mot ".repeat(600));
  assert.ok(words.length <= 1501 && words.endsWith("…"));
});

test("ownerSpeaker uses ElevenLabs first, falls back to local on error or timeout, reports both failures", async () => {
  const eleven = ownerSpeaker({ elevenlabs: async () => Buffer.from("el"), local: async () => Buffer.from("lo") });
  assert.equal((await eleven("x")).provider, "elevenlabs");
  const fallback = ownerSpeaker({
    elevenlabs: async () => {
      throw Error("ElevenLabs HTTP 402 : vérifier les droits et crédits du compte.");
    },
    local: async () => Buffer.from("lo"),
  });
  const r = await fallback("x");
  assert.equal(r.provider, "local");
  assert.match(r.failures[0], /402/);
  const slow = ownerSpeaker({
    elevenlabs: () => new Promise(() => {}),
    local: async () => Buffer.from("lo"),
    timeoutMs: 20,
  });
  assert.equal((await slow("x")).provider, "local");
  const none = ownerSpeaker({
    elevenlabs: async () => {
      throw Error("no key");
    },
    local: async () => Buffer.alloc(0),
  });
  await assert.rejects(none("x"), /elevenlabs: no key.*local: audio vide/);
});

test("ownerSpeaker tries the local neural voice between ElevenLabs and Windows SAPI", async () => {
  const order = [];
  const step = (name, result) => async () => {
    order.push(name);
    if (result instanceof Error) throw result;
    return result;
  };
  const neural = ownerSpeaker({
    elevenlabs: step("elevenlabs", Error("HTTP 402")),
    neural: step("neural", Buffer.from("nn")),
    local: step("local", Buffer.from("lo")),
  });
  const r = await neural("x");
  assert.equal(r.provider, "neural");
  assert.deepEqual(order, ["elevenlabs", "neural"]);
  order.length = 0;
  const down = ownerSpeaker({
    elevenlabs: step("elevenlabs", Error("HTTP 402")),
    neural: step("neural", Error("voix locale neuronale non installée")),
    local: step("local", Buffer.from("lo")),
  });
  const d = await down("x");
  assert.equal(d.provider, "local");
  assert.deepEqual(order, ["elevenlabs", "neural", "local"]);
  assert.match(d.failures[1], /^neural: voix locale neuronale non installée/);
  const slow = ownerSpeaker({ neural: () => new Promise(() => {}), local: async () => Buffer.from("lo"), neuralTimeoutMs: 20 });
  assert.equal((await slow("x")).provider, "local");
});

function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-voice-"));
  const db = new Database(path.join(dataDir, "telegram.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS channel_outgoing(key TEXT PRIMARY KEY,channel TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);",
  );
  const add = (key, text, at, status = "sent", channel = "owner") =>
    db.prepare("INSERT INTO channel_outgoing(key,channel,text,at,status) VALUES(?,?,?,?,?)").run(key, channel, text, at, status);
  return { dataDir, db, add, cleanup: () => (db.close(), fs.rmSync(dataDir, { recursive: true, force: true })) };
}

test("ownerVoicePass: one voice per sent owner message, only after activation, never twice", async () => {
  const s = store();
  try {
    let clock = new Date("2026-11-16T17:00:00.000Z");
    const now = () => clock;
    const sent = [];
    const speak = async (text) => ({ bytes: Buffer.from(text), provider: "elevenlabs", failures: [] });
    const sendVoice = async (chat, bytes) => sent.push({ chat, text: bytes.toString() });
    s.add("owner:old", "Avant activation", "2026-11-16T16:59:00.000Z");
    await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now });
    assert.deepEqual(sent, []);
    clock = new Date("2026-11-16T17:01:00.000Z");
    s.add("owner:a", "**Bonjour** NLR", "2026-11-16T17:00:30.000Z");
    s.add("owner:pending", "Pas encore parti", "2026-11-16T17:00:31.000Z", "pending");
    s.add("chan:x", "Canal public", "2026-11-16T17:00:32.000Z", "sent", "@mindprotocol_ai");
    const done = await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now });
    assert.deepEqual(sent, [{ chat: "42", text: "Bonjour NLR." }]);
    assert.deepEqual(done, [{ key: "owner:a", status: "sent", provider: "elevenlabs" }]);
    await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now });
    assert.equal(sent.length, 1);
    // Le message en attente part ensuite : il reçoit son vocal à la passe suivante.
    s.db.prepare("UPDATE channel_outgoing SET status='sent' WHERE key='owner:pending'").run();
    await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now });
    assert.equal(sent.length, 2);
    const row = s.db.prepare("SELECT status,provider FROM owner_voice WHERE key='owner:a'").get();
    assert.deepEqual({ ...row }, { status: "sent", provider: "elevenlabs" });
  } finally {
    s.cleanup();
  }
});

test("ownerVoicePass: synthesis or sendVoice failures are logged once and never retried", async () => {
  const s = store();
  try {
    const now = () => new Date("2026-11-16T17:01:00.000Z");
    s.db.prepare("INSERT INTO state VALUES('ownerVoiceSince','2026-11-16T17:00:00.000Z')").run();
    s.add("owner:a", "Un", "2026-11-16T17:00:10.000Z");
    s.add("owner:b", "Deux", "2026-11-16T17:00:20.000Z");
    const logs = [];
    let calls = 0;
    const speak = async (text) => {
      calls++;
      if (text === "Un.") throw Error("synthèse impossible (elevenlabs: x ; local: y)");
      return { bytes: Buffer.from("b"), provider: "local", failures: ["elevenlabs: HTTP 401"] };
    };
    const sendVoice = async () => {
      throw Error("Telegram sendVoice refusé");
    };
    const done = await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now, log: (l) => logs.push(l) });
    assert.deepEqual(
      done.map((d) => d.status),
      ["failed", "failed"],
    );
    assert.equal(logs.length, 2);
    await ownerVoicePass({ db: s.db, chat: "42", speak, sendVoice, now });
    assert.equal(calls, 2);
    const rows = s.db.prepare("SELECT key,status,error FROM owner_voice ORDER BY key").all();
    assert.match(rows[0].error, /synthèse impossible/);
    assert.match(rows[1].error, /sendVoice/);
  } finally {
    s.cleanup();
  }
});

test("TelegramBridge.ownerVoices sends via api.sendVoice to the pinned chat; off without ownerSpeak or when paused", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-voice-bridge-"));
  const voices = [];
  let active = true;
  const make = (ownerSpeak) =>
    new TelegramBridge({
      dataDir,
      username: "nlr_ai",
      ownerId: 1864364329,
      api: { call: async () => ({}), sendVoice: async (chat, bytes) => voices.push({ chat, n: bytes.length }) },
      readThread: async () => [],
      receive: async () => {},
      transcribe: async () => "",
      ownerSpeak,
      active: () => active,
    });
  const off = make(null);
  try {
    assert.deepEqual(await off.ownerVoices(), []);
  } finally {
    off.close();
  }
  const bridge = make(async () => ({ bytes: Buffer.from("ogg"), provider: "local", failures: [] }));
  try {
    await bridge.ownerVoices(); // activation
    bridge.db
      .prepare("INSERT INTO channel_outgoing(key,channel,text,at,status) VALUES(?,?,?,?,?)")
      .run("owner:k", "owner", "Test voix : si tu m'entends, la synthèse vocale marche.", new Date(Date.now() + 1000).toISOString(), "sent");
    active = false;
    assert.deepEqual(await bridge.ownerVoices(), []);
    active = true;
    await bridge.ownerVoices();
    assert.deepEqual(voices, [{ chat: "1864364329", n: 3 }]);
  } finally {
    bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
