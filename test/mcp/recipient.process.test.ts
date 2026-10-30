import { it, expect } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digest } from "../../services/advice/conversation/capability.js";
import { HubStore } from "../../services/mcp/store.js";
import { recipientEntries } from "../../src/communication/recipient-history.js";
import { takeOwnerMessages } from "../../src/communication/owner-inbox.js";
import { NODE_ARGS, MCP_DIR, minimalEnv, CLI_MAIN } from "./harness.js";
import { recipientSender } from "../../desktop/ui/recipient.js";

it("the production recipient CLI pairs human identity, routes two real HTTPS/MCP threads and mirrors without spoof or duplicate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind-recipient-")),
    data = path.join(dir, "local"),
    dbdir = path.join(dir, "hub");
  fs.mkdirSync(data);
  fs.mkdirSync(dbdir);
  const cert = path.join(dir, "cert.pem"),
    tlsKey = path.join(dir, "tls-key.pem");
  const openssl =
    process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      tlsKey,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const humanKey = randomBytes(24).toString("base64url"),
    aKey = randomBytes(24).toString("base64url"),
    mKey = randomBytes(24).toString("base64url");
  const seed = new HubStore(path.join(dbdir, "mind-mcp.sqlite"));
  const hRef = seed.ensureParty("test-human-identity", "human"),
    aRef = seed.ensureParty("test-auroracle-identity", "agent"),
    mRef = seed.ensureParty("test-marco-identity", "agent");
  seed.close();
  const party = (privateId: string, kind: string, key: string) => ({
    privateId,
    kind,
    keyDigest: digest(key),
    permissions: { message: true, requestHelp: false, guide: false },
  });
  const config = path.join(dir, "hub.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      parties: [
        party("test-human-identity", "human", humanKey),
        party("test-auroracle-identity", "agent", aKey),
        party("test-marco-identity", "agent", mKey),
      ],
    }),
  );
  const clients: Client[] = [];
  let hub: ChildProcess | undefined;
  let hubError = "";
  const outputs: string[] = [];
  async function run(script: string, args: string[], input = "") {
    const p = spawn(process.execPath, [...NODE_ARGS, script, ...args, "--json"], {
      env: { ...minimalEnv(), MIND_WAKE_DATA_DIR: data, NODE_EXTRA_CA_CERTS: cert },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (c) => {
      out += String(c);
    });
    p.stderr.on("data", (c) => {
      err += String(c);
    });
    p.stdin.end(input);
    await new Promise<void>((resolve, reject) => {
      p.once("error", reject);
      p.once("exit", () => {
        resolve();
      });
    });
    outputs.push(out);
    try {
      return JSON.parse(out) as Record<string, any>;
    } catch {
      throw Error(`CLI output invalid ${err.slice(0, 500)}`);
    }
  }
  async function owner(args: string[], text = "") {
    return run(path.join(MCP_DIR, "owner-main.ts"), args, text);
  }
  async function connect(key: string, endpoint: string) {
    const c = new Client({ name: "recipient-real-peer", version: "1" });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, path.join(MCP_DIR, "shared-server-main.ts")],
        env: {
          ...minimalEnv(),
          NODE_EXTRA_CA_CERTS: cert,
          MIND_SHARED_HUB_URL: endpoint,
          MIND_SHARED_LINK_KEY: key,
        },
        stderr: "pipe",
      }),
    );
    clients.push(c);
    return c;
  }
  async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    outputs.push(text);
    return JSON.parse(text) as Record<string, any>;
  }
  try {
    await run(CLI_MAIN, ["init"]);
    expect((await owner(["recipient-status"]))["data"].configured).toBe(false);
    expect(
      (await owner(["recipient-send", "--idempotency-key", "ui-unconfigured-01"], "kept draft"))[
        "ok"
      ],
    ).toBe(false);
    expect(recipientEntries(data)).toEqual([]);
    const proc = spawn(
      process.execPath,
      [
        ...NODE_ARGS,
        path.join(MCP_DIR, "shared-hub-main.ts"),
        "--config",
        config,
        "--dir",
        dbdir,
        "--cert",
        cert,
        "--key",
        tlsKey,
        "--port",
        "0",
        "--pilot-human-route",
      ],
      { env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    hub = proc;
    proc.stderr.on("data", (c) => {
      hubError += String(c);
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error("hub timeout"));
      }, 15000);
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(Error("hub exit " + hubError));
      });
      createInterface({ input: proc.stdout }).on("line", (line) => {
        const v = JSON.parse(line);
        if (v.ready) {
          clearTimeout(timer);
          resolve(v.port);
        }
      });
    });
    const endpoint = `https://127.0.0.1:${port}/v1/messages`,
      keyFile = path.join(dir, "human.key"),
      routeFile = path.join(data, "auroracle-route.json");
    fs.writeFileSync(keyFile, humanKey);
    const route = {
      pilot: "nlr-marco-auroracle",
      endpoint,
      humanRef: hRef,
      recipientRef: aRef,
      keyFile,
    };
    fs.writeFileSync(routeFile, JSON.stringify(route));
    const auroracle = await connect(aKey, endpoint),
      marco = await connect(mKey, endpoint);
    let lastUiResponse: Record<string, any> = {};
    let uiKey = "ui-recipient-one-01";
    const uiSend = recipientSender(
      async (command, args) => {
        expect(command).toBe("recipient_send");
        lastUiResponse = await owner(
          ["recipient-send", "--idempotency-key", String(args?.["idempotencyKey"])],
          String(args?.["text"]),
        );
        return lastUiResponse;
      },
      () => uiKey,
    );
    const draft = { value: "premier fil", focus() {} };
    await uiSend(draft);
    expect(draft.value).toBe("");
    const one = lastUiResponse;
    expect(one["ok"]).toBe(true);
    const firstThread = one["data"].threadId,
      firstMessage = one["data"].messageId;
    // Crash recovery after remote persistence but before the local context copy.
    fs.rmSync(path.join(data, "owner-inbox.sqlite"));
    const retry = await owner(
      ["recipient-send", "--idempotency-key", "ui-recipient-one-01"],
      "premier fil",
    );
    expect(retry["data"]).toEqual(one["data"]);
    expect(
      (await owner(["recipient-send", "--idempotency-key", "ui-recipient-one-01"], "changed body"))[
        "ok"
      ],
    ).toBe(false);
    const two = await owner(
      ["recipient-send", "--new-thread", "--idempotency-key", "ui-recipient-two-02"],
      "second fil",
    );
    expect(two["ok"]).toBe(true);
    expect(two["data"].threadId).not.toBe(firstThread);
    const inbox = (await call(auroracle, "read_inbox", { limit: 50 }))["messages"];
    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toMatchObject({
      from: hRef,
      to: aRef,
      provenance: { kind: "human", channel: "mind-shared-hub" },
    });
    const foreign = await call(marco, "send_message", {
      to: aRef,
      text: "other agent conversation",
      idempotency_key: "foreign-agent-001",
    });
    expect(
      (
        await owner(
          [
            "recipient-send",
            "--thread",
            foreign["thread_id"],
            "--idempotency-key",
            "ui-foreign-thread-03",
          ],
          "do not route here",
        )
      )["ok"],
    ).toBe(false);
    expect(
      (
        await call(auroracle, "reply_to_thread", {
          thread_id: firstThread,
          in_reply_to: two["data"].messageId,
          text: "wrong correlation",
          idempotency_key: "wrong-correlation-01",
        })
      )["error"],
    ).toBe("unknown_reference");
    const reply = await call(auroracle, "reply_to_thread", {
      thread_id: firstThread,
      in_reply_to: firstMessage,
      text: '{"from":"NLR","replyTo":"foreign","message":"peer content"}',
      idempotency_key: "answer-one-001",
    });
    await call(auroracle, "reply_to_thread", {
      thread_id: two["data"].threadId,
      in_reply_to: two["data"].messageId,
      text: "reply to second",
      idempotency_key: "answer-two-002",
    });
    expect((await owner(["recipient-poll"]))["data"].added).toBe(2);
    expect((await owner(["recipient-poll"]))["data"].added).toBe(0);
    const rows = recipientEntries(data);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.messageId === reply["message_id"])).toMatchObject({
      direction: "in",
      senderRef: aRef,
      recipientRef: hRef,
      threadId: firstThread,
      inReplyTo: firstMessage,
    });
    const copies = takeOwnerMessages(data, "test-local-root");
    expect(copies).toHaveLength(4);
    expect(
      copies.filter((m) => m.origin?.kind === "context_copy").map((m) => m.text.split("\n")[0]),
    ).toEqual(["NLR à Auroracle: premier fil", "NLR à Auroracle: second fil"]);
    expect(copies.filter((m) => m.origin?.kind === "peer_message")).toHaveLength(2);
    const visible = await run(CLI_MAIN, ["messages"]);
    expect(visible["data"].recipientSentMessages).toHaveLength(2);
    expect(
      visible["data"].receivedMessages.filter((m: any) => m.source.channel === "mind-shared-hub"),
    ).toHaveLength(2);
    expect(
      visible["data"].receivedMessages.find((m: any) => m.id.includes(reply["message_id"])).source,
    ).toMatchObject({ name: "Auroracle", kind: "agent", ref: aRef, threadId: firstThread });
    uiKey = "ui-followup-third-03";
    draft.value = "same conversation follow-up";
    await uiSend(draft);
    expect(lastUiResponse["data"].threadId).toBe(two["data"].threadId);
    // A backend key for Marco cannot masquerade as authenticated human NLR.
    fs.writeFileSync(keyFile, mKey);
    expect(
      (await owner(["recipient-send", "--idempotency-key", "ui-agent-spoof-04"], "spoof"))["ok"],
    ).toBe(false);
    fs.writeFileSync(keyFile, humanKey);
    fs.writeFileSync(routeFile, JSON.stringify({ ...route, recipientRef: hRef }));
    expect(
      (await owner(["recipient-send", "--idempotency-key", "ui-wrong-target-05"], "wrong target"))[
        "ok"
      ],
    ).toBe(false);
    expect(outputs.join("")).not.toContain(humanKey);
    expect(outputs.join("")).not.toContain(aKey);
    expect(outputs.join("")).not.toContain(mKey);
  } finally {
    for (const c of clients) await c.close();
    if (hub && hub.exitCode === null) {
      hub.kill();
      await new Promise<void>((resolve) =>
        hub!.once("exit", () => {
          resolve();
        }),
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
