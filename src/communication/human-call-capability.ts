import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typeScriptNodeArgs } from "../cli/script-entry.js";

export interface HumanCallIdentity {
  readonly dataDir: string;
  readonly signature: string;
}
interface LaunchContext {
  readonly repoDir?: string;
  readonly node?: string;
}
type Server = Record<string, unknown>;
export const HUMAN_CALL_SERVER = "mind_calls";
export const HUMAN_CALL_TOOLS = ["call", "call_human", "list_active_calls", "hangup_call", "invite_to_call"] as const;
/**
 * Outils dont l'absence signale une restriction explicite. invite_to_call (18 nov. 2026) s'ajoute aux
 * autorisations sans rendre « restreinte » une configuration qui liste les trois outils d'avant.
 */
const HUMAN_CALL_CORE_TOOLS = ["call_human", "list_active_calls", "hangup_call"] as const;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function callToolsRestricted(server: Server): boolean {
  const tools = server["tools"];
  if (tools === undefined) return false;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return true;
  return HUMAN_CALL_TOOLS.some(name => {
    const tool = (tools as Record<string, unknown>)[name];
    if (tool === undefined) return false;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return true;
    const policy = tool as Record<string, unknown>;
    return policy["enabled"] === false || policy["approval_mode"] !== undefined && !["auto", "approve"].includes(String(policy["approval_mode"]));
  });
}

export function roomCallIdentity(dataDir: string, id: number, assignedName?: string): HumanCallIdentity {
  if (id === 0) return { dataDir, signature: "Coach" };
  let name = assignedName?.trim() ?? "";
  try {
    const assignment = JSON.parse(fs.readFileSync(path.join(dataDir, "forks", String(id), "assignment.json"), "utf8"));
    if (!name && typeof assignment.name === "string") name = assignment.name.trim();
  } catch { /* Unassigned rooms retain their actual host room number. */ }
  return { dataDir, signature: name ? `${name} (Room ${id})` : `Room ${id}` };
}

export function humanCallServer(identity: HumanCallIdentity, launch: LaunchContext = {}): Server {
  if (!path.isAbsolute(identity.dataDir) || !identity.signature.trim() || /[\0\r\n]/.test(identity.signature)) {
    throw Error("Invalid host call identity");
  }
  const repo = launch.repoDir ?? repository;
  const source = path.join(repo, "services/mcp/human-call-main.ts");
  const compiled = path.join(repo, "services/mcp/human-call-main.js");
  const args = fs.existsSync(source)
    ? [...typeScriptNodeArgs(repo), source]
    : fs.existsSync(compiled) ? [compiled] : null;
  if (args === null) throw Error("Call-only MCP entry missing from the installed repository");
  return {
    command: launch.node ?? process.execPath,
    args,
    env: {
      MIND_WAKE_DATA_DIR: identity.dataDir,
      MIND_WAKE_OWNER_MESSAGES: "1",
      MIND_WAKE_OWNER_SIGNATURE: identity.signature,
      ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
    },
  };
}

/** A known host provider plus its effective tool filters, never an arbitrary script basename. */
export function callContract(server: Server, identity: HumanCallIdentity, repo = repository, allowParentIdentity = false): "provided" | "restricted" | "absent" | "foreign" {
  const args = Array.isArray(server["args"]) ? server["args"] as unknown[] : [];
  const env = server["env"] as Record<string, unknown> | undefined;
  const direct = ["fork-owner-main", "server-main", "human-call-main"].some(name =>
    ["ts", "js"].some(ext => args.some(arg => typeof arg === "string" && samePath(arg, path.join(repo, "services/mcp", `${name}.${ext}`)))));
  const wrapper = path.join(identity.dataDir, "installation/mcp.mjs");
  if (args.some(arg => typeof arg === "string" && path.isAbsolute(arg) && /[\\/]installation[\\/]mcp\.mjs$/.test(arg) && !samePath(arg, wrapper))) return "foreign";
  let owned = false;
  if (args.some(arg => typeof arg === "string" && samePath(arg, wrapper))) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(identity.dataDir, "installation/manifest.json"), "utf8"));
      const text = fs.readFileSync(wrapper, "utf8");
      owned = samePath(manifest.repoDir, repo) && samePath(manifest.dataDir, identity.dataDir)
        && text.includes("startLocal") && /['"]agent['"]/.test(text);
    } catch { /* An unknown wrapper does not establish a provider contract. */ }
  }
  if (!owned && !(direct && env?.["MIND_WAKE_OWNER_MESSAGES"] === "1")) return "absent";
  const providerDataDir = env?.["MIND_WAKE_DATA_DIR"] ?? (owned ? identity.dataDir : undefined);
  if (typeof providerDataDir !== "string" || !path.isAbsolute(providerDataDir) || !samePath(providerDataDir, identity.dataDir)) return "foreign";
  const providerSignature = env?.["MIND_WAKE_OWNER_SIGNATURE"] ?? "Marco";
  if (typeof providerSignature !== "string" || !allowParentIdentity && providerSignature.trim() !== identity.signature.trim()) return "foreign";
  const enabled = server["enabled_tools"];
  const disabled = server["disabled_tools"];
  if (server["enabled"] === false
      || Array.isArray(enabled) && !HUMAN_CALL_CORE_TOOLS.every(tool => enabled.includes(tool))
      || Array.isArray(disabled) && HUMAN_CALL_TOOLS.some(tool => disabled.includes(tool))
      || callToolsRestricted(server)) return "restricted";
  return "provided";
}

