import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { notionCommand } from "../../src/cli/commands/notion.js";
import { processContext, DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { ConnectorRecords, wakeConnectorControl } from "../../src/connectors/local.js";
import { NOTION_HOSTS } from "../../src/connectors/notion/local.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import { openStore } from "../../src/store/index.js";
import { controlDbPath } from "../../src/daemon/paths.js";
import { resolvePolicy, revokePermissions } from "../../src/policy/index.js";
import { requestPause, persistEmergencyStop, StopFlag } from "../../src/runner/controls.js";
import type { ConsentId, PolicyRevisionId, UtcTimestamp } from "../../src/contracts/index.js";
import { config, root, syntheticNotion } from "../fixtures/notion/provider.js";
import { NODE_ARGS, MCP_DIR, minimalEnv } from "./harness.js";

function seed(directory: string) {
  seedSimulatedProfile(directory, { hostUnsandboxed: true });
  const store = openStore(controlDbPath(directory));
  try {
    const policy = resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID);
    if (policy.status !== "active") throw Error("fixture policy missing");
    const id = "notion-synthetic-consent" as PolicyRevisionId;
    const at = new Date().toISOString() as UtcTimestamp;
    store.uow.transaction((tx) => {
      tx.policies.appendRevision({
        ...policy.revision,
        id,
        previousRevisionId: policy.revision.id,
        createdAt: at,
        groups: {
          ...policy.revision.groups,
          network: {
            ...policy.revision.groups.network,
            explorationDestinations: [
              { host: "api.notion.com", ports: [443], purpose: "synthetic readonly test" },
            ],
          },
        },
      });
      tx.policies.recordConsent({
        id: "notion-consent" as ConsentId,
        revisionId: id,
        grantedAt: at,
        channel: "local_cli",
        proof: "SYNTHETIC TEST ONLY",
      });
      tx.profiles.setActivePolicyRevision(DEFAULT_PROFILE_ID, id);
    });
  } finally {
    store.close();
  }
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
}

