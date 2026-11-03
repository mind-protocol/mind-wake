import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerCoachTools } from "./coach-tools.js";
const server = new McpServer({ name: "mind-wake-coach", version: "0.1.0" });
registerCoachTools(server, process.env);
await server.connect(new StdioServerTransport());
