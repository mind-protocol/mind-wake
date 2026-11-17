import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OwnerMessages, readOwnerMessages } from "./owner-messages.js";
import { PUBLIC_REPLY_CAP, TelegramPublic, publicReplyText, publicRisks, type TelegramMessage } from "./telegram-public.js";

let dataDir: string;
let calls: { method: string; input: Record<string, unknown> }[];
let pub: TelegramPublic;
let clock: number;
const holders = () => path.join(dataDir, "workspace", "artifacts", "pattern-holders");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-public-"));
  fs.mkdirSync(holders(), { recursive: true });
  calls = [];
  clock = Date.parse("2026-11-16T17:00:00.000Z");
  let next = 900;
  pub = new TelegramPublic(dataDir, {
    chat: "@mindprotocol_ai",
    api: { call: async (method, input) => { calls.push({ method, input }); return { message_id: next++ }; } },
    ownerChat: () => "111",
    ownerUser: () => "111",
    now: () => clock,
  });
});
afterEach(() => {
  pub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const msg = (id: number, text: string, from: TelegramMessage["from"] = { id: 42, first_name: "Ana", username: "ana_k" }, extra: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: id,
  date: Math.floor(clock / 1000),
  chat: { id: -1001699255893, type: "supergroup", title: "$MIND - Mind Protocol", username: "mindprotocol_ai" },
  from,
  text,
  ...extra,
});
/** Réponse de Crypto au fil principal, comme la publie le runtime des holders. */
function cryptoReplies(text: string) {
  const prompt = (readOwnerMessages(dataDir) ?? []).filter((m) => m.text.startsWith("@crypto:")).at(-1)!;
  const messages = new OwnerMessages(dataDir, "claude-wake");
  try {
    messages.publish(`🪙 Crypto · ${text}`, `pattern-holder:crypto:${prompt.id}`);
  } finally {
    messages.close();
  }
}

it("hands a public question to @crypto and posts its reply in the group, as a reply, once, then tells NLR", async () => {
  expect(pub.receive(msg(5, "C'est quoi MIND ?"))).toBe("delivered");
  expect(pub.receive(msg(5, "C'est quoi MIND ?"))).toBe("duplicate");
  const prompt = (readOwnerMessages(dataDir) ?? []).at(-1)!;
  expect(prompt.text).toMatch(/^@crypto: nouveau message public sur \$MIND - Mind Protocol, de Ana \(@ana_k\): «C'est quoi MIND \?»/);
  await pub.tick();
  expect(calls).toEqual([]);
  cryptoReplies("Un réseau d'agents qui travaillent pour leurs humains.");
  await pub.tick();
  await pub.tick();
  expect(calls).toEqual([
    { method: "sendMessage", input: { chat_id: "-1001699255893", text: "Un réseau d'agents qui travaillent pour leurs humains.", reply_parameters: { message_id: 5, allow_sending_without_reply: false } } },
    { method: "sendMessage", input: { chat_id: "111", text: "🪙 Crypto a répondu à Ana (@ana_k) sur $MIND - Mind Protocol : https://t.me/mindprotocol_ai/900" } },
  ]);
});

it("ignores bots, NLR, channel posts, replies to a bot, empty messages and other chats", () => {
  expect(pub.receive(msg(1, "salut", { id: 8064691744, is_bot: true, username: "MIND_protocol_bot" }))).toBe("ignored");
  expect(pub.receive(msg(2, "salut", { id: 111, first_name: "NLR" }))).toBe("ignored");
  expect(pub.receive(msg(3, "annonce", undefined, { sender_chat: { id: -100 } }))).toBe("ignored");
  expect(pub.receive(msg(4, "merci bot", undefined, { reply_to_message: { from: { id: 8064691744, is_bot: true } } }))).toBe("ignored");
  expect(pub.receive(msg(5, "  "))).toBe("ignored");
  expect(pub.receive({ ...msg(6, "salut"), chat: { id: -5, type: "supergroup", username: "autre" } })).toBe("ignored");
  expect(pub.receive({ ...msg(7, "salut"), chat: { id: 42, type: "private" } })).toBe("ignored");
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);
});

it("posts nothing for [rien], and sends risky replies to NLR as a draft instead", async () => {
  pub.receive(msg(10, "gm"));
  cryptoReplies("[rien]");
  await pub.tick();
  expect(calls).toEqual([]);
  pub.receive(msg(11, "Quand sort le token ?"));
  cryptoReplies("Le lancement est prévu le 3 décembre, prix d'entrée bas.");
  await pub.tick();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.input["chat_id"]).toBe("111");
  expect(String(calls[0]?.input["text"])).toMatch(/^🪙 Crypto, brouillon non publié \(prix, lancement\)/);
  expect(publicReplyText("🪙 Crypto · —")).toBeNull();
  expect(publicReplyText("🪙 Crypto · (section notes.md écrite)")).toBeNull();
  expect(publicRisks("Envoie-moi ton wallet")).toEqual(["wallet"]);
  expect(publicRisks("mint: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toEqual(["adresse"]);
  expect(publicRisks("Un APY de 20 %")).toEqual(["rendement"]);
  expect(publicRisks("MIND relie des agents à leurs humains.")).toEqual([]);
});

it("stops at the daily cap of public replies", async () => {
  for (let i = 0; i < PUBLIC_REPLY_CAP + 1; i++) {
    pub.receive(msg(100 + i, `question ${String(i)} ?`));
    cryptoReplies(`réponse ${String(i)}`);
    await pub.tick();
  }
  const posted = calls.filter((c) => c.input["chat_id"] === "-1001699255893");
  expect(posted).toHaveLength(PUBLIC_REPLY_CAP);
});

it("copies the message to the coach only on an exact registry match, in its room or in canal-public.md", () => {
  fs.mkdirSync(path.join(holders(), "coach-telegram"), { recursive: true });
  fs.writeFileSync(
    path.join(holders(), "COACHS-REGISTRE.json"),
    JSON.stringify({
      personnes: [
        { id: "ana", coach: "coach-telegram", handles: [{ plateforme: "telegram", handle: "@Ana_K", id: 1 }] },
        { id: "bob", coach: "coach-telegram", handles: [{ plateforme: "colony", handle: "bob" }] },
      ],
    }),
  );
  pub.receive(msg(20, "bonjour"));
  pub.receive(msg(21, "bonjour", { id: 7, first_name: "Bob", username: "bob" }));
  pub.receive(msg(22, "bonjour", { id: 8, first_name: "Ana", username: "ana_k2" }));
  const lines = fs.readFileSync(path.join(holders(), "coach-telegram", "canal-public.md"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Ana (@ana_k), que tu suis (ana), a écrit : «bonjour»");
});
