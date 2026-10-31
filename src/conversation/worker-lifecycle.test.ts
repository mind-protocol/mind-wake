import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ConversationStore } from "./store.js";
import { serveConversation } from "./worker.js";

it("disposes the shared provider resources when the worker stops, without a model call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-worker-dispose-"));
  try {
    const store = new ConversationStore(dir);
    store.createConversation("main");
    store.close();
    const runtime = {
      run: vi.fn(() => Promise.reject(Error("No model expected"))),
      dispose: vi.fn(() => Promise.resolve()),
    };
    await serveConversation(dir, "main", { runtime, allow: () => false });
    expect(runtime.run).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
