/** Compte Telegram personnel : faux sidecar, aucun appel réel, aucune connexion. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  registerTelegramUserTools,
  TelegramUserAccount,
  type UserSidecar,
  type UserSidecarResult,
  USER_OUTGOING_SCHEMA,
} from "../services/mcp/telegram-user-tools.js";

let dataDir: string;
let clock: number;
let calls: { args: string[]; stdin?: string | undefined }[];
let nextResult: (args: string[]) => UserSidecarResult;

const fake: UserSidecar = async (args, stdin) => {
  calls.push({ args, stdin });
  return nextResult(args);
};
const sentOk = (args: string[]): UserSidecarResult => ({
  ok: true,
  message_id: 100 + calls.length,
  peer: { id: 4242, name: "Léo", username: "@leo", kind: "user" },
  echo: args,
});
const setup = (session = true) => {
  // Faux fichiers : aucun vrai secret, le contenu de la session n'est jamais lu par Node.
  fs.writeFileSync(path.join(dataDir, "telegram-user.json"), JSON.stringify({ api_id: 1, api_hash: "x", phone: "+0" }));
  if (session) fs.writeFileSync(path.join(dataDir, "telegram-user.session"), "");
};
const rows = () => {
  const db = new Database(path.join(dataDir, "telegram.sqlite"));
  db.exec(USER_OUTGOING_SCHEMA);
  try {
    return db.prepare("SELECT key,target,text,status,message_id,peer_id FROM user_outgoing ORDER BY at").all() as {
      key: string;
      target: string;
      text: string;
      status: string;
      message_id: string | null;
      peer_id: string | null;
    }[];
  } finally {
    db.close();
  }
};
let slept: number[];
const sleep = async (ms: number) => {
  slept.push(ms);
  clock += ms;
};
const account = (options: { minIntervalSeconds?: number } = {}) =>
  new TelegramUserAccount(dataDir, fake, { ...options, now: () => clock, sleep });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-user-"));
  clock = Date.parse("2026-11-16T12:00:00.000Z");
  calls = [];
  slept = [];
  nextResult = sentOk;
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("telegram_user_send", () => {
  it("envoie par le sidecar, texte sur stdin, et journalise la clé", async () => {
    setup();
    const result = await account().send({ to: "@leo", text: "Salut Léo, c'est NLR.", idempotency_key: "k1" });
    expect(result).toMatchObject({ message_id: 101, idempotency_key: "k1", peer: { id: 4242 } });
    expect(calls).toEqual([{ args: ["send", "@leo", "-"], stdin: "Salut Léo, c'est NLR." }]);
    expect(rows()).toEqual([
      { key: "k1", target: "@leo", text: "Salut Léo, c'est NLR.", status: "sent", message_id: "101", peer_id: "4242" },
    ]);
  });

  it("refuse une clé réutilisée sans rappeler le sidecar", async () => {
    setup();
    const a = account({ minIntervalSeconds: 0 });
    await a.send({ to: "@leo", text: "un", idempotency_key: "same" });
    await expect(a.send({ to: "@leo", text: "deux", idempotency_key: "same" })).rejects.toMatchObject({ code: "duplicate_key" });
    expect(calls).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it("impose 5 s entre deux envois (défaut), puis laisse passer", async () => {
    setup();
    const a = account();
    await a.send({ to: "@leo", text: "un", idempotency_key: "a" });
    clock += 2_000;
    await expect(a.send({ to: "@leo", text: "deux", idempotency_key: "b" })).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("3 s") as unknown,
    });
    expect(calls).toHaveLength(1);
    clock += 3_000;
    await a.send({ to: "@leo", text: "deux", idempotency_key: "b" });
    expect(calls).toHaveLength(2);
  });

  it("aucun plafond quotidien : 40 envois espacés passent tous", async () => {
    setup();
    const a = account();
    for (let i = 0; i < 40; i++) {
      await a.send({ to: "@leo", text: String(i), idempotency_key: `n${String(i)}` });
      clock += 5_000;
    }
    expect(calls).toHaveLength(40);
  });

  it("FloodWait ≤ 60 s : attend le délai puis réessaie une fois ; > 60 s : refus net qui rend le délai", async () => {
    setup();
    const a = account({ minIntervalSeconds: 0 });
    let n = 0;
    nextResult = (args) => (n++ === 0 ? { ok: false, error: "flood_wait", message: "attente 12 s", definite: true, seconds: 12 } : sentOk(args));
    await expect(a.send({ to: "@leo", text: "x", idempotency_key: "f1" })).resolves.toMatchObject({ idempotency_key: "f1" });
    expect(calls).toHaveLength(2);
    expect(slept[0]).toBeGreaterThanOrEqual(12_000);
    expect(rows()).toMatchObject([{ key: "f1", status: "sent" }]);
    nextResult = () => ({ ok: false, error: "flood_wait", message: "attente 300 s", definite: true, seconds: 300 });
    await expect(a.send({ to: "@leo", text: "y", idempotency_key: "f2" })).rejects.toMatchObject({
      code: "flood_wait",
      retryAfterSeconds: 300,
    });
    expect(calls).toHaveLength(3);
    expect(slept).toHaveLength(1);
    // Rien n'est parti : la clé est rendue.
    expect(rows().map((r) => r.key)).toEqual(["f1"]);
    // Deux FloodWait courts de suite : un seul nouvel essai, puis refus.
    nextResult = () => ({ ok: false, error: "flood_wait", message: "attente 5 s", definite: true, seconds: 5 });
    await expect(a.send({ to: "@leo", text: "z", idempotency_key: "f3" })).rejects.toMatchObject({ code: "flood_wait", retryAfterSeconds: 5 });
    expect(calls).toHaveLength(5);
  });

  it("le préfixe coach: est réservé aux coachs Telegram", async () => {
    setup();
    await expect(account().send({ to: "@leo", text: "x", idempotency_key: "coach:x:1" })).rejects.toMatchObject({ code: "invalid_key" });
    expect(calls).toHaveLength(0);
  });

  it("erreur claire quand la session manque, sans appeler le sidecar", async () => {
    setup(false);
    await expect(account().send({ to: "@leo", text: "x", idempotency_key: "k" })).rejects.toMatchObject({
      code: "not_logged_in",
      message: expect.stringContaining("user_account.py login") as unknown,
    });
    expect(calls).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("erreur claire quand telegram-user.json manque", async () => {
    await expect(account().send({ to: "@leo", text: "x", idempotency_key: "k" })).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("refus net du sidecar : clé rendue ; issue incertaine : clé gardée", async () => {
    setup();
    const a = account({ minIntervalSeconds: 0 });
    nextResult = () => ({ ok: false, error: "not_found", message: "Aucun compte.", definite: true });
    await expect(a.send({ to: "@nobody", text: "x", idempotency_key: "k" })).rejects.toMatchObject({ code: "not_found" });
    expect(rows()).toHaveLength(0);
    nextResult = () => ({ ok: false, error: "timeout", message: "trop long", definite: false });
    await expect(a.send({ to: "@leo", text: "x", idempotency_key: "k" })).rejects.toMatchObject({ code: "timeout" });
    expect(rows()).toMatchObject([{ key: "k", status: "uncertain" }]);
    nextResult = sentOk;
    await expect(a.send({ to: "@leo", text: "x", idempotency_key: "k" })).rejects.toMatchObject({ code: "duplicate_key" });
  });

  it("Telethon absent : le message du sidecar remonte tel quel", async () => {
    setup();
    nextResult = () => ({
      ok: false,
      error: "telethon_missing",
      message: "Telethon n'est pas installe pour ce Python. Installer avec : python -m pip install telethon",
      definite: true,
    });
    await expect(account().send({ to: "@leo", text: "x", idempotency_key: "k" })).rejects.toMatchObject({
      code: "telethon_missing",
      message: expect.stringContaining("pip install telethon") as unknown,
    });
    expect(rows()).toHaveLength(0);
  });
});

describe("outils MCP du compte personnel", () => {
  const connect = async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTelegramUserTools(server, { MIND_WAKE_DATA_DIR: dataDir }, fake, { now: () => clock, sleep });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
  const payload = (result: unknown) =>
    JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

  it("status sans session : non connecté, sans appel au sidecar", async () => {
    setup(false);
    const client = await connect();
    const out = payload(await client.callTool({ name: "telegram_user_status", arguments: {} }));
    expect(out["data"]).toMatchObject({ configured: true, logged_in: false, min_interval_seconds: 5, flood_wait_retry_max_seconds: 60 });
    expect(out["data"]).not.toHaveProperty("daily_max");
    expect(calls).toHaveLength(0);
  });

  it("send puis recent passent par le sidecar ; erreur structurée sur clé réutilisée", async () => {
    setup();
    const client = await connect();
    const sent = payload(
      await client.callTool({ name: "telegram_user_send", arguments: { to: "Léo", text: "coucou", idempotency_key: "m1" } }),
    );
    expect(sent["data"]).toMatchObject({ message_id: 101, idempotency_key: "m1" });
    nextResult = () => ({ ok: true, peer: { id: 4242 }, messages: [{ id: 101, author: "moi", text: "coucou" }] });
    const recent = payload(await client.callTool({ name: "telegram_user_recent", arguments: { to: "Léo", limit: 5 } }));
    expect(recent["data"]).toMatchObject({ messages: [{ author: "moi" }] });
    expect(calls[1]!.args).toEqual(["recent", "Léo", "5"]);
    clock += 60_000;
    const dup = await client.callTool({ name: "telegram_user_send", arguments: { to: "Léo", text: "encore", idempotency_key: "m1" } });
    expect(dup.isError).toBe(true);
    expect(payload(dup)).toMatchObject({ error: "duplicate_key" });
  });

  it("FloodWait long : erreur structurée avec retry_after_seconds", async () => {
    setup();
    const client = await connect();
    nextResult = () => ({ ok: false, error: "flood_wait", message: "attente 120 s", definite: true, seconds: 120 });
    const out = await client.callTool({ name: "telegram_user_send", arguments: { to: "@leo", text: "x", idempotency_key: "fw" } });
    expect(out.isError).toBe(true);
    expect(payload(out)).toMatchObject({ error: "flood_wait", retry_after_seconds: 120 });
  });
});

describe("lecture des dialogues et des documents reçus", () => {
  const workspace = () => path.join(dataDir, "ws");
  const connect = async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTelegramUserTools(server, { MIND_WAKE_DATA_DIR: dataDir, MIND_WAKE_TELEGRAM_USER_MEDIA_MAX_MB: "2" }, fake, {
      now: () => clock,
      sleep,
      workspace,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
  const payload = (result: unknown) =>
    JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

  it("dialogs : sidecar `dialogs <n>`, borne 100 par défaut 20", async () => {
    setup();
    const client = await connect();
    nextResult = () => ({ ok: true, dialogs: [{ id: 1, name: "A", type: "private", last_media: true, last_direction: "in" }] });
    const out = payload(await client.callTool({ name: "telegram_user_dialogs", arguments: {} }));
    expect(out["data"]).toEqual({ dialogs: [{ id: 1, name: "A", type: "private", last_media: true, last_direction: "in" }] });
    await client.callTool({ name: "telegram_user_dialogs", arguments: { limit: 10 } });
    expect(calls.map((c) => c.args)).toEqual([["dialogs", "20"], ["dialogs", "10"]]);
  });

  it("media sans cible : dossier .local/inbox-telegram/<jour Paris>, plafond et délai long transmis", async () => {
    setup();
    // 23:30 UTC le 19 = 00:30 le 20 à Paris.
    clock = Date.parse("2026-11-19T23:30:00.000Z");
    const timeouts: (number | undefined)[] = [];
    const sidecar: UserSidecar = async (args, stdin, timeoutMs) => {
      timeouts.push(timeoutMs);
      return fake(args, stdin);
    };
    const file = path.join(workspace(), ".local", "inbox-telegram", "2026-11-20", "7-cv.pdf");
    nextResult = () => ({
      ok: true, path: file, name: "cv.pdf", size: 1234, mime: "application/pdf", date: "2026-11-19T22:00:00+00:00",
      message_id: 7, direction: "in", dialog: { id: 9, name: "Marco" },
    });
    const result = await new TelegramUserAccount(dataDir, sidecar, { now: () => clock, sleep, workspace }).media({});
    expect(calls[0]?.args).toEqual([
      "media", "--dest", path.join(workspace(), ".local", "inbox-telegram", "2026-11-20"), "--scan", "20", "--max-bytes", String(50 * 1024 * 1024),
    ]);
    expect(timeouts).toEqual([300_000]);
    expect(result).toMatchObject({ path: file, workspace_path: ".local/inbox-telegram/2026-11-20/7-cv.pdf", name: "cv.pdf", size: 1234, dialog: { name: "Marco" } });
    expect(result).not.toHaveProperty("session_lock_retries");
  });

  it("media via MCP : to + message_id transmis ; message_id sans to refusé sans appel", async () => {
    setup();
    const client = await connect();
    nextResult = () => ({ ok: true, path: path.join(workspace(), "x"), name: "x", size: 1, mime: null, date: null, message_id: 3, direction: "in", dialog: { id: 1, name: "A" } });
    await client.callTool({ name: "telegram_user_media", arguments: { to: "@leo", message_id: 3, scan: 5 } });
    expect(calls[0]?.args.slice(3)).toEqual(["--scan", "5", "--max-bytes", String(2 * 1024 * 1024), "--to", "@leo", "--message-id", "3"]);
    const bad = await client.callTool({ name: "telegram_user_media", arguments: { message_id: 3 } });
    expect(bad.isError).toBe(true);
    expect(payload(bad)).toMatchObject({ error: "invalid_target" });
    expect(calls).toHaveLength(1);
    nextResult = () => ({ ok: false, error: "too_large", message: "trop gros", definite: true });
    const big = await client.callTool({ name: "telegram_user_media", arguments: {} });
    expect(payload(big)).toMatchObject({ error: "too_large" });
  });

  it("session tenue par le relais inbound : courts nouveaux essais, signalés ; puis erreur claire", async () => {
    setup();
    let locked = 2;
    nextResult = () => (locked-- > 0 ? { ok: false, error: "session_locked", message: "locked", definite: true } : { ok: true, dialogs: [] });
    const out = await account().dialogs({ limit: 3 });
    expect(out).toEqual({ dialogs: [], session_lock_retries: 2 });
    expect(slept).toEqual([1_000, 2_000]);
    nextResult = () => ({ ok: false, error: "session_locked", message: "locked", definite: true });
    calls = [];
    await expect(account().dialogs()).rejects.toMatchObject({ code: "session_locked" });
    expect(calls).toHaveLength(4);
  });
});