it.runIf(process.platform === "win32")(
  "owner setup -> real DPAPI -> production MCP process -> search/read -> local disconnect",
  async () => {
    const directory = path.resolve(".local/notion-integrated/" + randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    seed(directory);
    const dir = { path: directory, source: "option" as const };
    const filename = path.join(directory, "scope.json");
    fs.writeFileSync(filename, JSON.stringify(config));
    const ctx = {
      ...processContext(),
      prompt: (question: string) =>
        Promise.resolve(question.includes("DISCONNECT") ? "DISCONNECT" : "CONNECT"),
    };
    const seams = {
      interactive: () => true,
      secret: () => Promise.resolve("SYNTHETIC_NOTION_TOKEN_ONLY"),
      transport: syntheticNotion,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...NODE_ARGS,
        "--import",
        new URL("../fixtures/notion/preload.ts", import.meta.url).href,
        path.join(MCP_DIR, "server-main.ts"),
      ],
      env: { ...minimalEnv(), MIND_WAKE_DATA_DIR: directory, NOTION_TEST_DIRECTORY: directory },
      stderr: "pipe",
    });
    const client = new Client({ name: "notion-production-integration", version: "1" });
    try {
      expect(wakeConnectorControl(directory, NOTION_HOSTS).allowed).toBe(true);
      await client.connect(transport);
      expect(
        (await client.callTool({ name: "notion_search", arguments: { query: "fixture" } })).isError,
      ).toBe(true);
      expect(fs.existsSync(path.join(directory, "requests.txt"))).toBe(false);
      const setup = await notionCommand(ctx, dir, "notion-setup", filename, seams);
      expect(setup.data).toMatchObject({ connected: true });
      const status = await notionCommand(ctx, dir, "notion-status");
      expect(status.data).toMatchObject({
        authorized: true,
        available: false,
        scope: { workspaceId: config.workspaceId },
      });
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("notion_")).sort()).toEqual([
        "notion_list",
        "notion_read",
        "notion_read_property",
        "notion_search",
        "notion_status",
      ]);
      expect(names.some((name) => /notion.*(grant|setup|auth|write|delete)/.test(name))).toBe(
        false,
      );
      expect(
        parse(await client.callTool({ name: "notion_status", arguments: {} }))["available"],
      ).toBe(false);
      const found = await client.callTool({
        name: "notion_search",
        arguments: { query: "fixture" },
      });
      expect(found.isError).not.toBe(true);
      expect(JSON.stringify(found)).toContain("untrusted_source_content");
      const read = await client.callTool({
        name: "notion_read",
        arguments: { path: [{ kind: "page", id: root }] },
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).not.toContain("SYNTHETIC_NOTION_TOKEN_ONLY");
      expect(
        parse(await client.callTool({ name: "notion_status", arguments: {} }))["available"],
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "notion_read",
            arguments: { path: [{ kind: "page", id: config.workspaceId }] },
          })
        ).isError,
      ).toBe(true);
      const requests = fs.readFileSync(path.join(directory, "requests.txt"), "utf8");
      expect(requests).not.toMatch(/users\/(?!me)|attachments|PATCH|DELETE/);
      expect(
        (await notionCommand(ctx, dir, "notion-disconnect", undefined, seams)).data,
      ).toMatchObject({ locallyRevoked: true });
      const count = fs.readFileSync(path.join(directory, "requests.txt"), "utf8");
      expect(
        (await client.callTool({ name: "notion_search", arguments: { query: "fixture" } })).isError,
      ).toBe(true);
      expect(fs.readFileSync(path.join(directory, "requests.txt"), "utf8")).toBe(count);
      expect(await new ConnectorRecords(directory).read("gmail")).toBeNull();
    } finally {
      await client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

it
  .runIf(process.platform === "win32")
  .each(["pause", "force-off", "policy", "revoke", "retry", "pagination"])(
  "production MCP suppresses in-flight content on %s with real persisted controls",
  async (mode) => {
    const directory = path.resolve(".local/notion-stop/" + randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    seed(directory);
    const records = new ConnectorRecords(directory);
    const tokenRef = await records.vault.put(
      JSON.stringify({
        token: "SYNTHETIC_NOTION_TOKEN_ONLY",
        accountId: config.accountId,
        workspaceId: config.workspaceId,
      }),
    );
    await records.write("notion", {
      config,
      tokenRef,
      grant: {
        provider: "notion",
        account: config.accountId,
        generation: randomUUID(),
        enabled: true,
      },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...NODE_ARGS,
        "--import",
        new URL("../fixtures/notion/preload.ts", import.meta.url).href,
        path.join(MCP_DIR, "server-main.ts"),
      ],
      env: {
        ...minimalEnv(),
        MIND_WAKE_DATA_DIR: directory,
        NOTION_TEST_DIRECTORY: directory,
        NOTION_TEST_MODE: mode,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "notion-stop-integration", version: "1" });
    try {
      await client.connect(transport);
      const pending = client.callTool({ name: "notion_search", arguments: { query: "fixture" } });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(directory, "entered"))) {
        if (Date.now() > deadline) throw Error("fixture request not entered");
        await delay(10);
      }
      if (mode === "revoke" || mode === "retry" || mode === "pagination")
        await records.remove("notion");
      else {
        const store = openStore(controlDbPath(directory));
        try {
          const ctx = { uow: store.uow, profileId: DEFAULT_PROFILE_ID, now: () => new Date() };
          if (mode === "pause") requestPause(ctx);
          else if (mode === "force-off") persistEmergencyStop(ctx, new StopFlag(directory));
          else
            revokePermissions(store.uow, {
              profileId: DEFAULT_PROFILE_ID,
              at: new Date().toISOString() as UtcTimestamp,
              reason: "synthetic integration",
            });
        } finally {
          store.close();
        }
      }
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("IGNORE ALL CONTROLS");
      const before = fs.readFileSync(path.join(directory, "requests.txt"), "utf8");
      expect(
        (await client.callTool({ name: "notion_search", arguments: { query: "fixture" } })).isError,
      ).toBe(true);
      expect(fs.readFileSync(path.join(directory, "requests.txt"), "utf8")).toBe(before);
      expect(before.split("/search").length - 1).toBe(1);
    } finally {
      await client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
