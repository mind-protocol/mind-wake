import { DESKTOP_TOOLS } from "../../services/mcp/desktop-tools.js";
/**
 * Coachs Telegram d'une room (NLR, 16 nov. 2026 : « branchement auto », puis 13:17 « full access ») :
 * envoi, lecture et recherche depuis le compte de NLR, sur tout dialogue ; contacts.json est la
 * liste par défaut (résolution des noms) ; même table et même espacement que telegram_user_send ;
 * aucun plafond quotidien. Faux sidecar : aucun appel réel.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import {
  findCoachContact,
  readCoachContacts,
  registerTelegramCoachTools,
  TelegramUserAccount,
  type UserSidecar,
  type UserSidecarResult,
} from "../../services/mcp/telegram-user-tools.js";
import { registerSignedOwnerTools } from "../../services/mcp/fork-owner-main.js";

let dataDir: string;
let coachDir: string;
let clock: number;
let calls: string[][];
let nextResult: (args: string[]) => UserSidecarResult;
const fake: UserSidecar = async (args) => {
  calls.push(args);
  return nextResult(args);
};
const sentOk = (): UserSidecarResult => ({ ok: true, message_id: 100 + calls.length, peer: { id: 1, name: "Léo" } });
const contacts = () => path.join(coachDir, "contacts.json");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-coach-"));
  coachDir = path.join(dataDir, "workspace", "artifacts", "pattern-holders", "coach-telegram-2");
  fs.mkdirSync(coachDir, { recursive: true });
  // Faux fichiers : aucun vrai secret.
  fs.writeFileSync(path.join(dataDir, "telegram-user.json"), "{}");
  fs.writeFileSync(path.join(dataDir, "telegram-user.session"), "");
  clock = Date.parse("2026-11-16T12:00:00.000Z");
  calls = [];
  nextResult = sentOk;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const env = (coach = "coach-telegram-2") => ({
  MIND_WAKE_DATA_DIR: dataDir,
  MIND_WAKE_OWNER_TELEGRAM_COACH: coach,
  MIND_WAKE_OWNER_TELEGRAM_CONTACTS: contacts(),
});
async function connect(coach = "coach-telegram-2") {
  const server = new McpServer({ name: "t", version: "0" });
  expect(registerTelegramCoachTools(server, env(coach), fake, { now: () => clock, sleep: async () => undefined })).toBe(true);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const payload = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;
const writeContacts = (v: unknown) => fs.writeFileSync(contacts(), JSON.stringify(v));

it("contacts.json : username, id ou nom exact, casse ignorée ; entrées vides ignorées", () => {
  writeContacts([{ name: "Léo", username: "@Leo_X", id: 42 }, { name: "Aurore", id: "77" }, {}, "x"]);
  const list = readCoachContacts(contacts());
  expect(list).toEqual([
    { name: "Léo", username: "@Leo_X", id: "42" },
    { name: "Aurore", username: null, id: "77" },
  ]);
  for (const to of ["@leo_x", "leo_x", "42", "léo"]) expect(findCoachContact(list, to)?.name).toBe("Léo");
  expect(findCoachContact(list, "@inconnu")).toBeNull();
  expect(findCoachContact(list, "4")).toBeNull();
});

it("accès complet : un nom de contacts.json est résolu ; tout autre destinataire part tel quel ; lecture et recherche sur tout dialogue", async () => {
  writeContacts([{ name: "Léo", username: "@leo", id: 42 }, { name: "Aurore", id: 77 }]);
  const client = await connect();
  const ok = payload(await client.callTool({ name: "telegram_user_send", arguments: { to: "Léo", text: "salut", idempotency_key: "k1" } }));
  expect(ok["data"]).toMatchObject({ idempotency_key: "k1", contact: { username: "@leo" } });
  expect(calls[0]).toEqual(["send", "@leo", "-"]);
  clock += 10_000;
  // Sans username : l'id.
  await client.callTool({ name: "telegram_user_send", arguments: { to: "aurore", text: "x", idempotency_key: "k2" } });
  expect(calls[1]).toEqual(["send", "77", "-"]);
  clock += 10_000;
  // Hors contacts.json : envoyé tel quel.
  const other = payload(await client.callTool({ name: "telegram_user_send", arguments: { to: "@quelquun", text: "x", idempotency_key: "k3" } }));
  expect(other["data"]).toMatchObject({ contact: null });
  expect(calls[2]).toEqual(["send", "@quelquun", "-"]);
  nextResult = () => ({ ok: true, peer: { id: 9 }, messages: [] });
  await client.callTool({ name: "telegram_user_recent", arguments: { to: "@quelquun" } });
  expect(calls[3]).toEqual(["recent", "@quelquun", "10"]);
  await client.callTool({ name: "telegram_user_recent", arguments: { to: "42", limit: 3 } });
  expect(calls[4]).toEqual(["recent", "@leo", "3"]);
  nextResult = () => ({ ok: true, query: "Spark", dialog: null, messages: [{ id: 5, dialog: { name: "Kebra" }, author: "Kebra", text: "Spark ?" }] });
  const found = payload(await client.callTool({ name: "telegram_user_search", arguments: { query: "Spark" } }));
  expect(calls[5]).toEqual(["search", "Spark", "", "20"]);
  expect(found["data"]).toMatchObject({ query: "Spark", messages: [{ dialog: { name: "Kebra" } }] });
  await client.callTool({ name: "telegram_user_search", arguments: { query: "lien", in: "Léo", limit: 5 } });
  expect(calls[6]).toEqual(["search", "lien", "@leo", "5"]);
  // Dialogues et document reçu : mêmes outils que le principal ; un nom de contacts.json est résolu.
  nextResult = () => ({ ok: true, dialogs: [] });
  await client.callTool({ name: "telegram_user_dialogs", arguments: { limit: 10 } });
  expect(calls[7]).toEqual(["dialogs", "10"]);
  nextResult = () => ({ ok: true, path: "x", name: "x", size: 1, mime: null, date: null, message_id: 2, direction: "in", dialog: { id: 42, name: "Léo" } });
  const media = payload(await client.callTool({ name: "telegram_user_media", arguments: { to: "Léo" } }));
  expect(media["data"]).toMatchObject({ message_id: 2, dialog: { name: "Léo" } });
  expect(calls[8]?.slice(0, 2)).toEqual(["media", "--dest"]);
  expect(calls[8]?.slice(-2)).toEqual(["--to", "@leo"]);
});

it("sans contacts.json : outils exposés, `to` passé tel quel", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["telegram_user_dialogs", "telegram_user_media", "telegram_user_recent", "telegram_user_search", "telegram_user_send"]);
  const out = await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: "k" } });
  expect(out.isError).toBeFalsy();
  expect(calls[0]).toEqual(["send", "@leo", "-"]);
});

it("clé obligatoire, rangée sous coach:<id>: ; même espacement que le principal ; aucun plafond quotidien", async () => {
  writeContacts([{ name: "Léo", username: "@leo", id: 42 }]);
  const client = await connect();
  const noKey = await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x" } });
  expect(noKey.isError).toBe(true);
  await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: "same" } });
  clock += 10_000;
  // Même clé réutilisée par le coach : refus.
  const dup = await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: "same" } });
  expect(payload(dup)).toMatchObject({ error: "duplicate_key" });
  // Un autre coach n'est pas gêné par cette clé (espace de clés propre).
  writeContacts([{ name: "Léo", username: "@leo", id: 42 }]);
  const other = await connect("coach-telegram-3");
  const fromOther = await other.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: "same" } });
  expect(fromOther.isError).toBeFalsy();
  // Espacement partagé avec le principal : envoi principal juste après, refusé.
  const main = new TelegramUserAccount(dataDir, fake, { now: () => clock });
  await expect(main.send({ to: "@leo", text: "x", idempotency_key: "main-1" })).rejects.toMatchObject({ code: "rate_limited" });
  // Pas de plafond : 35 envois espacés d'un coach passent.
  for (let i = 0; i < 35; i++) {
    clock += 5_000;
    const r = await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: `n${String(i)}` } });
    expect(r.isError).toBeFalsy();
  }
});

it("serveur d'un agent : un coach Telegram reçoit les deux outils ; sans réglage, aucun", () => {
  const names = (extra: Record<string, string>) => {
    const tools: string[] = [];
    const server = { server: {}, registerTool: (n: string) => (tools.push(n), {}) } as unknown as McpServer;
    registerSignedOwnerTools(server, {
      MIND_WAKE_DATA_DIR: dataDir,
      MIND_WAKE_OWNER_SIGNATURE: "Coach Telegram 2",
      MIND_WAKE_OWNER_PROFILE: "publish",
      MIND_WAKE_OWNER_COLONY: "",
      MIND_WAKE_OWNER_FORK: "2",
      MIND_WAKE_OWNER_TOOLS: "none",
      ...extra,
    });
    return tools;
  };
  expect(names(env())).toEqual([
    "list_owner_messages", "message", "generate_image", "computer_use", ...DESKTOP_TOOLS, "list_active_calls", "invite_to_call", "hangup_call", "call", "call_human", "telegram_user_send", "telegram_user_recent", "telegram_user_search", "telegram_user_dialogs", "telegram_user_media",
  ]);
  expect(names({})).toEqual(["list_owner_messages", "message", "generate_image", "computer_use", ...DESKTOP_TOOLS, "list_active_calls", "invite_to_call", "hangup_call", "call", "call_human"]);
});
