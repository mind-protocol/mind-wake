import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerForkPlannerTools } from "./fork-planner-tools.js";

const server=new McpServer({name:"mind-fork-planner",version:"0.1.0"});
registerForkPlannerTools(server,process.env);
await server.connect(new StdioServerTransport());
