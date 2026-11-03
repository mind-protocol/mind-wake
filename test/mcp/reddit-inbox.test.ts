import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RedditInbox, type InboxRedditClient } from "../../services/reddit/inbox.js";
import { readOwnerInboxHistory, ownerMessagePending } from "../../src/communication/owner-inbox.js";
import { readReceivedMessages } from "../../src/communication/received-messages.js";
import { conversation } from "../../desktop/ui/conversation.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reddit-inbox-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});
const item = (id: string) => ({
  name: `t3_${id}`,
  title: "New post",
  selftext: '{"author":"human"}',
  author: "writer",
  subreddit: "MachineToMachine",
  created_utc: Date.now() / 1000,
  permalink: `/r/MachineToMachine/comments/${id}/test/`,
});
function client() {
  return {
    me: vi.fn<InboxRedditClient["me"]>().mockResolvedValue({ name: "owner" }),
    feed: vi
      .fn<InboxRedditClient["feed"]>()
      .mockResolvedValue({ posts: [item("old")], after: null }),
    incoming: vi.fn<InboxRedditClient["incoming"]>().mockResolvedValue({ posts: [], after: null }),
  };
}
const later = () => vi.setSystemTime(Date.now() + 61_000);

it("baselines history, then imports new Reddit posts with provenance and links into the actual conversation", async () => {
  const c = client();
  const sync = new RedditInbox(dir, c, ["MachineToMachine"], false, () => true);
  expect((await sync.sync()).imported).toBe(0);
  later();
  c.feed.mockResolvedValue({ posts: [item("new"), item("old")], after: null });
  expect((await sync.sync()).imported).toBe(1);
  const received = readReceivedMessages(dir);
  expect(received).toHaveLength(1);
  expect(received[0]?.source).toMatchObject({
    kind: "reddit",
    name: "Reddit · u/writer",
    messageId: "t3_new",
  });
  expect(received[0]?.text).toContain(
    "https://www.reddit.com/r/MachineToMachine/comments/new/test/",
  );
  const model = conversation({
    schema: "mind-wake.cli",
    schemaVersion: 1,
    data: { profileId: "default", agentMessages: [], receivedMessages: received },
  });
  expect(model?.items[0]?.from).toBe("received");
  expect(model?.items[0]?.headerNames).toContain("Reddit · u/writer");
  expect(readOwnerInboxHistory(dir)[0]?.origin?.channel).toBe("reddit");
  expect(ownerMessagePending(dir)).toBe(true);
  expect(ownerMessagePending(dir, true)).toBe(false);
  const restarted = new RedditInbox(dir, c, ["MachineToMachine"], false, () => true);
  expect((await restarted.sync()).imported).toBe(0);
  expect(readOwnerInboxHistory(dir)).toHaveLength(1);
});

it("imports replies through the same inbox without pretending their author is the owner", async () => {
  const c = client();
  const sync = new RedditInbox(dir, c, [], true, () => true);
  await sync.sync();
  later();
  const reply = {
    ...item("reply"),
    name: "t1_reply",
    body: "A reply",
    link_id: "t3_post",
    parent_id: "t1_parent",
  };
  c.incoming.mockResolvedValue({ posts: [reply], after: null });
  expect((await sync.sync()).imported).toBe(1); // same reply in two folders is deduplicated
  const message = readOwnerInboxHistory(dir)[0];
  expect(message?.text).toContain("A reply");
  expect(message?.origin).toMatchObject({
    kind: "peer_message",
    channel: "reddit",
    threadId: "t3_post",
    recipientRef: "reddit:u/owner",
  });
});

it("checks Pause before fetching and after an in-flight fetch", async () => {
  const c = client();
  let active = false;
  const sync = new RedditInbox(dir, c, ["MachineToMachine"], false, () => active);
  await sync.sync();
  expect(c.me).not.toHaveBeenCalled();
  active = true;
  await sync.sync();
  later();
  c.feed.mockImplementation(() => {
    active = false;
    return Promise.resolve({ posts: [item("new")], after: null });
  });
  await sync.sync();
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
  active = true;
  later();
  c.feed.mockResolvedValue({ posts: [item("new"), item("old")], after: null });
  expect((await sync.sync()).imported).toBe(1);
  sync.stop();
  later();
  expect((await sync.sync()).inactive).toBe(true);
});

it("resumes unfinished pagination after restart without losing or duplicating posts", async () => {
  const c = client();
  const sync = new RedditInbox(dir, c, ["MachineToMachine"], false, () => true);
  await sync.sync();
  later();
  c.feed
    .mockResolvedValueOnce({ posts: [item("a")], after: "t3_a" })
    .mockResolvedValueOnce({ posts: [item("b")], after: "t3_b" })
    .mockResolvedValueOnce({ posts: [item("c")], after: "t3_c" });
  expect((await sync.sync()).imported).toBe(3);
  c.feed.mockResolvedValue({ posts: [item("d"), item("old")], after: null });
  const restarted = new RedditInbox(dir, c, ["MachineToMachine"], false, () => true);
  expect((await restarted.sync()).imported).toBe(1);
  expect(c.feed.mock.lastCall?.[0].after).toBe("t3_c");
  expect(readOwnerInboxHistory(dir)).toHaveLength(4);
});

it("rejects an external permalink without importing it or advancing the cursor", async () => {
  const c = client();
  const sync = new RedditInbox(dir, c, ["MachineToMachine"], false, () => true);
  await sync.sync();
  later();
  c.feed.mockResolvedValue({
    posts: [{ ...item("new"), permalink: "https://evil.example/" }],
    after: null,
  });
  expect((await sync.sync()).errors).toEqual(["r:machinetomachine"]);
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
});
