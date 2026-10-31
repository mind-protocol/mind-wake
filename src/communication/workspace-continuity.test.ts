import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { configureWorkspaceSync } from "../daemon/workspace-git-sync.js";
import { activateWorkspace } from "../daemon/workspace-config.js";
import { FIL_DOCUMENT, reconcileFil } from "./fil-continuity.js";
import { readWakeLocations, readWakeHistory } from "./wake-history.js";
import { claudeSessionUuid } from "../adapters/claude/conversation.js";
it("writes continuity and locates runtime history under the activated custom workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-custom-history-"));
  try {
    const data = path.join(root, "profile"),
      work = path.join(root, "selected"),
      config = path.join(root, "config");
    fs.mkdirSync(data);
    fs.mkdirSync(work);
    await configureWorkspaceSync(data, { workspaceDir: work, githubUrl: "", enabled: false });
    activateWorkspace(data);
    reconcileFil(data);
    expect(fs.existsSync(path.join(work, FIL_DOCUMENT))).toBe(true);
    expect(readWakeLocations(data).workspace).toBe(work);
    const runtime = path.join(data, "runtimes", "claude");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, "conversations.json"),
      JSON.stringify({ w: { key: "w", generation: 0 } }),
    );
    const project = path.join(config, "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, claudeSessionUuid("w", 0) + ".jsonl"),
      JSON.stringify({ type: "user", uuid: "p", message: { content: "Custom wake" } }),
    );
    expect(readWakeHistory(data, config).turns.map((t) => t.prompt)).toEqual(["Custom wake"]);
    expect(fs.existsSync(path.join(data, "workspace", FIL_DOCUMENT))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
