import { DESKTOP_TOOLS } from "../../services/mcp/desktop-tools.js";
/**
 * Outils d'un agent de room (mandat « une room, plusieurs agents », 16 nov. 2026) : réglage
 * none / read / publish, signature propre ; Colony en lecture seule refuse tout outil d'écriture.
 */
import { expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSignedOwnerTools } from "../../services/mcp/fork-owner-main.js";
import { colonyToolIsReadOnly } from "../../services/mcp/colony-tools.js";

function recorder() {
  const tools: { name: string; description: string }[] = [];
  const server = {
    server: {},
    registerTool: (name: string, config: { description?: string }) => {
      tools.push({ name, description: config.description ?? "" });
      return {};
    },
  } as unknown as McpServer;
  return { tools, names: () => tools.map((t) => t.name), server };
}
function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-agent-tools-"));
  const colonyKey = JSON.stringify({ version: 1, enabled: true, apiKey: "col_" + "x".repeat(30) });
  fs.writeFileSync(path.join(dir, "colony.json"), colonyKey);
  fs.writeFileSync(path.join(dir, "colony-fixeur.json"), colonyKey);
  fs.writeFileSync(
    path.join(dir, "reddit.json"),
    JSON.stringify({ version: 1, enabled: true, clientId: "client-id", refreshToken: "token", userAgent: "test-agent", allowWrite: true }),
  );
  return dir;
}
const agentEnv = (dir: string, name: string, tools: string, colony = "colony-fixeur.json") => ({
  MIND_WAKE_DATA_DIR: dir,
  MIND_WAKE_OWNER_SIGNATURE: name,
  MIND_WAKE_OWNER_PROFILE: "publish",
  MIND_WAKE_OWNER_COLONY: colony,
  MIND_WAKE_OWNER_FORK: "2",
  MIND_WAKE_OWNER_TOOLS: tools,
});

it("coach Telegram (tools none) : ni Colony ni Reddit, même avec un compte présent ; signature propre", () => {
  const dir = dataDir();
  try {
    const r = recorder();
    registerSignedOwnerTools(r.server, agentEnv(dir, "Coach Telegram", "none"));
    expect(r.names()).toEqual(["list_owner_messages", "message_owner", "generate_image", "computer_use", ...DESKTOP_TOOLS, "call_human", "post_to_fork_thread"]);
    expect(r.tools.find((t) => t.name === "message_owner")?.description).toContain("signed « Coach Telegram »");
    expect(r.tools.find((t) => t.name === "post_to_fork_thread")?.description).toContain("signed « Coach Telegram »");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("coach Colony (publish) : Colony de son compte et Reddit en lecture ; coach en lecture (read) : mêmes noms, Colony bridé", () => {
  const dir = dataDir();
  try {
    const publish = recorder();
    registerSignedOwnerTools(publish.server, agentEnv(dir, "Coach Colony", "publish"));
    expect(publish.names()).toEqual([
      "list_owner_messages", "message_owner", "generate_image", "computer_use", ...DESKTOP_TOOLS, "call_human", "reddit_me", "reddit_feed", "reddit_search", "reddit_thread",
      "colony_list_tools", "colony_call_tool", "post_to_fork_thread",
    ]);
    expect(publish.tools.find((t) => t.name === "post_to_fork_thread")?.description).toContain("signed « Coach Colony »");
    const read = recorder();
    registerSignedOwnerTools(read.server, agentEnv(dir, "Coach Colony 3", "read"));
    expect(read.names()).toEqual(publish.names());
    expect(read.names()).not.toContain("reddit_submit");
    // Sans compte Colony (owner.colony absent) : aucun outil Colony.
    const none = recorder();
    registerSignedOwnerTools(none.server, agentEnv(dir, "Coach des coachs", "publish", ""));
    expect(none.names().some((n) => n.startsWith("colony_"))).toBe(false);
    expect(() => registerSignedOwnerTools(recorder().server, agentEnv(dir, "X Y", "admin"))).toThrow("Outils externes inconnus");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("Colony en lecture seule : seul un outil annoncé readOnlyHint est appelable", async () => {
  const pages = [
    { tools: [{ name: "get_post", annotations: { readOnlyHint: true } }], nextCursor: "p2" },
    { tools: [{ name: "create_comment", annotations: { readOnlyHint: false } }, { name: "vote" }] },
  ];
  const client = { listTools: (cursor?: string) => Promise.resolve(cursor === "p2" ? pages[1]! : pages[0]!) };
  expect(await colonyToolIsReadOnly(client as never, "get_post")).toBe(true);
  expect(await colonyToolIsReadOnly(client as never, "create_comment")).toBe(false);
  expect(await colonyToolIsReadOnly(client as never, "vote")).toBe(false);
  expect(await colonyToolIsReadOnly(client as never, "inconnu")).toBe(false);
});

it("tout agent de room relit le fil principal (list_owner_messages) sans pouvoir le modifier", () => {
  const dir = dataDir();
  try {
    for (const tools of ["none", "read", "publish"]) {
      const r = recorder();
      registerSignedOwnerTools(r.server, agentEnv(dir, "Agent " + tools, tools, tools === "none" ? "" : "colony-fixeur.json"));
      expect(r.names()).toContain("list_owner_messages");
      expect(r.tools.find((t) => t.name === "list_owner_messages")?.description).toContain("Read-only");
      for (const forbidden of ["edit_owner_message", "delete_owner_message", "publish_image"]) expect(r.names()).not.toContain(forbidden);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
