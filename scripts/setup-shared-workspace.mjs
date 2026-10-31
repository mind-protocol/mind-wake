#!/usr/bin/env node
/** Additive fragment only: never edits a user's existing MCP configuration. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadState } from "../services/shared-workspace/workspace.mjs";

export function privateFile(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("private_file_required");
  const target = fs.realpathSync.native(value);
  if (!fs.statSync(target).isFile()) throw new Error("private_file_required");
  privateTarget(target);
  return target;
}
export function privateTarget(value) {
  const target = path.join(
    fs.realpathSync.native(path.dirname(path.resolve(value))),
    path.basename(value),
  );
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) throw new Error("private_file_inside_git");
    if (dir === path.dirname(dir)) break;
  }
  return target;
}
export async function setupWorkspace({ role, state, credential, output }) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 17) || (major === 26 && minor >= 13)))
    throw new Error("node_version");
  if (!["remote", "local", "scoped"].includes(role)) throw new Error("invalid_role");
  // Check installed dependencies before writing anything; no install or network action.
  await import("@modelcontextprotocol/server");
  await import("zod");
  const file = privateFile(role === "local" ? state : credential);
  if (role === "local") loadState(file);
  else {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(config.token) || !config.capability || !config.participant)
      throw new Error("invalid_credential");
    const endpoint = new URL(config.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.pathname !== (role === "scoped" ? "/v1/scoped-workspace" : "/v1/workspace") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid_endpoint");
    privateFile(config.caFile);
  }
  if (!output || !path.isAbsolute(output)) throw new Error("output_required");
  const launcher = fileURLToPath(
    new URL(`../services/shared-workspace/mcp-${role}.mjs`, import.meta.url),
  );
  const fragment = `[mcp_servers.mind_workspace_${role}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([launcher, file])}\n`;
  fs.writeFileSync(output, fragment, { flag: "wx", mode: 0o600 });
  return {
    role,
    configFragment: path.resolve(output),
    note: "Fragment only; no MCP configuration edited, permission granted, server started or wake enabled.",
  };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        role: { type: "string" },
        state: { type: "string" },
        credential: { type: "string" },
        output: { type: "string" },
      },
    });
    console.log(JSON.stringify(await setupWorkspace(values)));
  } catch {
    console.error(
      "workspace_mcp_setup_refused (check role, absolute private files outside Git, fresh output, Node and clone dependencies)",
    );
    process.exitCode = 1;
  }
}
