import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  BackgroundJobs,
  jobOutputDir,
  terminateBackgroundJobs,
} from "../../src/daemon/background-jobs.ts";
import { prepareScopedJob } from "../../scripts/setup-scoped-workspace-job.mjs";
import { setupWorkspace } from "../../scripts/setup-shared-workspace.mjs";
import { readScopedJobConfig, runScopedWorkspaceJob } from "./scoped-job.mjs";
import {
  localGrantScope,
  localRestoreOperation,
  grant,
  revoke,
  hash,
  callScopedWorkspace,
  callWorkspace,
  createWorkspaceServer,
  createScopedWorkspaceServer,
} from "./workspace.mjs";

const until = async (check) => {
  const end = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition_deadline");
    await new Promise((r) => setTimeout(r, 30));
  }
};
const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wake-scoped-live-"));
  const root = path.join(base, "synthetic-install", "workspace", "shared"),
    state = path.join(base, "private", "state.json");
  const data = path.join(base, "synthetic-install");
  const workspace = path.join(data, "workspace");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(state));
  fs.mkdirSync(path.join(workspace, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(root, "story.md"), "A small discovery.\n");
  const key = path.join(base, "private", "key.pem"),
    cert = path.join(base, "private", "cert.pem");
  execFileSync(
    process.env.OPENSSL ||
      (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl"),
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const owner = localGrantScope(state, {
    name: "writing",
    root,
    dataRoots: [data],
    participant: "editor",
    rights: ["list", "search", "read", "create", "write", "delete", "propose"],
  });
  const reader = localGrantScope(state, {
    name: "writing",
    root,
    dataRoots: [data],
    participant: "reader",
    rights: ["list", "search", "read", "propose"],
  });
  const legacy = grant(state, root, "legacy", true, { dataRoots: [data] });
  const config = path.join(base, "private", "server.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ stateFile: state, keyFile: key, certFile: cert, host: "127.0.0.1", port: 0 }),
  );
  return {
    base,
    root,
    state,
    data,
    workspace,
    key,
    cert,
    config,
    owner,
    reader,
    legacy,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test(
  "two real MCP clients through valid TLS in a Wake Job Object: CRUD, auth, revocation and supervised stops",
  { timeout: 90000, skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    let allowed = true;
    const manager = new BackgroundJobs(f.data, () => allowed);
    const clients = [];
    t.after(async () => {
      for (const c of clients) await c.close().catch(() => {});
      await manager.close();
      f.cleanup();
    });
    const prepared = prepareScopedJob({ workspace: f.workspace, config: f.config });
    assert.equal(prepared.script, "jobs/serve-scoped-workspace.mjs");
    assert.throws(() => prepareScopedJob({ workspace: f.workspace, config: f.config }), /EEXIST/);
    async function start(key) {
      const job = manager.store.submit("Scoped fixture", prepared.script, [], key);
      await manager.tick();
      const ready = path.join(jobOutputDir(f.data, job.id), "scoped-ready.json");
      await until(
        () =>
          fs.existsSync(ready) ||
          ["failed", "interrupted"].includes(manager.store.get(job.id).status),
      );
      assert.ok(fs.existsSync(ready), JSON.stringify(manager.store.get(job.id)));
      return { ...JSON.parse(fs.readFileSync(ready)), id: job.id };
    }
    const service = await start("first");
    const endpoint = `https://127.0.0.1:${service.port}/v1/scoped-workspace`;
    const cliCredential = path.join(f.base, "private", "cli-recipient.json");
    execFileSync(
      process.execPath,
      [
        path.resolve("services/shared-workspace/cli.mjs"),
        "scope-grant",
        "--state",
        f.state,
        "--root",
        f.root,
        "--data-root",
        f.data,
        "--name",
        "writing",
        "--participant",
        "cli-reader",
        "--rights",
        "list,search,read,propose",
        "--credential",
        cliCredential,
        "--endpoint",
        endpoint,
        "--ca",
        f.cert,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    f.reader = JSON.parse(fs.readFileSync(cliCredential, "utf8"));
    const credential = (c) => ({ ...c, endpoint, ca: fs.readFileSync(f.cert) });
    async function connect(c, index) {
      const file = path.join(f.base, "private", `client-${index}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...c, endpoint, caFile: f.cert }));
      const fragment = path.join(f.base, "private", `client-${index}.toml`);
      await setupWorkspace({ role: "scoped", credential: file, output: fragment });
      assert.match(fs.readFileSync(fragment, "utf8"), /mcp-scoped.mjs/);
      assert.ok(!fs.readFileSync(fragment, "utf8").includes(c.token));
      const client = new Client({ name: `scoped-${index}`, version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("services/shared-workspace/mcp-scoped.mjs"), file],
        stderr: "pipe",
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    const editor = await connect(f.owner, 1),
      reader = await connect(f.reader, 2);
    const names = ["create", "delete", "list", "propose", "read", "search", "write"]
      .map((n) => `workspace_${n}`)
      .sort();
    for (const client of [editor, reader])
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), names);
    assert.equal(
      (
        await reader
          .callTool({ name: "workspace_grant", arguments: {} })
          .catch(() => ({ isError: true }))
      ).isError,
      true,
    );
    const tool = async (c, op, args = {}) =>
      JSON.parse((await c.callTool({ name: `workspace_${op}`, arguments: args })).content[0].text);
    assert.equal((await tool(editor, "list")).entries[0].name, "story.md");
    assert.equal(
      (await tool(editor, "search", { query: "discovery", mode: "content" })).results[0].line,
      1,
    );
    const before = await tool(reader, "read", { path: "story.md" });
    assert.equal(
      (
        await tool(reader, "write", {
          path: "story.md",
          expectedHash: before.hash,
          text: "no",
          idempotencyKey: "denied",
        })
      ).error,
      "forbidden",
    );
    const write = await tool(editor, "write", {
      path: "story.md",
      expectedHash: before.hash,
      text: "A new draft.\n",
      idempotencyKey: "write",
    });
    assert.equal(write.status, "applied");
    assert.equal((await tool(reader, "read", { path: "story.md" })).hash, hash("A new draft.\n"));
    assert.equal(
      (
        await tool(editor, "write", {
          path: "story.md",
          expectedHash: before.hash,
          text: "stale",
          idempotencyKey: "stale",
        })
      ).error,
      "hash_conflict",
    );
    const create = await tool(editor, "create", {
      path: "new.txt",
      text: "Created",
      idempotencyKey: "create",
    });
    assert.equal(fs.readFileSync(path.join(f.root, "new.txt"), "utf8"), "Created");
    const del = await tool(editor, "delete", {
      path: "new.txt",
      expectedHash: hash("Created"),
      idempotencyKey: "delete",
    });
    assert.ok(!fs.existsSync(path.join(f.root, "new.txt")));
    revoke(f.state, f.owner.capability);
    assert.equal((await tool(editor, "read", { path: "story.md" })).error, "unauthorized");
    localRestoreOperation(f.state, del.id, null);
    assert.equal(fs.readFileSync(path.join(f.root, "new.txt"), "utf8"), "Created");
    localRestoreOperation(f.state, create.id, hash("Created"));
    localRestoreOperation(f.state, write.id, hash("A new draft.\n"));
    assert.equal(fs.readFileSync(path.join(f.root, "story.md"), "utf8"), before.text);
    const proposal = await tool(reader, "propose", {
      path: "story.md",
      expectedHash: before.hash,
      text: "Review me",
      idempotencyKey: "proposal",
    });
    assert.equal(proposal.status, "pending");
    for (const c of [
      { ...f.reader, participant: "editor" },
      f.legacy,
      { ...f.reader, token: "0".repeat(64) },
    ])
      await assert.rejects(
        callScopedWorkspace(credential(c), { op: "read", path: "story.md" }),
        /unauthorized|forbidden/,
      );
    await assert.rejects(
      callScopedWorkspace({ ...credential(f.reader), ca: fs.readFileSync(f.key) }, { op: "list" }),
    );
    // Revocation AFTER authentication but BEFORE the body completes must prevent mutation.
    const body = JSON.stringify({
      op: "propose",
      path: "story.md",
      expectedHash: before.hash,
      text: "revoked upload",
      idempotencyKey: "upload",
    });
    const upload = https.request(endpoint, {
      method: "POST",
      ca: fs.readFileSync(f.cert),
      agent: false,
      headers: {
        authorization: `Bearer ${f.reader.token}`,
        "x-workspace-capability": f.reader.capability,
        "x-workspace-participant": f.reader.participant,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    });
    upload.on("error", () => {});
    upload.write(body.slice(0, 5));
    await new Promise((r) => setTimeout(r, 80));
    revoke(f.state, f.reader.capability);
    const response = once(upload, "response");
    upload.end(body.slice(5));
    const [res] = await response;
    let text = "";
    for await (const c of res) text += c;
    assert.equal(JSON.parse(text).error, "unauthorized");
    async function gone(s) {
      await until(() => !manager.running.has(s.id));
      assert.throws(() => process.kill(s.pid, 0));
      assert.equal(await listening(s.port), false);
      await manager.tick();
      assert.equal(await listening(s.port), false);
    }
    // Existing daemon policy predicate is the Pause path; all descendants must die.
    allowed = false;
    await manager.tick();
    assert.equal(manager.store.get(service.id).status, "interrupted");
    allowed = true;
    await gone(service);
    const force = await start("force");
    const result = terminateBackgroundJobs(f.data);
    assert.ok(result.every((r) => r.confirmed));
    await gone(force);
    const cancel = await start("cancel");
    manager.store.cancel(cancel.id);
    await manager.tick();
    await gone(cancel);
    // A cooperating job can finish normally after its signal handler closes the server.
    const finishScript = "jobs/finish-scoped.mjs";
    fs.writeFileSync(
      path.join(f.workspace, finishScript),
      `import {runScopedWorkspaceJob} from ${JSON.stringify(new URL("./scoped-job.mjs", import.meta.url).href)};\n` +
        `setTimeout(()=>process.emit('SIGTERM'),500); await runScopedWorkspaceJob(${JSON.stringify(f.config)});`,
    );
    const finish = manager.store.submit("Finish fixture", finishScript, [], "finish");
    await manager.tick();
    const finishReady = path.join(jobOutputDir(f.data, finish.id), "scoped-ready.json");
    await until(() => manager.store.get(finish.id).status === "succeeded");
    const finishedInfo = { ...JSON.parse(fs.readFileSync(finishReady)), id: finish.id };
    await gone(finishedInfo);
    const close = await start("daemon-close");
    await manager.close();
    assert.throws(() => process.kill(close.pid, 0));
    assert.equal(await listening(close.port), false);
    // New manager reconciles terminal jobs; no implicit replay after daemon restart.
    const resumed = new BackgroundJobs(f.data, () => true);
    try {
      resumed.start();
      await resumed.tick();
      assert.equal(resumed.running.size, 0);
    } finally {
      await resumed.close();
    }
    for (const c of [f.owner, f.reader]) {
      for (const file of [service, force, cancel, close].flatMap((s) =>
        ["stdout.log", "stderr.log"].map((n) => path.join(jobOutputDir(f.data, s.id), n)),
      ))
        assert.ok(!fs.readFileSync(file, "utf8").includes(c.token));
    }
    console.log(
      JSON.stringify({
        proof: "scoped-MCP-TLS-JobObject",
        clients: 2,
        tools: names.length,
        crud: true,
        staleHashDenied: true,
        restoredAfterRevocation: true,
        revokedUploadDenied: true,
        stopPaths: [
          "pause-predicate",
          "emergency-force-off",
          "cancel",
          "normal-job-end",
          "daemon-close",
        ],
        serverPidsGone: true,
        listenersClosed: true,
        noAutomaticReplay: true,
      }),
    );
  },
);

test(
  "abort closes TLS listener and incomplete connections; signal exits a real server job process",
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t),
      controller = new AbortController();
    t.after(() => f.cleanup());
    const unsafe = path.join(f.root, "server.json");
    fs.copyFileSync(f.config, unsafe);
    assert.throws(() => readScopedJobConfig(unsafe), /private_file_inside_scope/);
    fs.unlinkSync(unsafe);
    const savedJob = process.env.MIND_WAKE_JOB_ID;
    delete process.env.MIND_WAKE_JOB_ID;
    try {
      await assert.rejects(runScopedWorkspaceJob(f.config), /supervised_wake_job_required/);
    } finally {
      if (savedJob !== undefined) process.env.MIND_WAKE_JOB_ID = savedJob;
    }
    const server = createScopedWorkspaceServer({
      stateFile: f.state,
      key: fs.readFileSync(f.key),
      cert: fs.readFileSync(f.cert),
      signal: controller.signal,
    });
    t.after(() => controller.abort());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const legacy = createWorkspaceServer({
      stateFile: f.state,
      key: fs.readFileSync(f.key),
      cert: fs.readFileSync(f.cert),
    });
    legacy.listen(0, "127.0.0.1");
    await once(legacy, "listening");
    try {
      const endpoint = `https://127.0.0.1:${legacy.address().port}/v1/workspace`;
      await assert.rejects(
        callWorkspace(
          { ...f.owner, endpoint, ca: fs.readFileSync(f.cert) },
          { op: "read", path: "story.md" },
        ),
        /forbidden/,
      );
      assert.equal(
        (
          await callWorkspace(
            { ...f.legacy, endpoint, ca: fs.readFileSync(f.cert) },
            { op: "read", path: "story.md" },
          )
        ).text,
        "A small discovery.\n",
      );
    } finally {
      legacy.closeAllConnections();
      await new Promise((r) => legacy.close(r));
    }
    const socket = net.connect({ host: "127.0.0.1", port });
    await once(socket, "connect");
    const socketClosed = once(socket, "close"),
      serverClosed = once(server, "close");
    controller.abort();
    await Promise.all([socketClosed, serverClosed]);
    assert.equal(await listening(port), false);
    assert.throws(
      () => createScopedWorkspaceServer({ stateFile: f.state, signal: controller.signal }),
      /supervision_required/,
    );
    const out = path.join(f.base, "job-out");
    fs.mkdirSync(out);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runScopedWorkspaceJob} from ${JSON.stringify(new URL("./scoped-job.mjs", import.meta.url).href)}; await runScopedWorkspaceJob(${JSON.stringify(f.config)});`,
      ],
      {
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          MIND_WAKE_JOB_ID: "job_00000000-0000-0000-0000-000000000001",
          MIND_WAKE_JOB_OUTPUT: out,
        },
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const ready = path.join(out, "scoped-ready.json");
    await until(() => fs.existsSync(ready));
    const info = JSON.parse(fs.readFileSync(ready));
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.equal(await listening(info.port), false);
    assert.throws(() => process.kill(info.pid, 0));
  },
);
