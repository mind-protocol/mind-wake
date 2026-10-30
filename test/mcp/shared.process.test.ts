import { it, expect } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:https";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digest } from "../../services/advice/conversation/capability.js";
import { RemoteHubLink } from "../../services/mcp/shared-https.js";
import { HubStore } from "../../services/mcp/store.js";
import { MCP_DIR, NODE_ARGS, minimalEnv } from "./harness.js";

it("two real MCP stdio clients share HTTPS/SQLite messages, reject unsafe calls and survive restart/revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mind-shared-"));
  const cert = join(dir, "cert.pem"),
    tlsKey = join(dir, "tls-key.pem"),
    config = join(dir, "hub.json");
  const openssl =
    process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
      ? "C:/Program Files/Git/usr/bin/openssl.exe"
      : "openssl";
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
  const aKey = randomBytes(24).toString("base64url"),
    bKey = randomBytes(24).toString("base64url");
  const party = (id: string, key: string) => ({
    privateId: id,
    kind: "agent",
    keyDigest: digest(key),
    permissions: { message: true, requestHelp: false, guide: false },
  });
  const settings = {
    parties: [party("private-lab-a", aKey), party("private-lab-b", bKey)],
    closeGraceMs: 0,
  };
  writeFileSync(config, JSON.stringify(settings));
  // Existing foreign thread: assertions must reject an actual stored thread, not only a random ID.
  mkdirSync(join(dir, "db"));
  const seed = new HubStore(join(dir, "db", "mind-mcp.sqlite"));
  const foreignA = seed.ensureParty("foreign-private-a", "agent");
  const foreignB = seed.ensureParty("foreign-private-b", "agent");
  const foreign = seed.insertMessage({
    senderRef: foreignA,
    recipientRef: foreignB,
    provenance: "agent",
    text: "Foreign thread",
    idempotencyKey: "foreign-seed-001",
  });
  seed.close();
  let child: ChildProcess | undefined;
  const clients: Client[] = [];
  let port = 0,
    stderr = "";
  async function start() {
    const proc = spawn(
      process.execPath,
      [
        ...NODE_ARGS,
        join(MCP_DIR, "shared-hub-main.ts"),
        "--config",
        config,
        "--dir",
        join(dir, "db"),
        "--cert",
        cert,
        "--key",
        tlsKey,
        "--port",
        String(port),
      ],
      { env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    child = proc;
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error(`not ready ${stderr}`));
      }, 15000);
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(Error(`early exit ${stderr}`));
      });
      createInterface({ input: proc.stdout }).on("line", (line) => {
        const ready = JSON.parse(line) as { ready: boolean; port: number };
        if (ready.ready) {
          clearTimeout(timer);
          resolve(ready.port);
        }
      });
    });
  }
  async function stop() {
    const proc = child;
    if (!proc || proc.exitCode !== null) return;
    proc.kill();
    await new Promise<void>((resolve) =>
      proc.once("exit", () => {
        resolve();
      }),
    );
  }
  async function connect(key: string) {
    const client = new Client({ name: "real-shared-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, join(MCP_DIR, "shared-server-main.ts")],
        env: {
          ...minimalEnv(),
          NODE_EXTRA_CA_CERTS: cert,
          MIND_SHARED_HUB_URL: `https://127.0.0.1:${String(port)}/v1/messages`,
          MIND_SHARED_LINK_KEY: key,
        },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  }
  const outputs: string[] = [];
  async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await c.callTool({ name, arguments: args });
    const blocks = result.content as { text?: string }[];
    const text = blocks[0]?.text ?? "{}";
    outputs.push(text);
    return JSON.parse(text) as Record<string, unknown>;
  }
  function raw(key: string, body: unknown, path = "/v1/messages") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        `https://127.0.0.1:${String(port)}${path}`,
        {
          method: "POST",
          ca: readFileSync(cert),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body: data });
          });
        },
      );
      req.on("error", reject);
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  }
  try {
    await start();
    const a = await connect(aKey),
      b = await connect(bKey);
    expect((await a.listTools()).tools.map((x) => x.name).sort()).toEqual([
      "list_directory",
      "read_inbox",
      "reply_to_thread",
      "send_message",
      "whoami",
    ]);
    const aRef = (await call(a, "whoami"))["ref"],
      bRef = (await call(b, "whoami"))["ref"];
    expect(aRef).not.toBe(bRef);
    expect((await call(a, "list_directory"))["parties"]).toMatchObject([{ ref: bRef }]);
    const args = {
      to: bRef,
      text: "Synthetic shared question",
      idempotency_key: "shared-first-0001",
    };
    const sent = await call(a, "send_message", args);
    expect(sent["duplicate"]).toBe(false);
    const inbox = await call(b, "read_inbox");
    expect(inbox["messages"]).toMatchObject([
      {
        message_id: sent["message_id"],
        thread_id: sent["thread_id"],
        trust: "untrusted_party_content",
        provenance: { kind: "agent", channel: "mind-shared-hub" },
      },
    ]);
    const answer = await call(b, "reply_to_thread", {
      thread_id: sent["thread_id"],
      in_reply_to: sent["message_id"],
      text: "Synthetic answer",
      idempotency_key: "shared-answer-0001",
    });
    expect(answer["thread_id"]).toBe(sent["thread_id"]);
    expect(
      (await call(a, "read_inbox", { thread_id: sent["thread_id"] }))["messages"],
    ).toHaveLength(2);
    expect(
      (
        await call(a, "reply_to_thread", {
          thread_id: "thr_abcdefghijk",
          text: "foreign",
          idempotency_key: "shared-foreign-01",
        })
      )["error"],
    ).toBe("unknown_reference");
    expect((await call(a, "read_inbox", { thread_id: foreign.message.threadId }))["error"]).toBe(
      "unknown_reference",
    );
    expect(
      (
        await call(b, "reply_to_thread", {
          thread_id: foreign.message.threadId,
          text: "forbidden",
          idempotency_key: "foreign-reply-01",
        })
      )["error"],
    ).toBe("unknown_reference");
    expect((await raw("unknown-unpaired-key-00000", { id: 1, op: "whoami" })).status).toBe(401);
    expect(
      (
        await raw(aKey, {
          id: 1,
          op: "publish_help",
          topic: "forbidden",
          context: "",
          language: "fr",
          maxExchanges: 1,
          idempotencyKey: "forbidden-00001",
        })
      ).status,
    ).toBe(400);
    expect((await raw(aKey, { id: 1, op: "hello", version: 1, key: bKey })).status).toBe(400);
    expect((await raw(aKey, { id: 1, op: "whoami", sender: bRef })).status).toBe(400);
    expect((await raw(aKey, "x".repeat(33000))).status).toBe(400);
    expect((await raw(aKey, { id: 1, op: "whoami" }, "/other")).status).toBe(400);
    expect((await call(a, "send_message", { ...args, text: "conflict" }))["error"]).toBe(
      "idempotency_conflict",
    );
    await stop();
    await start();
    expect((await call(a, "whoami"))["ref"]).toBe(aRef);
    expect((await call(a, "send_message", args))["message_id"]).toBe(sent["message_id"]);
    expect((await call(a, "send_message", args))["duplicate"]).toBe(true);
    expect((await call(b, "read_inbox", { after: inbox["next"] }))["messages"]).toHaveLength(0);
    writeFileSync(config, JSON.stringify({ ...settings, parties: [settings.parties[0]] }));
    expect((await call(b, "whoami"))["error"]).toBe("not_authenticated");
    expect((await call(a, "whoami"))["ref"]).toBe(aRef);
    expect(outputs.join("\n")).not.toContain(aKey);
    expect(outputs.join("\n")).not.toContain(bKey);
    expect(outputs.join("\n")).not.toContain("private-lab-");
    expect(stderr).not.toContain(aKey);
    expect(stderr).not.toContain(bKey);
    expect(() => new RemoteHubLink("http://127.0.0.1/v1/messages", aKey)).toThrow();
    expect(() => new RemoteHubLink("https://example.test/v1/messages?key=x", aKey)).toThrow();
    // Parent process does not trust the temporary CA: TLS verification must fail.
    await expect(
      new RemoteHubLink(`https://127.0.0.1:${String(port)}/v1/messages`, aKey).call({
        op: "whoami",
      }),
    ).rejects.toThrow("injoignable");
    // Redirects are refused even when TLS is valid (tested by a client subprocess).
    const redirect = createServer(
      { cert: readFileSync(cert), key: readFileSync(tlsKey) },
      (_req, res) => {
        res.writeHead(302, { location: `https://127.0.0.1:${String(port)}/v1/messages` });
        res.end();
      },
    );
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirect.address() as { port: number }).port;
    try {
      const c = new Client({ name: "redirect-test", version: "1" });
      clients.push(c);
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [...NODE_ARGS, join(MCP_DIR, "shared-server-main.ts")],
          env: {
            ...minimalEnv(),
            NODE_EXTRA_CA_CERTS: cert,
            MIND_SHARED_HUB_URL: `https://127.0.0.1:${String(redirectPort)}/v1/messages`,
            MIND_SHARED_LINK_KEY: aKey,
          },
        }),
      );
      expect((await call(c, "whoami"))["error"]).toBe("internal");
    } finally {
      await new Promise<void>((resolve) =>
        redirect.close(() => {
          resolve();
        }),
      );
    }
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    await stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
