import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import { messages, reply } from "../../src/cli/commands/messages.js";
import { processContext } from "../../src/cli/context.js";
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
it("real MCP publish/edit/delete updates the desktop CLI, preserves human replies and handles legacy notes", async () => {
  h = await startHarness();
  const dir = path.join(h.dir, "owner-wake");
  fs.mkdirSync(dir, { recursive: true });
  seedSimulatedProfile(dir);
  const note = path.join(dir, "workspace", "artifacts", "questions-for-human.md");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, "Ancien questionnaire");
  const client = await h.party("agent", { MIND_WAKE_DATA_DIR: dir, MIND_WAKE_OWNER_MESSAGES: "1" });
  const first = await client.call("list_owner_messages");
  const legacy = (first.data["messages"] as { id: string; version: number }[])[0]!;
  expect(legacy.id).toBe("legacy-note");
  const edited = await client.call("edit_owner_message", {
    message_id: legacy.id,
    expected_version: legacy.version,
    text: "Bonjour, j’ai une découverte.",
  });
  expect(edited.isError).toBe(false);
  const dataDir = { path: dir, source: "option" as const };
  const ctx = processContext();
  expect(messages(ctx, dataDir).data.agentNote).toBeNull();
  expect(messages(ctx, dataDir).data.agentMessages?.[0]?.text).toContain("découverte");
  await reply(
    { ...ctx, readStdin: () => Promise.resolve("Montre-moi !") },
    dataDir,
    "reply-test-001",
  );
  const version = (edited.data["message"] as { version: number }).version;
  const removed = await client.call("delete_owner_message", {
    message_id: legacy.id,
    expected_version: version,
  });
  expect(removed.isError).toBe(false);
  expect(messages(ctx, dataDir).data.agentMessages).toEqual([]);
  expect(messages(ctx, dataDir).data.replies[0]?.text).toBe("Montre-moi !");
  const sent = await client.call("message_owner", {
    text: "Voici une nouvelle piste.",
    idempotency_key: "new-message-001",
  });
  expect(sent.isError).toBe(false);
  const duplicate = await client.call("message_owner", {
    text: "Voici une nouvelle piste.",
    idempotency_key: "new-message-001",
  });
  expect(duplicate.data["message"]).toEqual(sent.data["message"]);
  expect(messages(ctx, dataDir).data.agentMessages).toHaveLength(1);
}, 60000);
