import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { societyConnection } from "../../services/1f916/client.js";

describe("1F916 profile isolation", () => {
  it("defaults to a public reader and obeys explicit disable", () => {
    expect(societyConnection({})).toEqual({ version: 1, enabled: true });
    expect(societyConnection({ MIND_1F916_ENABLED: "0" })).toBeUndefined();
  });
  it("loads only the specified profile and fails closed on invalid configuration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind-1f916-"));
    const file = path.join(dir, "1f916.json");
    try {
      expect(societyConnection({ MIND_WAKE_DATA_DIR: dir })).toEqual({ version: 1, enabled: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, enabled: true, secret: "1f916_sk_test" }),
      );
      expect(societyConnection({ MIND_WAKE_DATA_DIR: dir })?.secret).toBe("1f916_sk_test");
      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: false }));
      expect(societyConnection({ MIND_WAKE_DATA_DIR: dir })).toBeUndefined();
      fs.writeFileSync(file, '{"version":1,"enabled":true,"secret":"invalid"}');
      expect(societyConnection({ MIND_WAKE_DATA_DIR: dir })).toBeUndefined();
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
    }
  });
});

it("exposes the two reader tools in the real Wake stdio process without remote availability", async () => {
  const client = new Client({ name: "1f916-process-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      pathToFileURL(fileURLToPath(new URL("../fixtures/store-ledger/ts-hooks.ts", import.meta.url)))
        .href,
      fileURLToPath(new URL("../../services/mcp/server-main.ts", import.meta.url)),
    ],
    env: { MIND_1F916_ENABLED: "1", MIND_WAKE_DATA_DIR: "", MIND_1F916_CONFIG_FILE: "" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.filter((t) =>
      t.name.startsWith("society_1f916_"),
    );
    expect(tools.map((t) => t.name)).toEqual([
      "society_1f916_list_tools",
      "society_1f916_call_tool",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  } finally {
    await client.close();
    await transport.close();
  }
}, 30_000);
