/** Recipient stdio surface. Only a participant credential and trusted CA; no owner state. */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { callScopedWorkspace } from "./workspace.mjs";
import { registerScopedWorkspaceTools } from "./scoped-mcp.mjs";

const file = process.argv[2];
if (!file) throw new Error("workspace_remote_credential_file_required");
const server = new McpServer({ name: "mind-workspace-scoped", version: "0.3.0" });
registerScopedWorkspaceTools(server, {
  call(body) {
    const credential = JSON.parse(fs.readFileSync(file, "utf8"));
    return callScopedWorkspace({ ...credential, ca: fs.readFileSync(credential.caFile) }, body);
  },
});
await server.connect(new StdioServerTransport());
