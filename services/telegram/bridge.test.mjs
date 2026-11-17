import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FILE_KINDS,
  OTHER_KINDS,
  TelegramApi,
  TelegramBridge,
  chunks,
  leadHandle,
  leadHandles,
  messageKind,
  networkCode,
  safeFileName,
} from "./bridge.mjs";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"));
  const sent = [],
    received = [];
  let items = [],
    updates = [],
    active = true;
  const options = {
    dataDir,
    username: "nlr_ai",
    ownerId: 1864364329,
    api: {
      call: async (method, input) => {
        if (method === "getUpdates") return updates;
        sent.push({ method, input });
        return {};
      },
      voice: async () => Buffer.from("audio"),
      sendVoice: async () => sent.push({ method: "sendVoice" }),
    },
    readThread: async () => items,
    receive: async (text, id) => received.push({ text, id }),
    transcribe: async () => "Bonjour",
    speak: async () => Buffer.from("voice"),
    active: () => active,
  };
  const bridge = new TelegramBridge(options);
  return {
    bridge,
    options,
    sent,
    received,
    setItems: (value) => {
      items = value;
    },
    setUpdates: (value) => {
      updates = value;
    },
    pause: () => {
      active = false;
    },
    cleanup: () => {
      bridge.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
const message = (id = 1, extra = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: 1864364329, type: "private" },
    from: { id: 1864364329, username: "nlr_ai" },
    text: "Salut",
    ...extra,
  },
});
test("pinned owner only; private messages and voice transcription keep deterministic ids", async () => {
  const f = fixture();
  try {
    f.setUpdates([
      message(1, { from: { id: 12, username: "nlr_ai" } }),
      message(2, { chat: { id: 1864364329, type: "group" } }),
      message(3),
      message(4, { text: undefined, voice: { file_id: "abc" } }),
    ]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 2);
    assert.equal(f.received[0].id, "tg-1864364329-3");
    assert.match(f.received[1].text, /Bonjour/);
    assert.equal(f.bridge.get("offset"), "5");
  } finally {
    f.cleanup();
  }
});
test("baseline, thread types except activity, restart dedup, edits, and no Telegram input echo", async () => {
  const f = fixture();
  try {
    f.setItems([{ from: "agent", id: "old", at: "now", text: "old" }]);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 0);
    f.setItems(
      ["agent", "session", "activity", "received", "context", "sent", "objective", "plan", "human"]
        .map((from) => ({ from, id: from, at: "now", text: "new" }))
        .concat([{ from: "human", id: "tg-1", at: "now", text: "echo" }]),
    );
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 16);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 16);
    f.bridge.close();
    const reopened = new TelegramBridge(f.options);
    await reopened.outgoing();
    reopened.close();
    assert.equal(f.sent.length, 16);
    f.bridge = new TelegramBridge(f.options);
    f.setItems([{ from: "agent", id: "agent", at: "now", text: "edited" }]);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 18);
  } finally {
    f.bridge.close();
    f.cleanup();
  }
});
test("failed delivery does not advance incoming offset; outgoing audio retry does not resend text", async () => {
  const f = fixture();
  try {
    await f.bridge.outgoing();
    f.setItems([{ from: "agent", id: "a", text: "hello" }]);
    f.bridge.speak = async () => {
      throw Error("failed");
    };
    await assert.rejects(() => f.bridge.outgoing());
    assert.equal(f.sent.length, 1);
    f.bridge.speak = async () => Buffer.from("ok");
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 2);
    f.setUpdates([message()]);
    f.bridge.receive = async () => {
      throw Error("failed");
    };
    await assert.rejects(() => f.bridge.incoming());
    assert.equal(f.bridge.get("offset"), undefined);
    f.pause();
    await f.bridge.outgoing();
    await f.bridge.incoming();
    assert.equal(f.sent.length, 2);
  } finally {
    f.cleanup();
  }
});
test("chunks preserve non-BMP characters and bound Telegram text size", () => {
  const text = "😀".repeat(4001);
  const parts = chunks(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((p) => p.length <= 3900));
});

