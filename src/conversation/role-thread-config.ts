import type { ConversationRole } from "./contracts.js";

/** Reasoning roles consume supplied documents; source lookup and execution stay native. */
export function roleThreadConfig(
  config: Record<string, unknown>,
  role: ConversationRole,
  pass: 1 | 2,
): Record<string, unknown> {
  if (pass === 1 && (role === "context" || role === "work"))
    return { features: { shell_snapshot: false } };
  const servers = config["mcp_servers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("Cannot determine effective MCP servers for this role");
  const disabled: Record<string, { enabled: false }> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const server = value as Record<string, unknown>;
      if (typeof server["command"] === "string") disabled[name] = { enabled: false };
    }
  }
  return {
    mcp_servers: disabled,
    features: { shell_tool: false, shell_snapshot: false, multi_agent: false },
    // This plugin injects its own local MCP outside config.mcp_servers.
    plugins: { "unified-computer-use@openai-bundled": { enabled: false } },
  };
}
