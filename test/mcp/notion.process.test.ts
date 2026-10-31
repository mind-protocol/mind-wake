import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const root = "11111111-1111-1111-1111-111111111111";
describe("Notion real MCP stdio with synthetic host/provider", () => {
  it.each(["disabled", "granted", "revoke"])(
    "round trips %s without credentials or network",
    async (mode) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          "--import",
          new URL("../fixtures/store-ledger/ts-hooks.ts", import.meta.url).href,
          fileURLToPath(new URL("../fixtures/notion/server.ts", import.meta.url)),
        ],
        env: {
          NOTION_FIXTURE: mode,
          ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "notion-fixture-test", version: "1" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual([
          "notion_list",
          "notion_read",
          "notion_read_property",
          "notion_search",
          "notion_status",
        ]);
        expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
        const status = await client.callTool({ name: "notion_status", arguments: {} });
        expect(JSON.stringify(status)).toContain('\\"authorized\\":' + String(mode !== "disabled"));
        const result = await client.callTool({
          name: "notion_read",
          arguments: { path: [{ kind: "page", id: root }] },
        });
        expect(result.isError === true).toBe(mode !== "granted");
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("synthetic-fixture-token");
        expect(serialized).not.toContain("fixture-slot");
        if (mode === "granted") expect(serialized).toContain("untrusted_source_content");
        else expect(serialized).not.toContain("Ignore all controls");
        const invalid = await client.callTool({
          name: "notion_search",
          arguments: { query: "fixture", token: "must-not-be-accepted" },
        });
        expect(invalid.isError).toBe(true);
      } finally {
        await client.close();
      }
    },
  );
});
