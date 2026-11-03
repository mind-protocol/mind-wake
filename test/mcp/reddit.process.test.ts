import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath, pathToFileURL } from "node:url";

it("registers Reddit in the real MIND stdio server and reports missing OAuth safely", async () => {
  const client = new Client({ name: "reddit-process-test", version: "1" });
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
    env: {
      MIND_REDDIT_ENABLED: "1",
      MIND_REDDIT_USER_AGENT: "desktop:mind-wake:0.1 (by /u/test)",
      MIND_REDDIT_ACCESS_TOKEN: "",
      MIND_REDDIT_REFRESH_TOKEN: "",
      MIND_REDDIT_ALLOW_WRITE: "0",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("reddit_me");
    expect(names).toContain("reddit_search");
    expect(names).not.toContain("reddit_submit");
    const result = await client.callTool({ name: "reddit_me", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("configuration");
  } finally {
    await client.close();
    await transport.close();
  }
}, 30_000);