test("an unintelligible voice reports failure, still reaches the thread, and does not block later text", async () => {
  const f = fixture();
  try {
    f.bridge.transcribe = async () => {
      throw Error("no speech");
    };
    f.setUpdates([message(1, { text: undefined, voice: { file_id: "silent" } }), message(2)]);
    await f.bridge.incoming();
    // 16 nov. 2026 15:19 : plus rien n'est ignoré sans bruit ; le vocal non transcrit laisse une trace.
    assert.equal(f.received.length, 2);
    assert.match(f.received[0].text, /^\[Telegram : vocal reçu, transcription impossible \(no speech\)\]/);
    assert.equal(f.received[1].id, "tg-1864364329-2");
    assert.match(f.sent[0].input.text, /pas pu être transcrit/);
    assert.equal(f.bridge.get("offset"), "3");
  } finally {
    f.cleanup();
  }
});

// ---- Contacts : humains autres que le propriétaire (mandat du 16 nov. 2026). Faux API, aucun envoi réel.
const contactMessage = (id, extra = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1_794_000_000 + id,
    chat: { id: 555, type: "private" },
    from: { id: 555, username: "Bigbosefx2", first_name: "Big" },
    text: "Bonjour NLR",
    ...extra,
  },
});
function withContacts() {
  const f = fixture();
  const contacts = [];
  f.bridge.receiveContact = async (m) => contacts.push(m);
  return { ...f, contacts };
}

test("owner flow unchanged when contacts write in the same batch", async () => {
  const f = withContacts();
  try {
    f.setUpdates([contactMessage(1), message(2), contactMessage(3, { text: "/start" }), message(4)]);
    await f.bridge.incoming();
    assert.deepEqual(
      f.received.map((r) => r.id),
      ["tg-1864364329-2", "tg-1864364329-4"],
    );
    assert.equal(f.bridge.get("user"), "1864364329");
    assert.equal(f.bridge.get("chat"), "1864364329");
    assert.equal(f.bridge.db.prepare("SELECT count(*) AS n FROM incoming").get().n, 2);
    // Aucun message de contact dans la table du propriétaire, ni réponse « MIND Wake connecté ».
    assert.ok(!f.sent.some((s) => /MIND Wake connecté/.test(s.input?.text ?? "")));
    assert.equal(f.bridge.get("offset"), "5");
  } finally {
    f.cleanup();
  }
});

test("a contact is kept with its message and handed to the principal inbox, never as owner", async () => {
  const f = withContacts();
  try {
    f.setUpdates([contactMessage(7)]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 0);
    const contact = f.bridge.db.prepare("SELECT * FROM contacts").get();
    assert.deepEqual(
      { ...contact },
      {
        chat_id: "555",
        user_id: "555",
        username: "Bigbosefx2",
        first_name: "Big",
        last_seen: new Date((1_794_000_000 + 7) * 1000).toISOString(),
        greeted_at: null,
      },
    );
    const row = f.bridge.db.prepare("SELECT id,chat_id,text,at FROM contact_incoming").get();
    assert.equal(row.id, "tg-contact-555-7");
    assert.equal(row.text, "Bonjour NLR");
    assert.equal(f.contacts.length, 1);
    assert.deepEqual(
      { ...f.contacts[0], at: undefined },
      {
        chatId: 555,
        userId: 555,
        username: "Bigbosefx2",
        firstName: "Big",
        messageId: 7,
        at: undefined,
        text: "Bonjour NLR",
      },
    );
    assert.equal(f.sent.length, 0);
    assert.equal(f.bridge.get("user"), "1864364329");
    // Rejoué (offset perdu) : ni double dépôt, ni double ligne.
    f.bridge.set("offset", 0);
    await f.bridge.incoming();
    assert.equal(f.contacts.length, 1);
    assert.equal(f.bridge.db.prepare("SELECT count(*) AS n FROM contact_incoming").get().n, 1);
  } finally {
    f.cleanup();
  }
});

