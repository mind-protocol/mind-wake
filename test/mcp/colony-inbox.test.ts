import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ColonyInbox, type InboxColonyClient } from "../../services/colony/inbox.js";
import { ColonyRateLimit } from "../../services/colony/client.js";
import { readOwnerInboxHistory, ownerMessagePending } from "../../src/communication/owner-inbox.js";
import { readReceivedMessages } from "../../src/communication/received-messages.js";
import { conversation } from "../../desktop/ui/conversation.js";

let dir: string;
const account = randomUUID();
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-inbox-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  // Only test-created files, without recursively deleting a computed path.
  for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file));
  fs.rmdirSync(dir);
});
const later = () => vi.setSystemTime(Date.now() + 61_000);
const item = (read = false) => ({
  id: randomUUID(),
  notification_type: "reply_to_comment",
  message: "An agent replied",
  actor: { id: randomUUID(), username: "other-agent", display_name: "Other Agent" },
  post_id: randomUUID(),
  comment_id: randomUUID(),
  is_read: read,
  created_at: new Date().toISOString(),
  comment_preview: { excerpt: "An actual reply excerpt", truncated: true },
});
function client() {
  return {
    me: vi.fn<InboxColonyClient["me"]>().mockResolvedValue({ id: account }),
    notifications: vi.fn<InboxColonyClient["notifications"]>().mockResolvedValue([]),
  };
}

it("imports waiting unread replies as received Colony messages with links, not human messages", async () => {
  const c = client();
  const reply = item();
  c.notifications.mockResolvedValue([
    reply,
    item(true),
    { ...item(), notification_type: "new_follower" },
  ]);
  const inbox = new ColonyInbox(dir, c, () => true);
  expect((await inbox.sync()).imported).toBe(1);
  const received = readReceivedMessages(dir);
  expect(received).toHaveLength(1);
  expect(received[0]?.source).toMatchObject({
    kind: "thecolony",
    name: "The Colony · other-agent",
    originKind: "peer_message",
  });
  expect(received[0]?.text).toContain(
    `https://thecolony.ai/post/${reply.post_id}?focus_comment=${reply.comment_id}`,
  );
  expect(received[0]?.text).toContain("Extrait");
  const model = conversation({
    schema: "mind-wake.cli",
    schemaVersion: 1,
    data: { profileId: "default", agentMessages: [], receivedMessages: received },
  });
  expect(model?.items[0]?.from).toBe("received");
  expect(ownerMessagePending(dir)).toBe(true);
  expect(ownerMessagePending(dir, true)).toBe(false);
});

it("deduplicates notification types for one comment, survives restart and sees new replies already read elsewhere", async () => {
  const c = client();
  const old = item();
  c.notifications.mockResolvedValue([
    old,
    { ...old, id: randomUUID(), notification_type: "mention" },
  ]);
  expect((await new ColonyInbox(dir, c, () => true).sync()).imported).toBe(1);
  expect((await new ColonyInbox(dir, c, () => true).sync()).inactive).toBe(true);
  later();
  const fresh = item(true);
  c.notifications.mockResolvedValue([fresh, old]);
  expect((await new ColonyInbox(dir, c, () => true).sync()).imported).toBe(1);
  expect(readOwnerInboxHistory(dir)).toHaveLength(2);
});

it("checks pause before network and after an in-flight fetch, then resumes without losing the reply", async () => {
  const c = client();
  let active = false;
  const inbox = new ColonyInbox(dir, c, () => active);
  await inbox.sync();
  expect(c.me).not.toHaveBeenCalled();
  active = true;
  c.notifications.mockImplementation(() => {
    active = false;
    return Promise.resolve([item()]);
  });
  await inbox.sync();
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
  later();
  active = true;
  c.notifications.mockResolvedValue([item()]);
  expect((await inbox.sync()).imported).toBe(1);
  inbox.stop();
  later();
  expect((await inbox.sync()).inactive).toBe(true);
});

it("resumes a paginated backlog after restart and excludes historical read replies", async () => {
  const c = client();
  const rows = Array.from({ length: 305 }, () => item(true));
  rows[304] = item();
  c.notifications.mockImplementation((offset) => Promise.resolve(rows.slice(offset, offset + 100)));
  expect(await new ColonyInbox(dir, c, () => true).sync()).toMatchObject({
    imported: 0,
    backlog: true,
  });
  later();
  expect((await new ColonyInbox(dir, c, () => true).sync()).imported).toBe(1);
  expect(c.notifications.mock.lastCall?.[0]).toBe(300);
});

it("honors provider backoff across MCP clients and rejects malformed notifications", async () => {
  const c = client();
  c.notifications.mockRejectedValueOnce(new ColonyRateLimit(180));
  await expect(new ColonyInbox(dir, c, () => true).sync()).rejects.toThrow("rate limited");
  later();
  expect((await new ColonyInbox(dir, c, () => true).sync()).inactive).toBe(true);
  vi.setSystemTime(Date.now() + 180_000);
  c.notifications.mockResolvedValue([{ ...item(), post_id: "https://evil.example" }]);
  await expect(new ColonyInbox(dir, c, () => true).sync()).rejects.toThrow();
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
});

it("does not duplicate requests while another MCP process owns the collector lease", async () => {
  const c = client();
  let release: ((data: unknown) => void) | undefined;
  c.notifications.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = new ColonyInbox(dir, c, () => true).sync();
  await Promise.resolve();
  expect((await new ColonyInbox(dir, c, () => true).sync()).inactive).toBe(true);
  release?.([]);
  await pending;
  expect(c.notifications).toHaveBeenCalledTimes(1);
});
