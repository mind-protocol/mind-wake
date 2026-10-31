import { expect, it } from "vitest";
import { roleThreadConfig } from "./role-thread-config.js";
import { CONVERSATION_ROLES } from "./contracts.js";

const config = {
  mcp_servers: {
    "local.tool": { command: "node", env: { SECRET: "not for forwarding" } },
    remote: { url: "https://example.test/mcp", http_headers: { Authorization: "private" } },
  },
  features: { shell_tool: true, other: true },
};
it("restricts process tools for reasoning while preserving remote MCP configuration", () => {
  const result = roleThreadConfig(config, "lead", 1);
  expect(result).toEqual({
    mcp_servers: { "local.tool": { enabled: false } },
    features: { shell_tool: false, shell_snapshot: false, multi_agent: false },
    plugins: { "unified-computer-use@openai-bundled": { enabled: false } },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|SECRET|not for forwarding/);
  expect(config.mcp_servers["local.tool"].command).toBe("node");
});
it("keeps source lookup and technical work native in their first pass", () => {
  expect(roleThreadConfig(config, "context", 1)).toEqual({ features: { shell_snapshot: false } });
  expect(roleThreadConfig(config, "work", 1)).toEqual({ features: { shell_snapshot: false } });
});
it("does not start local tools for any role during retrospective rewriting", () => {
  for (const role of CONVERSATION_ROLES)
    expect(roleThreadConfig(config, role, 2)["mcp_servers"]).toEqual({
      "local.tool": { enabled: false },
    });
});
it("rejects an unknown effective MCP shape rather than silently starting everything", () => {
  expect(() => roleThreadConfig({}, "pattern", 1)).toThrow("effective MCP");
});