test("contact voice is transcribed like the owner's; groups, bots and the owner username on another id are not contacts", async () => {
  const f = withContacts();
  try {
    f.setUpdates([
      contactMessage(1, { text: undefined, voice: { file_id: "v" } }),
      contactMessage(2, { chat: { id: 555, type: "group" } }),
      contactMessage(3, { from: { id: 556, is_bot: true, username: "x" }, chat: { id: 556, type: "private" } }),
      contactMessage(4, { from: { id: 557, username: "nlr_ai" }, chat: { id: 557, type: "private" } }),
    ]);
    await f.bridge.incoming();
    assert.equal(f.contacts.length, 1);
    assert.match(f.contacts[0].text, /Vocal Telegram transcrit automatiquement\]\nBonjour/);
    assert.equal(f.bridge.get("offset"), "5");
  } finally {
    f.cleanup();
  }
});

test("/start from a contact gets the greeting once, and the principal is told", async () => {
  const f = withContacts();
  try {
    f.setUpdates([contactMessage(1, { text: "/start" }), contactMessage(2, { text: "/start" })]);
    await f.bridge.incoming();
    const greetings = f.sent.filter((s) => s.method === "sendMessage");
    assert.equal(greetings.length, 1);
    assert.deepEqual(greetings[0].input, {
      chat_id: 555,
      text: "Bonjour, ici le bot MIND de NLR. Vos messages ici sont lus par NLR et ses agents.",
    });
    assert.equal(f.contacts.length, 2);
    assert.match(f.contacts[0].text, /^\/start\n\[a lancé le bot/);
    assert.ok(f.bridge.db.prepare("SELECT greeted_at FROM contacts").get().greeted_at);
  } finally {
    f.cleanup();
  }
});

test("a failed contact delivery keeps the offset and retries without a second greeting", async () => {
  const f = withContacts();
  try {
    f.bridge.receiveContact = async () => {
      throw Error("inbox down");
    };
    f.setUpdates([contactMessage(1, { text: "/start" })]);
    await assert.rejects(() => f.bridge.incoming());
    assert.equal(f.bridge.get("offset"), undefined);
    const contacts = [];
    f.bridge.receiveContact = async (m) => contacts.push(m);
    await f.bridge.incoming();
    assert.equal(contacts.length, 1);
    assert.equal(f.sent.filter((s) => s.method === "sendMessage").length, 1);
    assert.equal(f.bridge.get("offset"), "2");
  } finally {
    f.cleanup();
  }
});

// Pont gelé du 16 nov. 2026 : getUpdates pendant des minutes malgré AbortSignal.timeout,
// lastPollAt figé, status « active », aucune erreur journalisée.
const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
const hung = () => new Promise(() => {});

test("a request that ignores its abort signal still fails at the hard deadline, with a code and no token", async () => {
  let seen;
  const api = new TelegramApi(TOKEN, async (_url, init) => {
    seen = init.signal;
    return hung(); // ne réagit pas au signal
  }, { deadlineMs: 50 });
  const started = Date.now();
  await assert.rejects(api.call("getUpdates", { timeout: 5 }), (error) => {
    assert.equal(error.message, "Telegram getUpdates : réseau indisponible (TimeoutError)");
    assert.equal(error.networkCode, "TimeoutError");
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.ok(Date.now() - started < 2000);
  assert.equal(seen.aborted, true);
});

test("a stalled body after the headers also ends at the deadline", async () => {
  const api = new TelegramApi(TOKEN, async () => ({ ok: true, status: 200, json: hung }), { deadlineMs: 50 });
  await assert.rejects(api.call("getMe"), /réseau indisponible \(TimeoutError\)/);
});

test("the underlying network cause is kept (ECONNRESET), and getUpdates gets its long-poll wait plus 15 s", async () => {
  const api = new TelegramApi(TOKEN, async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(Error("socket"), { code: "ECONNRESET" }) });
  });
  await assert.rejects(api.call("getUpdates", { timeout: 5 }), (error) => error.networkCode === "ECONNRESET");
  assert.equal(api.deadline("getUpdates", { timeout: 5 }), 20_000);
  assert.equal(api.deadline("sendMessage", {}), 35_000);
  assert.equal(networkCode({ name: "AbortError" }), "AbortError");
  const ok = new TelegramApi(TOKEN, async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }));
  assert.deepEqual(await ok.call("getUpdates", { timeout: 5 }), []);
});