export function callMcpConfig(existing: string | undefined, identity: HumanCallIdentity, launch: LaunchContext = {}): string {
  const config = existing ? JSON.parse(existing.trimStart().startsWith("{") ? existing : fs.readFileSync(existing, "utf8")) : { mcpServers: {} };
  const servers = config.mcpServers ?? {};
  const contracts = Object.values(servers).map(server => callContract(server as Server, identity, launch.repoDir));
  if (contracts.includes("foreign")) throw Error("Call MCP belongs to another host profile or identity; review required");
  // An explicit restriction wins. Do not add another route around a disabled call tool.
  if (contracts.some(contract => contract !== "absent")) return JSON.stringify(config);
  if (Object.hasOwn(servers, HUMAN_CALL_SERVER)) throw Error("Call MCP server name already owned by an unknown configuration");
  config.mcpServers = { ...servers, [HUMAN_CALL_SERVER]: humanCallServer(identity, launch) };
  return JSON.stringify(config);
}

/** TOML metadata subset: strings, booleans, numbers, arrays and inline tables.
 * Parsing never executes configuration or emits its values. Unsupported owned data fails closed. */
function parseMcpTomlValue(source: string): unknown {
  let i = 0;
  const space = () => { while (i < source.length) { if (/\s/.test(source[i]!)) i++; else if (source[i] === "#") { while (i < source.length && source[i] !== "\n") i++; } else break; } };
  const value = (): unknown => {
    space(); const ch = source[i];
    if (ch === "'" || ch === '"') {
      const start = i++; if (source.slice(start, start + 3) === ch.repeat(3)) throw Error("Unsupported multiline string");
      while (i < source.length) {
        if (source[i] === ch) { i++; const raw = source.slice(start, i); return ch === "'" ? raw.slice(1, -1) : JSON.parse(raw); }
        if (source[i] === "\n" || source[i] === "\r") throw Error("Unclosed string");
        if (ch === '"' && source[i] === "\\") i++;
        i++;
      }
      throw Error("Unclosed string");
    }
    if (ch === "[" || ch === "{") {
      i++; const array: unknown[] = [], table: Record<string, unknown> = {}; const end = ch === "[" ? "]" : "}";
      space();
      while (source[i] !== end) {
        if (i >= source.length) throw Error("Unclosed collection");
        if (ch === "[") array.push(value());
        else {
          space(); let key: string;
          if (source[i] === "'" || source[i] === '"') key = String(value());
          else { const match = /^[A-Za-z0-9_-]+/.exec(source.slice(i)); if (!match) throw Error("Invalid key"); key = match[0]; i += key.length; }
          space(); if (source[i++] !== "=") throw Error("Missing equals");
          if (Object.hasOwn(table, key)) throw Error("Duplicate key"); table[key] = value();
        }
        space(); if (source[i] === end) break; if (source[i++] !== ",") throw Error("Missing comma"); space();
      }
      i++; return ch === "[" ? array : table;
    }
    const match = /^(true|false|[+-]?[0-9]+(?:\.[0-9]+)?)(?=\s|,|\]|}|#|$)/.exec(source.slice(i));
    if (!match) throw Error("Unsupported value"); i += match[0].length;
    return match[0] === "true" ? true : match[0] === "false" ? false : Number(match[0]);
  };
  const result = value(); space(); if (i !== source.length) throw Error("Trailing value"); return result;
}

