import { expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FORK_EXCLUDED_TOOLS,
  REDDIT_WRITE_SIGNATURES,
  postSignedToForkThread,
  registerSignedOwnerTools,
  signOwnerText,
} from "../../services/mcp/fork-owner-main.js";

// NLR 6 nov. 2026 : VOX (Fork 7) écrit à NLR par un outil explicite, message signé.
it("signs each owner message once", () => {
  expect(signOwnerText("VOX (Room 7)", "  bonjour NLR ")).toBe("VOX (Room 7) : bonjour NLR");
  expect(signOwnerText("VOX (Room 7)", "VOX (Room 7) : déjà signé")).toBe(
    "VOX (Room 7) : déjà signé",
  );
});

// NLR 15 nov. 2026 : VOX confie des chantiers à des sous-sessions (jobs restreints aux siens).
// NLR 16 nov. 2026 : « on peut donner a vox les access mcp » ; rien sous l'identité du principal.
it("gives VOX her own job tools and the MIND tools attributable to her", () => {
  const names: string[] = [];
  const server = {
    server: {},
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-owner-"));
  registerSignedOwnerTools(server, {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_OWNER_SIGNATURE: "VOX (Room 7)",
  });
  expect(names).toEqual([
    "list_owner_messages",
    "message_owner",
    "publish_image",
    "edit_owner_message",
    "delete_owner_message",
    "start_background_job",
    "list_background_jobs",
    "cancel_background_job",
    "wake_status",
    "wake_journal",
    "wake_last_report",
    "unsure_what_to_do",
    "get_next_wakes",
    "get_wake_project",
    "list_repo_sessions",
    "read_repo_thread",
    "society_1f916_list_tools",
    "society_1f916_call_tool",
    "post_to_fork_thread",
  ]);
  expect(names.filter((n) => FORK_EXCLUDED_TOOLS.has(n))).toEqual([]);
  // Sans colony-vox.json, aucun repli sur le compte Colony du principal.
  fs.writeFileSync(
    path.join(dir, "colony.json"),
    JSON.stringify({ version: 1, enabled: true, apiKey: "col_" + "x".repeat(30) }),
  );
  names.length = 0;
  registerSignedOwnerTools(server, {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_OWNER_SIGNATURE: "VOX (Room 7)",
  });
  expect(names.some((n) => n.startsWith("colony_"))).toBe(false);
});

it("refuses a fork thread post into the fork's own room", () => {
  expect(() =>
    postSignedToForkThread("D:/data", {
      from: 7,
      fork: 7,
      text: "x",
      signature: "VOX (Room 7)",
      idempotencyKey: "abcdefgh",
    }),
  ).toThrow("propre Room");
});

it("exposes message_owner only, and requires a signature", () => {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  registerSignedOwnerTools(server, {
    MIND_WAKE_DATA_DIR: "D:/data",
    MIND_WAKE_OWNER_SIGNATURE: "Room 9",
  });
  expect(names).toEqual(["message_owner"]);
  expect(() => registerSignedOwnerTools(server, { MIND_WAKE_DATA_DIR: "D:/data" })).toThrow(
    "SIGNATURE",
  );
});

// Room 2 (16 nov. 2026) : profil publish posé par le bloc owner de l'affectation.
function recorder() {
  const names: string[] = [];
  const server = {
    server: {},
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  return { names, server };
}
function dataDirWith(files: { colony?: string; reddit?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-publish-"));
  const colonyKey = JSON.stringify({ version: 1, enabled: true, apiKey: "col_" + "x".repeat(30) });
  // Le compte du principal est toujours là : il ne doit jamais servir à une room.
  fs.writeFileSync(path.join(dir, "colony.json"), colonyKey);
  if (files.colony !== undefined) fs.writeFileSync(path.join(dir, files.colony), colonyKey);
  if (files.reddit === true)
    fs.writeFileSync(
      path.join(dir, "reddit.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        clientId: "client-id",
        refreshToken: "token",
        userAgent: "test-agent",
        allowWrite: true,
      }),
    );
  return dir;
}
const room2 = (dir: string) => ({
  MIND_WAKE_DATA_DIR: dir,
  MIND_WAKE_OWNER_SIGNATURE: "Fixeur (Room 2)",
  MIND_WAKE_OWNER_PROFILE: "publish",
  MIND_WAKE_OWNER_COLONY: "colony-fixeur.json",
  MIND_WAKE_OWNER_FORK: "2",
});

it("gives the Room 2 publish profile exactly its tools", () => {
  const dir = dataDirWith({ colony: "colony-fixeur.json", reddit: true });
  const { names, server } = recorder();
  registerSignedOwnerTools(server, room2(dir));
  expect(names).toEqual([
    "list_owner_messages",
    "message_owner",
    "reddit_me",
    "reddit_feed",
    "reddit_search",
    "reddit_thread",
    "colony_list_tools",
    "colony_call_tool",
    "post_to_fork_thread",
  ]);
  expect(names.filter((n) => FORK_EXCLUDED_TOOLS.has(n))).toEqual([]);
});

it("never gives Room 2 Reddit writes or job tools, even with allowWrite", () => {
  expect([...REDDIT_WRITE_SIGNATURES]).toEqual(["VOX (Room 7)"]);
  const dir = dataDirWith({ colony: "colony-fixeur.json", reddit: true });
  const { names, server } = recorder();
  registerSignedOwnerTools(server, room2(dir));
  for (const n of ["reddit_submit", "reddit_comment", "reddit_sync_inbox", "colony_sync_inbox"])
    expect(names).not.toContain(n);
  expect(names.some((n) => n.includes("background_job"))).toBe(false);
  expect(names.some((n) => ["publish_image", "edit_owner_message", "delete_owner_message"].includes(n))).toBe(false);
});

it("gives Room 2 no Colony tools when its own file is missing", () => {
  const dir = dataDirWith({ reddit: false });
  const { names, server } = recorder();
  registerSignedOwnerTools(server, room2(dir));
  expect(names).toEqual(["list_owner_messages", "message_owner", "post_to_fork_thread"]);
  // Un nom qui viserait le compte du principal est refusé : toujours aucun outil Colony.
  const other = recorder();
  registerSignedOwnerTools(other.server, { ...room2(dir), MIND_WAKE_OWNER_COLONY: "colony.json" });
  expect(other.names.some((n) => n.startsWith("colony_"))).toBe(false);
});

it("keeps Room 7 unchanged, with Reddit writes for VOX only", () => {
  const dir = dataDirWith({ colony: "colony-fixeur.json", reddit: true });
  const { names, server } = recorder();
  // Un profil publish dans l'environnement ne change pas l'accès étendu de VOX.
  registerSignedOwnerTools(server, {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_OWNER_SIGNATURE: "VOX (Room 7)",
    MIND_WAKE_OWNER_PROFILE: "publish",
    MIND_WAKE_OWNER_COLONY: "colony-fixeur.json",
    MIND_WAKE_OWNER_FORK: "7",
  });
  expect(names).toEqual([
    "list_owner_messages",
    "message_owner",
    "publish_image",
    "edit_owner_message",
    "delete_owner_message",
    "start_background_job",
    "list_background_jobs",
    "cancel_background_job",
    "wake_status",
    "wake_journal",
    "wake_last_report",
    "unsure_what_to_do",
    "get_next_wakes",
    "get_wake_project",
    "list_repo_sessions",
    "read_repo_thread",
    "society_1f916_list_tools",
    "society_1f916_call_tool",
    "reddit_me",
    "reddit_feed",
    "reddit_search",
    "reddit_thread",
    "reddit_submit",
    "reddit_comment",
    "post_to_fork_thread",
  ]);
});

it("refuses an unknown or incomplete owner profile", () => {
  const { server } = recorder();
  expect(() =>
    registerSignedOwnerTools(server, { ...room2("D:/data"), MIND_WAKE_OWNER_PROFILE: "admin" }),
  ).toThrow("Profil owner inconnu");
  expect(() =>
    registerSignedOwnerTools(server, { ...room2("D:/data"), MIND_WAKE_OWNER_FORK: "" }),
  ).toThrow("MIND_WAKE_OWNER_FORK");
});
