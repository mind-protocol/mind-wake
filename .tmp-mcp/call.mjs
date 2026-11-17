import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const t = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-transform-types","--disable-warning=ExperimentalWarning","--import","file:///C:/Users/reyno/mind-wake/test/fixtures/store-ledger/ts-hooks.ts","C:/Users/reyno/mind-wake/scripts/mcp-child.mjs","C:/Users/reyno/mind-wake/services/mcp/server-main.ts"],
  env: { ...process.env, MIND_WAKE_DATA_DIR: "C:/Users/reyno/AppData/Local/mind-wake-essai" },
  stderr: "pipe",
});
const c = new Client({ name: "marco-test", version: "1" });
await c.connect(t);
const tools = (await c.listTools()).tools.map(x=>x.name).filter(n=>n.startsWith("telegram"));
console.log("tools", tools.join(","));
if (process.argv[2] === "send") {
  const r = await c.callTool({ name: "telegram_send_owner", arguments: { text: process.argv[3], idempotency_key: process.argv[4] } });
  console.log(JSON.stringify(r.content?.[0]?.text ?? r).slice(0, 400));
}
await c.close();
