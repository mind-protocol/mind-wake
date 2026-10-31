import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ConnectorRecords } from "../local.js";
import { NotionLocal } from "./local.js";
import { notionCommand } from "../../cli/commands/notion.js";
import { processContext } from "../../cli/context.js";
import { config, root, syntheticNotion } from "../../../test/fixtures/notion/provider.js";

function fixture() {
  const directory = path.resolve(".local/notion-binding/" + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const values = new Map<string, string>();
  const records = new ConnectorRecords(directory, {
    put: (value) => {
      const ref = randomUUID();
      values.set(ref, value);
      return Promise.resolve(ref);
    },
    get: (ref) => Promise.resolve(values.get(ref) ?? ""),
    delete: (ref) => {
      values.delete(ref);
      return Promise.resolve();
    },
  });
  return { directory, records };
}

it.each(["account", "workspace", "identity", "disabled"])(
  "production binding rejects %s mismatch before content",
  async (mode) => {
    const f = fixture();
    const transport = vi.fn(syntheticNotion);
    try {
      const tokenRef = await f.records.vault.put(
        JSON.stringify({
          token: "SYNTHETIC",
          accountId: mode === "account" ? root : config.accountId,
          workspaceId: mode === "workspace" ? root : config.workspaceId,
        }),
      );
      await f.records.write("notion", {
        config: mode === "identity" ? { ...config, workspaceId: root } : config,
        tokenRef,
        grant: {
          provider: "notion",
          account: config.accountId,
          generation: "one",
          enabled: mode !== "disabled",
        },
      });
      if (mode === "identity") {
        // Credential matches the local record, but the provider reports another workspace.
        const bound = await f.records.vault.put(
          JSON.stringify({ token: "SYNTHETIC", accountId: config.accountId, workspaceId: root }),
        );
        const record = await f.records.read("notion");
        if (!record) throw Error("fixture record missing");
        await f.records.write("notion", { ...record, tokenRef: bound });
      }
      const local = new NotionLocal(
        f.records,
        () => ({ allowed: true, revision: "fixture" }),
        transport,
      );
      await expect(
        local.run((reader) => reader.get([{ kind: "page", id: root }])),
      ).rejects.toMatchObject({ code: mode === "disabled" ? "disabled" : "account_mismatch" });
      expect(transport.mock.calls.every(([request]) => request.path === "/users/me")).toBe(true);
      if (mode !== "identity") expect(transport).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

it("disconnect during owner confirmation prevents Notion setup with zero provider calls", async () => {
  const f = fixture();
  const filename = path.join(f.directory, "scope.json");
  fs.writeFileSync(filename, JSON.stringify(config));
  const transport = vi.fn(syntheticNotion);
  try {
    const ctx = {
      ...processContext(),
      prompt: async () => {
        await f.records.remove("notion");
        return "CONNECT";
      },
    };
    const result = await notionCommand(
      ctx,
      { path: f.directory, source: "option" },
      "notion-setup",
      filename,
      {
        records: f.records,
        interactive: () => true,
        control: () => ({ allowed: true, revision: "fixture" }),
        secret: () => Promise.resolve("SYNTHETIC_TOKEN"),
        transport,
      },
    );
    expect(result.data).toEqual({ error: "stopped" });
    expect(transport).not.toHaveBeenCalled();
    expect(await f.records.read("notion")).toBeNull();
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