test("a hung getUpdates no longer freezes the incoming loop: it fails, pollStartedAt marks it, and the next poll succeeds", async () => {
  const t = fixture();
  try {
    let stall = true;
    t.bridge.api = new TelegramApi(TOKEN, async () =>
      stall ? hung() : { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) },
    { deadlineMs: 50 });
    await assert.rejects(t.bridge.incoming(), /getUpdates : réseau indisponible \(TimeoutError\)/);
    assert.ok(t.bridge.get("pollStartedAt"));
    assert.equal(t.bridge.get("lastPollAt"), undefined);
    stall = false;
    await t.bridge.incoming();
    assert.ok(t.bridge.get("lastPollAt"));
  } finally {
    t.cleanup();
  }
});

// ---- Médias et routage @handle (mandat du 16 nov. 2026, 14:53–15:19). Faux API, aucun envoi réel.
function withMedia(extra = {}) {
  const f = fixture();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), "tg-inbox-"));
  const downloads = [];
  f.bridge.api.download = async (fileId) => {
    downloads.push(fileId);
    if (fileId === "broken") throw Error("Téléchargement refusé");
    return { bytes: Buffer.from(`bytes:${fileId}`), filePath: `files/${fileId}.jpg` };
  };
  f.bridge.inboxDir = inbox;
  f.bridge.now = () => new Date("2026-11-16T15:00:00Z");
  Object.assign(f.bridge, extra);
  return {
    ...f,
    inbox,
    downloads,
    cleanup: () => {
      f.cleanup();
      fs.rmSync(inbox, { recursive: true, force: true });
    },
  };
}
const ownerMedia = (id, fields) => message(id, { text: undefined, ...fields });

test("a photo is downloaded (largest size) into inbox/<date>/ and the thread gets caption and path", async () => {
  const f = withMedia();
  try {
    f.setUpdates([
      ownerMedia(11186, {
        photo: [
          { file_id: "small", file_size: 10 },
          { file_id: "big", file_size: 900 },
        ],
        caption: "le graphe d'hier",
      }),
    ]);
    await f.bridge.incoming();
    assert.deepEqual(f.downloads, ["big"]);
    const file = path.join(f.inbox, "2026-11-16", "11186-photo.jpg");
    assert.equal(fs.readFileSync(file, "utf8"), "bytes:big");
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].id, "tg-1864364329-11186");
    assert.equal(f.received[0].text, `[Telegram : photo reçue]\nFichier : ${file}\nLégende : le graphe d'hier`);
    assert.equal(f.bridge.get("offset"), "11187");
    assert.deepEqual(
      f.bridge.db.prepare("SELECT id FROM incoming").all().map((r) => r.id),
      ["tg-1864364329-11186"],
    );
  } finally {
    f.cleanup();
  }
});

