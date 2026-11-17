import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerHumanCall } from "./human-call.js";

/** Only the three call tools: no owner channel, publishing, filesystem or desktop. */
export function registerCallOnly(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerHumanCall(server, env);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop() ?? "\0")
) {
  const server = new McpServer({ name: "mind-calls", version: "1" });
  registerCallOnly(server, process.env);
  await server.connect(new StdioServerTransport());
}
