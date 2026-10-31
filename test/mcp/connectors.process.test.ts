import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CLI_MAIN, MCP_DIR, NODE_ARGS, minimalEnv } from "./harness.js";

it("actual MCP process exposes reads only, refuses absent grants, and CLI refuses noninteractive connection", async () => {
  const directory = path.resolve(".local/connector-mcp/" + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const env = { ...minimalEnv(), MIND_WAKE_DATA_DIR: directory };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, path.join(MCP_DIR, "server-main.ts")],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "connector-synthetic-test", version: "1" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("gmail_")).sort()).toEqual([
      "gmail_read_message",
      "gmail_read_thread",
      "gmail_search",
      "gmail_status",
    ]);
    expect(
      names.some((n) => /gmail.*(setup|auth|grant|send|delete|modify|attachment)/.test(n)),
    ).toBe(false);
    const state = await client.callTool({ name: "gmail_status", arguments: {} });
    const stateText = (state.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(stateText)).toMatchObject({
      installed: true,
      authorized: false,
      available: false,
    });
    const result = await client.callTool({ name: "gmail_search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("disabled");
    const cli = spawn(
      process.execPath,
      [
        ...NODE_ARGS,
        CLI_MAIN,
        "connectors",
        "gmail-setup",
        "not-read.json",
        "--data-dir",
        directory,
        "--json",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "";
    cli.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      cli.on("close", resolve);
    });
    expect(code).toBe(1);
    expect(output).toContain("disabled");
    expect(fs.existsSync(path.join(directory, "connectors/gmail.ref"))).toBe(false);
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