test("a document keeps its file name; video, audio, animation and video note are downloaded too", async () => {
  const f = withMedia();
  try {
    f.setUpdates([
      ownerMedia(1, { document: { file_id: "d", file_name: "../rapport final.pdf", file_size: 5 } }),
      ownerMedia(2, { video: { file_id: "v", file_size: 5 } }),
      ownerMedia(3, { audio: { file_id: "a", file_size: 5 } }),
      ownerMedia(4, { animation: { file_id: "g", file_size: 5 } }),
      ownerMedia(5, { video_note: { file_id: "n", file_size: 5 } }),
    ]);
    await f.bridge.incoming();
    const day = path.join(f.inbox, "2026-11-16");
    assert.ok(fs.existsSync(path.join(day, "1-rapport final.pdf")));
    assert.deepEqual(
      f.received.map((r) => r.text.split("\n")[0]),
      [
        "[Telegram : document reçu]",
        "[Telegram : vidéo reçue]",
        "[Telegram : fichier audio reçu]",
        "[Telegram : animation (GIF) reçue]",
        "[Telegram : vidéo ronde reçue]",
      ],
    );
    for (const r of f.received) assert.match(r.text, /\nFichier : .+2026-11-16/);
    // Aucune ligne renvoyée à NLR quand tout s'est bien passé.
    assert.equal(f.sent.filter((s) => s.method === "sendMessage").length, 0);
  } finally {
    f.cleanup();
  }
});

