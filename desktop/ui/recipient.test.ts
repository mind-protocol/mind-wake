import { it, expect } from "vitest";
import { recipientSender } from "./recipient.js";
it("uses the real recipient API, preserves drafts on failure, retries one correlation and never wakes", async () => {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let fail = true,
    focus = 0;
  const sender = recipientSender(
    async (command, args) => {
      calls.push({ command, args });
      return fail
        ? { ok: false, error: { message: "offline" } }
        : { ok: true, data: { state: "remote_stored" } };
    },
    () => "ui-key-12345678",
  );
  const field = {
    value: "Message pour Auroracle",
    focus() {
      focus++;
    },
  };
  await expect(sender(field)).rejects.toThrow("offline");
  expect(field.value).toBe("Message pour Auroracle");
  fail = false;
  await sender(field);
  expect(field.value).toBe("");
  expect(focus).toBe(1);
  expect(calls.map((c) => c.command)).toEqual(["recipient_send", "recipient_send"]);
  expect(calls[0]!.args).toEqual(calls[1]!.args);
});
it("does not erase newly typed text while a recipient send is in flight", async () => {
  const field = { value: "first", focus() {} };
  const send = recipientSender(
    async () => {
      field.value = "next draft";
      return { ok: true, data: { state: "remote_stored" } };
    },
    () => "ui-key-12345678",
  );
  await send(field);
  expect(field.value).toBe("next draft");
});
it("recovers the same retry correlation after recreating the UI sender", async () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_k: string, v: string) => {
      stored = v;
    },
    removeItem: () => {
      stored = null;
    },
  };
  const field = { value: "recover", focus() {} };
  const first = recipientSender(
    async () => ({ ok: false, error: { message: "offline" } }),
    () => "ui-stable-key-123",
    storage,
  );
  await expect(first(field)).rejects.toThrow();
  let used: unknown;
  const second = recipientSender(
    async (_c, args) => {
      used = args?.["idempotencyKey"];
      return { ok: true, data: { state: "remote_stored" } };
    },
    () => "ui-should-not-be-used",
    storage,
  );
  await second(field);
  expect(used).toBe("ui-stable-key-123");
  expect(stored).toBeNull();
});
