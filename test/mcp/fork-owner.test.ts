import { expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { registerSignedOwnerTools, signOwnerText } from "../../services/mcp/fork-owner-main.js";

// NLR 6 nov. 2026 : VOX (Fork 7) écrit à NLR par un outil explicite, message signé.
it("signs each owner message once", () => {
  expect(signOwnerText("VOX (Fork 7)", "  bonjour NLR ")).toBe("VOX (Fork 7) : bonjour NLR");
  expect(signOwnerText("VOX (Fork 7)", "VOX (Fork 7) : déjà signé")).toBe("VOX (Fork 7) : déjà signé");
});

it("exposes message_owner only, and requires a signature", () => {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  registerSignedOwnerTools(server, { MIND_WAKE_DATA_DIR: "D:/data", MIND_WAKE_OWNER_SIGNATURE: "VOX (Fork 7)" });
  expect(names).toEqual(["message_owner"]);
  expect(() => registerSignedOwnerTools(server, { MIND_WAKE_DATA_DIR: "D:/data" })).toThrow("SIGNATURE");
});
