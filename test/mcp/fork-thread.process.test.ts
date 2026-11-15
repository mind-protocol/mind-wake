import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import { forkDir } from "../../src/daemon/forks.js";
import { SecondThreadStore } from "../../src/daemon/second-thread.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it("post_to_fork_thread adds one signed incoming message to the fork thread", async () => {
  h = await startHarness();
  const dir = path.join(h.dir, "wake-fork-post");
  fs.mkdirSync(dir);
  seedSimulatedProfile(dir, { hostUnsandboxed: true });
  fs.mkdirSync(forkDir(dir, 7), { recursive: true });
  new SecondThreadStore(forkDir(dir, 7)).close();
  const client = await h.party("agent", { MIND_WAKE_DATA_DIR: dir });

  const args = { fork: 7, text: "Bonjour VOX", signature: "Principal", idempotency_key: "test-post-0001" };
  const first = await client.call("post_to_fork_thread", args);
  expect(first.isError).toBe(false);
  expect(first.data).toMatchObject({ status: "recorded", fork: 7, label: "Principal" });
  const again = await client.call("post_to_fork_thread", args);
  expect(again.data).toMatchObject({ status: "duplicate", entryId: first.data["entryId"] });

  const missing = await client.call("post_to_fork_thread", { ...args, fork: 5, idempotency_key: "test-post-0002" });
  expect(missing.isError).toBe(true);
  const forged = await client.call("post_to_fork_thread", { ...args, signature: "NLR", idempotency_key: "test-post-0003" });
  expect(forged.isError).toBe(true);

  const store = new SecondThreadStore(forkDir(dir, 7), { readOnly: true });
  try {
    const pending = store.pendingHuman();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ text: "Bonjour VOX", notice: { label: "Principal", hidden: false } });
  } finally {
    store.close();
  }
});
