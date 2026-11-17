/** Indicateur « … » (sendChatAction typing) après un message de NLR via le bot. Faux API, aucun appel réel. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramOwner } from "../services/mcp/telegram-tools.js";

const OWNER = 1864364329;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bridge = any;
let dataDir: string;
let calls: { method: string; input: Record<string, unknown> }[];
let failChatAction: boolean;
let bridge: Bridge;

const update = (id: number, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: OWNER, type: "private" },
    from: { id: OWNER, username: "nlr_ai" },
    text: "Salut",
    ...extra,
  },
});
const typingCalls = () => calls.filter((c) => c.method === "sendChatAction");

async function makeBridge(updates: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { TelegramBridge } = await import("../services/telegram/bridge.mjs" as string);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return new TelegramBridge({
    dataDir,
    username: "nlr_ai",
    ownerId: OWNER,
    api: {
      call: async (method: string, input: Record<string, unknown>) => {
        if (method === "getUpdates") return updates;
        calls.push({ method, input });
        if (method === "sendChatAction" && failChatAction) throw Error("réseau");
        return {};
      },
    },
    readThread: async () => [],
    receive: async () => {},
    transcribe: async () => "",
  }) as Bridge;
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-typing-"));
  calls = [];
  failChatAction = false;
});
afterEach(() => {
  bridge?.close();
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Telegram typing indicator", () => {
  it("starts on an owner message, refreshes every 4.5 s, stops when telegram_send_owner replies", async () => {
    bridge = await makeBridge([update(1)]);
    await bridge.incoming();
    await vi.advanceTimersByTimeAsync(0);
    expect(typingCalls()).toEqual([{ method: "sendChatAction", input: { chat_id: OWNER, action: "typing" } }]);
    await vi.advanceTimersByTimeAsync(4500);
    expect(typingCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4500);
    expect(typingCalls()).toHaveLength(3);

    const owner = new TelegramOwner(dataDir, async () => ({ message_id: 9 }));
    await owner.send_({ text: "Réponse", idempotency_key: "k1" });
    await vi.advanceTimersByTimeAsync(4500 * 5);
    expect(typingCalls()).toHaveLength(3);
    expect(bridge.typing).toBeNull();
  });

  it("stops after the 3 min timeout without a reply", async () => {
    bridge = await makeBridge([update(1)]);
    await bridge.incoming();
    await vi.advanceTimersByTimeAsync(180_000 + 10_000);
    const n = typingCalls().length;
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThanOrEqual(41);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typingCalls()).toHaveLength(n);
    expect(bridge.typing).toBeNull();
  });

  it("sendChatAction errors never block ingestion and are only noted", async () => {
    failChatAction = true;
    bridge = await makeBridge([update(1), update(2)]);
    await bridge.incoming();
    await vi.advanceTimersByTimeAsync(4500);
    expect(bridge.get("offset")).toBe("3");
    expect(typingCalls().length).toBeGreaterThan(0);
    expect(JSON.parse(bridge.get("typingError") as string)).toMatchObject({ code: "local/network" });
    expect(bridge.typing).not.toBeNull();
  });

  it("an earlier owner reply does not cancel typing for a new message; /start shows none", async () => {
    const owner = new TelegramOwner(dataDir, async () => ({ message_id: 1 }));
    bridge = await makeBridge([update(1, { text: "/start" })]);
    await owner.send_({ text: "avant", idempotency_key: "old" });
    await bridge.incoming();
    await vi.advanceTimersByTimeAsync(5000);
    expect(typingCalls()).toHaveLength(0);
    bridge.close();
    vi.setSystemTime(Date.now() + 60_000);
    bridge = await makeBridge([update(2)]);
    await bridge.incoming();
    await vi.advanceTimersByTimeAsync(4500);
    expect(typingCalls()).toHaveLength(2);
  });
});