/** Read relevant MCP tables. Invalid unrelated servers cannot block host calls. */
function inheritedCodexServers(home: string): Record<string, Server> {
  const file = path.join(home, "config.toml");
  if (!fs.existsSync(file)) return {};
  const result: Record<string, Server> = {}, errors = new Set<string>(), raw = new Map<string, string>(), seen = new Set<string>();
  let name: string | undefined, section = "";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = /^\s*\[mcp_servers\.(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')(?:\.(env|tools(?:\.(?:call|call_human|list_active_calls|hangup_call|invite_to_call))?))?\]\s*(?:#.*)?$/.exec(line);
    if (header) { name = header[1] ?? header[2] ?? header[3]; section = header[4] ?? ""; result[name!] ??= {}; continue; }
    if (/^\s*\[/.test(line)) { name = undefined; continue; }
    if (!name) continue;
    const field = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const key = field[1]!;
    const relevant = section === "env" ? ["MIND_WAKE_OWNER_MESSAGES", "MIND_WAKE_DATA_DIR", "MIND_WAKE_OWNER_SIGNATURE"].includes(key)
      : section === "tools" ? HUMAN_CALL_TOOLS.includes(key as typeof HUMAN_CALL_TOOLS[number])
      : section.startsWith("tools.") ? ["enabled", "approval_mode"].includes(key)
      : ["command", "args", "enabled", "enabled_tools", "disabled_tools", "env", "tools"].includes(key);
    if (!relevant) continue;
    let text = field[2]!;
    // Collections may span lines. Stop at a table boundary; never consume another server.
    if (text.startsWith("[") || text.startsWith("{")) {
      while (true) {
        try { parseMcpTomlValue(text); break; } catch { /* Complete or reject below. */ }
        const next = lines[index + 1]; if (next === undefined || /^\s*\[[A-Za-z_]/.test(next)) break;
        text += "\n" + next; index++;
      }
    }
    raw.set(name, (raw.get(name) ?? "") + "\n" + text);
    try {
      const parsed = parseMcpTomlValue(text); const server = result[name]!;
      const fieldId = `${name}.${section}.${key}`; if (seen.has(fieldId)) throw Error("Duplicate metadata"); seen.add(fieldId);
      if (!section && (["command"].includes(key) && typeof parsed !== "string"
          || ["args", "enabled_tools", "disabled_tools"].includes(key) && (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string"))
          || key === "enabled" && typeof parsed !== "boolean")) throw Error("Invalid metadata type");
      if (!section) server[key] = parsed;
      else if (section === "env" || section === "tools") server[section] = {...server[section] as Server | undefined, [key]: parsed};
      else { const tool = section.slice(6); const tools = server["tools"] as Server | undefined; server["tools"] = {...tools, [tool]: {...tools?.[tool] as Server | undefined, [key]: parsed}}; }
    } catch { errors.add(name); }
  }
  for (const serverName of errors) {
    const server = result[serverName]!;
    const metadata = raw.get(serverName) ?? "";
    // A broken known route must not become an apparently absent route that we bypass.
    if (serverName === HUMAN_CALL_SERVER || /(?:mcp\.mjs|(?:server|fork-owner|human-call)-main\.(?:ts|js)|MIND_WAKE_)/.test(metadata)
        || (server["env"] as Server | undefined)?.["MIND_WAKE_OWNER_MESSAGES"] !== undefined) {
      throw Error("Non-canonical MCP metadata requires host review before adding call tools");
    }
    delete result[serverName];
  }
  return result;
}

export function claudeCallMcpConfig(existing: string | undefined, identity: HumanCallIdentity, native: boolean): string | undefined {
  if (!existing && native) {
    const file = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(file)) {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      const contracts = Object.values(config.mcpServers ?? {}).map(server => callContract(server as Server, identity));
      if (contracts.includes("foreign")) throw Error("Global call MCP belongs to another host profile or identity; review required");
      if (contracts.some(contract => contract !== "absent")) return undefined;
    }
  }
  return callMcpConfig(existing, identity);
}

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`).join(",")}}`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  throw Error("Invalid MCP value");
}

/** Standard Codex consent settings for owner-authorized call tools only. */
export function codexCallApprovalOverrides(name: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw Error("Non-canonical MCP server name requires host review");
  return Object.fromEntries(HUMAN_CALL_TOOLS.map(tool => [`mcp_servers.${name}.tools.${tool}.approval_mode`, '"approve"']));
}

export function withCodexCallApprovals(server: Server, expectedDataDir?: string): Server {
  const env = server["env"] as Record<string, unknown> | undefined;
  const dataDir = expectedDataDir ?? env?.["MIND_WAKE_DATA_DIR"];
  const signature = env?.["MIND_WAKE_OWNER_SIGNATURE"] ?? "Marco";
  if (typeof dataDir !== "string" || typeof signature !== "string") return server;
  const contract = callContract(server, {dataDir, signature});
  if (contract === "foreign") throw Error("Call MCP belongs to another host profile; review required");
  if (contract !== "provided") return server;
  const previous = server["tools"];
  if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) throw Error("Invalid MCP tool configuration");
  const tools = previous as Record<string, unknown> | undefined;
  return {...server, tools: {...tools, ...Object.fromEntries(HUMAN_CALL_TOOLS.map(tool => [tool, {...tools?.[tool] as Record<string, unknown> | undefined, approval_mode: "approve"}]))}};
}

export function callCodexOverrides(
  identity: HumanCallIdentity,
  inheritedHome?: string,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const effective = inheritedHome ? inheritedCodexServers(inheritedHome) : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (/^mcp_servers\.[A-Za-z0-9_-]+\.tools(?:\.(?:call|call_human|list_active_calls|hangup_call|invite_to_call))?$/.test(key)) throw Error("Non-canonical MCP tool policy requires host review");
    const tool = /^mcp_servers\.([A-Za-z0-9_-]+)\.tools\.(call|call_human|list_active_calls|hangup_call|invite_to_call)\.(enabled|approval_mode)$/.exec(key);
    if (tool) {
      const server = effective[tool[1]!] ??= {}, tools = server["tools"] as Record<string, unknown> | undefined;
      server["tools"] = {...tools, [tool[2]!]: {...tools?.[tool[2]!] as Record<string, unknown> | undefined, [tool[3]!]: JSON.parse(value)}};
      continue;
    }
    const owner = /^mcp_servers\.([A-Za-z0-9_-]+)\.env\.(MIND_WAKE_OWNER_MESSAGES|MIND_WAKE_DATA_DIR|MIND_WAKE_OWNER_SIGNATURE)$/.exec(key);
    if (owner) {
      const server = effective[owner[1]!] ??= {};
      server["env"] = { ...server["env"] as Record<string, unknown> | undefined, [owner[2]!]: JSON.parse(value) };
      continue;
    }
    const field = /^mcp_servers\.([A-Za-z0-9_-]+)\.(command|args|enabled|enabled_tools|disabled_tools)$/.exec(key);
    if (!field) continue;
    const server = effective[field[1]!] ??= {};
    try { server[field[2]!] = JSON.parse(value); }
    catch { throw Error("Non-canonical MCP override requires host review before adding call tools"); }
  }
  const own = effective[HUMAN_CALL_SERVER];
  const enabled = own?.["enabled_tools"];
  const disabled = own?.["disabled_tools"];
  if (own && (own["enabled"] === false
      || Array.isArray(enabled) && !HUMAN_CALL_CORE_TOOLS.every(tool => enabled.includes(tool))
      || Array.isArray(disabled) && HUMAN_CALL_TOOLS.some(tool => disabled.includes(tool))
      || callToolsRestricted(own))) return {};
  if (own && (own["command"] !== undefined || own["args"] !== undefined) && callContract(own, identity) === "absent") {
    throw Error("Call MCP server name already owned by an unknown configuration");
  }
  for (const [name, server] of Object.entries(effective)) {
    const status = callContract(server, identity, repository, identity.signature !== "Marco");
    if (status === "foreign") throw Error("Call MCP belongs to another host profile or identity; review required");
    if (status === "restricted") return {};
    if (status === "provided") {
      if(identity.signature === "Marco") return { [`mcp_servers.${name}.required`]: "true", [`mcp_servers.${name}.startup_timeout_sec`]: "30", ...codexCallApprovalOverrides(name) };
      const previousDisabled = Array.isArray(server["disabled_tools"]) ? server["disabled_tools"] as string[] : [];
      // A non-principal role gets its own host identity, not the inherited principal caller.
      const ownRoute = callCodexOverrides(identity);
      if (name === HUMAN_CALL_SERVER) return ownRoute;
      return {...ownRoute, [`mcp_servers.${name}.disabled_tools`]:toml([...new Set([...previousDisabled,...HUMAN_CALL_TOOLS])])};
    }
  }
  const server = humanCallServer(identity);
  return {...Object.fromEntries(Object.entries({ ...server, required: true, startup_timeout_sec: 30 })
    .map(([key, value]) => [`mcp_servers.${HUMAN_CALL_SERVER}.${key}`, toml(value)])), ...codexCallApprovalOverrides(HUMAN_CALL_SERVER)};
}

/** Supervised workshops keep their existing parent MCP identity; no identity is manufactured. */
export function inheritedCallOverrides(dataDir: string, home: string): Record<string, string> {
  const identity = { dataDir, signature: "inherited-host" };
  for (const [name, server] of Object.entries(inheritedCodexServers(home))) {
    const status = callContract(server, identity, repository, true);
    if (status === "foreign") throw Error("Inherited call MCP belongs to another host profile; review required");
    if (status === "restricted") return {};
    if (status === "provided") return { [`mcp_servers.${name}.required`]: "true", [`mcp_servers.${name}.startup_timeout_sec`]: "30", ...codexCallApprovalOverrides(name) };
  }
  return {};
}