test("a file over 20 MB or a failed download still reaches the thread, and NLR gets one line", async () => {
  const f = withMedia();
  try {
    f.setUpdates([
      ownerMedia(1, { document: { file_id: "huge", file_size: 30_000_000 }, caption: "gros" }),
      ownerMedia(2, { photo: [{ file_id: "broken", file_size: 10 }] }),
    ]);
    await f.bridge.incoming();
    assert.deepEqual(f.downloads, ["broken"]);
    assert.match(f.received[0].text, /^\[Telegram : document reçu, trop gros pour le bot \(30 Mo/);
    assert.match(f.received[0].text, /Légende : gros$/);
    assert.match(f.received[1].text, /^\[Telegram : photo reçue, téléchargement impossible \(Téléchargement refusé\)\]/);
    const lines = f.sent.filter((s) => s.method === "sendMessage").map((s) => s.input.text);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotMatch(line, /\n/);
    assert.equal(f.bridge.get("offset"), "3");
  } finally {
    f.cleanup();
  }
});

for (const [kind, payload, expected] of [
  ["sticker", { sticker: { file_id: "s", emoji: "👍" } }, "[Telegram : sticker reçu (👍), non pris en charge]"],
  ["location", { location: { latitude: 1, longitude: 2 } }, "[Telegram : position reçue, non pris en charge]"],
  ["venue", { venue: { title: "x" } }, "[Telegram : lieu reçu, non pris en charge]"],
  ["contact", { contact: { phone_number: "+33", first_name: "A" } }, "[Telegram : contact reçu, non pris en charge]"],
  ["poll", { poll: { question: "?" } }, "[Telegram : sondage reçu, non pris en charge]"],
  ["dice", { dice: { emoji: "🎲", value: 3 } }, "[Telegram : dé reçu, non pris en charge]"],
  ["game", { game: { title: "g" } }, "[Telegram : jeu reçu, non pris en charge]"],
  ["story", { story: { id: 1 } }, "[Telegram : story reçue, non pris en charge]"],
  ["inconnu", { something_new: { x: 1 } }, "[Telegram : message d'un type inconnu reçu, non pris en charge]"],
]) {
  test(`unsupported owner message (${kind}) reaches the thread as a mention and NLR gets one line`, async () => {
    const f = withMedia();
    try {
      f.setUpdates([ownerMedia(7, payload)]);
      await f.bridge.incoming();
      assert.equal(f.received.length, 1);
      assert.equal(f.received[0].text, expected);
      const lines = f.sent.filter((s) => s.method === "sendMessage");
      assert.equal(lines.length, 1);
      assert.match(lines[0].input.text, /^Reçu : .+l’agent est prévenu\.$/);
      assert.equal(f.bridge.get("offset"), "8");
    } finally {
      f.cleanup();
    }
  });
}

test("every known type maps to a kind; text and voice first", () => {
  assert.equal(messageKind({ text: "" }), "text");
  assert.equal(messageKind({ voice: { file_id: "v" }, caption: "x" }), "voice");
  for (const kind of [...FILE_KINDS, ...OTHER_KINDS]) assert.equal(messageKind({ [kind]: { file_id: "f" } }), kind);
  assert.equal(messageKind({}), "inconnu");
  assert.equal(safeFileName("..\\..\\a:b?.png"), "a_b_.png");
  assert.equal(safeFileName(""), "fichier");
});

test("a voice whose download fails reaches the thread instead of blocking the queue", async () => {
  const f = withMedia();
  try {
    f.bridge.api.voice = async () => {
      throw Error("Fichier trop volumineux");
    };
    f.setUpdates([ownerMedia(1, { voice: { file_id: "v" } }), message(2)]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 2);
    assert.match(f.received[0].text, /^\[Telegram : vocal reçu, téléchargement impossible/);
    assert.equal(f.bridge.get("offset"), "3");
  } finally {
    f.cleanup();
  }
});

test("@handle at the start routes to the room or agent thread, not the main thread", async () => {
  const routed = [];
  const f = withMedia({
    routeHandle: async (handle, text, id) => {
      routed.push({ handle, text, id });
      return handle === "vox"
        ? { status: "routed", label: "Room 7 (VOX)" }
        : { status: "unknown", handle, known: ["coach-colony", "room7", "vox"] };
    },
  });
  try {
    f.setUpdates([
      message(1, { text: "@vox regarde le graphe" }),
      message(2, { text: "@vxo coucou" }),
      message(3, { text: "salut @vox au milieu" }),
      ownerMedia(4, { photo: [{ file_id: "p", file_size: 3 }], caption: "@VOX la photo" }),
    ]);
    await f.bridge.incoming();
    assert.deepEqual(
      routed.map((r) => [r.handle, r.id]),
      [
        ["vox", "tg-1864364329-1"],
        ["vxo", "tg-1864364329-2"],
        ["vox", "tg-1864364329-4"],
      ],
    );
    assert.equal(routed[0].text, "@vox regarde le graphe");
    assert.match(routed[2].text, /^\[Telegram : photo reçue\]\nFichier : .+\nLégende : @VOX la photo$/);
    // Fil principal : l'inconnu (signalé en tête) et le message sans @ en tête.
    assert.deepEqual(
      f.received.map((r) => r.text),
      ["[Telegram : @vxo inconnu, message laissé au fil principal]\n@vxo coucou", "salut @vox au milieu"],
    );
    const lines = f.sent.filter((s) => s.method === "sendMessage").map((s) => s.input.text);
    assert.deepEqual(lines, [
      "→ Room 7 (VOX)",
      "personne de ce nom : @vxo — handles connus : @coach-colony, @room7, @vox",
      "→ Room 7 (VOX)",
    ]);
  } finally {
    f.cleanup();
  }
});

test("a failing router leaves the message in the main thread with a note", async () => {
  const f = withMedia({
    routeHandle: async () => {
      throw Error("forks indisponibles");
    },
  });
  try {
    f.setUpdates([message(1, { text: "@vox salut" })]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 1);
    assert.match(f.received[0].text, /^\[Telegram : routage vers @vox impossible \(forks indisponibles\)/);
    assert.match(f.sent[0].input.text, /impossible/);
  } finally {
    f.cleanup();
  }
});

test("a main-thread pattern holder handle keeps the message in the main thread, with its @slug", async () => {
  const f = withMedia({
    routeHandle: async (handle) =>
      handle === "crypto" || handle === "coin"
        ? { status: "main", label: "🪙 Crypto (fil principal)", holder: "crypto", mention: "@crypto" }
        : { status: "unknown", handle, known: [] },
  });
  try {
    f.setUpdates([message(1, { text: "@crypto un avis ?" }), message(2, { text: "@coin un avis ?" })]);
    await f.bridge.incoming();
    assert.deepEqual(
      f.received.map((r) => r.text),
      ["@crypto un avis ?", "@crypto\n@coin un avis ?"],
    );
    const lines = f.sent.filter((s) => s.method === "sendMessage").map((s) => s.input.text);
    assert.deepEqual(lines, ["→ 🪙 Crypto (fil principal)", "→ 🪙 Crypto (fil principal)"]);
  } finally {
    f.cleanup();
  }
});

test("a public group message goes to publicMessage, never to the owner thread; a failure does not block", async () => {
  const seen = [];
  const f = withMedia({
    publicMessage: async (m) => {
      seen.push(m.message_id);
      if (m.message_id === 2) throw Error("panne");
    },
  });
  try {
    const group = (id) =>
      message(id, {
        text: "question ?",
        chat: { id: -1001699255893, type: "supergroup", username: "mindprotocol_ai" },
        from: { id: 42, is_bot: false, first_name: "Ana" },
      });
    f.setUpdates([group(1), group(2), message(3, { text: "salut" })]);
    await f.bridge.incoming();
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(f.received.map((r) => r.text), ["salut"]);
  } finally {
    f.cleanup();
  }
});

test("leadHandle reads only a leading @handle", () => {
  assert.equal(leadHandle("@Vox. hello"), "vox");
  assert.equal(leadHandle("  @coach-colony-2 go"), "coach-colony-2");
  assert.equal(leadHandle("mail a@b.c"), null);
  assert.equal(leadHandle(""), null);
});

test("leadHandles reads every consecutive leading @handle, deduped", () => {
  assert.deepEqual(leadHandles("@marco @vox hello"), ["marco", "vox"]);
  assert.deepEqual(leadHandles("@Vox, @room7. @VOX x @coach"), ["vox", "room7"]);
  assert.deepEqual(leadHandles("salut @vox"), []);
  assert.deepEqual(leadHandles(""), []);
});

test("several leading handles: each is routed, @marco also keeps the main thread", async () => {
  const routed = [];
  const f = withMedia({
    routeHandle: async (handle, text, id) => {
      routed.push({ handle, text, id });
      return handle === "vox" || handle === "room7"
        ? { status: "routed", label: handle === "vox" ? "Room 7 (VOX)" : "Room 7" }
        : { status: "unknown", handle, known: ["room7", "vox"] };
    },
  });
  try {
    f.setUpdates([
      message(1, { text: "@marco @vox hello" }),
      message(2, { text: "@vox @room7 x" }),
      message(3, { text: "@marco seul" }),
      message(4, { text: "@vox @vxo y" }),
    ]);
    await f.bridge.incoming();
    assert.deepEqual(
      routed.map((r) => [r.handle, r.id]),
      [
        ["vox", "tg-1864364329-1"],
        ["vox", "tg-1864364329-2"],
        ["room7", "tg-1864364329-2"],
        ["vox", "tg-1864364329-4"],
        ["vxo", "tg-1864364329-4"],
      ],
    );
    assert.deepEqual(
      f.received.map((r) => r.text),
      [
        "@marco @vox hello",
        "@marco seul",
        "[Telegram : @vxo inconnu, message laissé au fil principal]\n@vox @vxo y",
      ],
    );
    const lines = f.sent.filter((s) => s.method === "sendMessage").map((s) => s.input.text);
    assert.deepEqual(lines, [
      "→ Room 7 (VOX)",
      "→ Room 7 (VOX)",
      "→ Room 7",
      "→ Room 7 (VOX)",
      "personne de ce nom : @vxo — handles connus : @room7, @vox",
    ]);
  } finally {
    f.cleanup();
  }
});
