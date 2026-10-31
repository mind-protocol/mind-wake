import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { workerFile } from "./worker.js";
import { recordedWorkerExit } from "./worker-status.js";
import { ConversationStore } from "./store.js";
import { conversationCommand } from "./cli.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true });
});
function fixture(pid = 123) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-worker-exit-"));
  folders.push(dir);
  fs.writeFileSync(workerFile(dir, "main"), JSON.stringify({ pid }));
  return dir;
}
function receipt(pid = 123, conversationId = "main") {
  return JSON.stringify({
    schema: "mind.conversation/owner-control",
    pid,
    conversationId,
    stopReason: "global_process_limit_exceeded",
    exit: { mainExitCode: 49374 },
  });
}
it("reports a proven exit of this exact worker, including the process limit reason", () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, "conversation-worker.log"), "non-json log\n" + receipt() + "\n");
  expect(recordedWorkerExit(dir, "main")).toContain("limite de processus");
});
it("does not turn a successful owner exit into a result-missing error", () => {
  const dir = fixture();
  const successful = JSON.parse(receipt()) as Record<string, unknown>;
  successful["stopReason"] = null;
  successful["exit"] = { mainExitCode: 0, killReason: null };
  fs.writeFileSync(
    path.join(dir, "conversation-worker.log"),
    receipt() + "\n" + JSON.stringify(successful),
  );
  expect(recordedWorkerExit(dir, "main")).toBeNull();
  successful["exit"] = { mainExitCode: 7, killReason: null };
  fs.writeFileSync(path.join(dir, "conversation-worker.log"), JSON.stringify(successful));
  expect(recordedWorkerExit(dir, "main")).toContain("avant de rendre");
});
it("does not treat a missing receipt, another worker or another conversation as an exit", () => {
  const dir = fixture();
  expect(recordedWorkerExit(dir, "main")).toBeNull();
  fs.writeFileSync(
    path.join(dir, "conversation-worker.log"),
    receipt(122) + "\n" + receipt(123, "other"),
  );
  expect(recordedWorkerExit(dir, "main")).toBeNull();
});
it("reads only a bounded tail even when logs are large and ignores truncated lines", () => {
  const dir = fixture();
  fs.writeFileSync(
    path.join(dir, "conversation-worker.log"),
    "x".repeat(100000) + "\n" + receipt(),
  );
  expect(recordedWorkerExit(dir, "main")).toContain("limite de processus");
});

it("recovers abandoned calls on read only with a matching exit receipt, without relaunching", async () => {
  const dir = fixture();
  const store = new ConversationStore(dir);
  store.submit("main", "Question conservée", "request");
  store.addCall({
    id: "abandoned",
    conversationId: "main",
    revision: 1,
    role: "lead",
    pass: 1,
    systemPrompt: "Fixture",
    messages: [],
  });
  store.close();
  let launches = 0;
  const options = {
    allow: () => true,
    launch: () => {
      launches++;
      return Promise.resolve();
    },
  };
  const initial = await conversationCommand(dir, "read", {}, options);
  expect((initial["calls"] as { status: string }[])[0]?.status).toBe("running");
  fs.writeFileSync(path.join(dir, "conversation-worker.log"), receipt());
  const recovered = await conversationCommand(dir, "read", {}, options);
  const call = (recovered["calls"] as { status: string; error: string }[])[0];
  expect(call?.status).toBe("interrupted");
  expect(call?.error).toContain("limite de processus");
  expect(recovered["controlReason"]).toContain("limite de processus");
  expect(launches).toBe(0);
});
