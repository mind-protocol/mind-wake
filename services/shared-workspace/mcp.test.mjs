import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { grant, revoke, hash, loadState, callWorkspace } from "./workspace.mjs";
import { setupWorkspace } from "../../scripts/setup-shared-workspace.mjs";

test(
  "MCP remote/local roles, durable proposal restart, apply and conditional restore on real files",
  { timeout: 45000 },
  async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wake-files-mcp-"));
    const clients = [];
    const processes = [];
    let logs = "";
    t.after(async () => {
      for (const client of clients) await client.close().catch(() => {});
      for (const child of processes)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      fs.rmSync(base, { recursive: true, force: true });
    });
    const dataRoot = path.join(base, "AppData", "Local", "synthetic-install");
    const one = path.join(dataRoot, "workspace", "one"),
      two = path.join(dataRoot, "workspace", "two");
    const privateState = path.join(base, "private");
    fs.mkdirSync(privateState);
    fs.mkdirSync(one, { recursive: true });
    fs.mkdirSync(two, { recursive: true });
    const original = "export const version = 1;\n",
      replacement = "export const version = 2;\n";
    fs.writeFileSync(path.join(one, "code.ts"), original);
    fs.writeFileSync(path.join(two, "code.ts"), "SECOND\n");
    const state = path.join(privateState, "grants.json");
    const cert = path.join(privateState, "cert.pem"),
      key = path.join(privateState, "key.pem");
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
    const credentials = [
      grant(state, one, "synthetic-author", true, { dataRoots: [dataRoot] }),
      grant(state, two, "synthetic-reader", false, { dataRoots: [dataRoot] }),
    ];
    const cli = path.resolve("services/shared-workspace/cli.mjs");
    let port = 0;
    async function startTls() {
      const child = spawn(
        process.execPath,
        [cli, "serve", "--state", state, "--key", key, "--cert", cert, "--port", String(port)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      processes.push(child);
      child.stderr.on("data", (chunk) => (logs += chunk));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server_start_deadline")), 5000);
        child.once("error", reject);
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          logs += chunk;
          port = JSON.parse(chunk).port;
          resolve();
        });
      });
      return child;
    }
    let tls = await startTls();
    const endpoint = `https://127.0.0.1:${port}/v1/workspace`;
    const credentialFiles = credentials.map((c, i) => {
      const file = path.join(privateState, `client-${i}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...c, endpoint, caFile: cert }), { mode: 0o600 });
      return file;
    });
    async function connect(role, file) {
      const client = new Client({ name: `synthetic-${role}`, version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(`services/shared-workspace/mcp-${role}.mjs`), file],
        stderr: "pipe",
      });
      await client.connect(transport);
      if (transport.stderr) transport.stderr.on("data", (chunk) => (logs += chunk));
      clients.push(client);
      return client;
    }
    async function tool(client, name, args = {}) {
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse(response.content[0].text);
    }
    let author = await connect("remote", credentialFiles[0]);
    const reader = await connect("remote", credentialFiles[1]);
    const remoteTools = ["workspace_list", "workspace_propose", "workspace_read"];
    assert.deepEqual((await author.listTools()).tools.map((t) => t.name).sort(), remoteTools);
    assert.deepEqual((await reader.listTools()).tools.map((t) => t.name).sort(), remoteTools);
    assert.equal((await tool(reader, "workspace_read", { path: "code.ts" })).text, "SECOND\n");
    const initial = await tool(author, "workspace_read", { path: "code.ts" });
    const input = {
      path: "code.ts",
      expectedHash: initial.hash,
      text: replacement,
      idempotencyKey: "episode-001",
    };
    const proposal = await tool(author, "workspace_propose", input);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.applied, false);
    assert.equal((await tool(author, "workspace_propose", input)).id, proposal.id);
    assert.equal(
      (await tool(author, "workspace_propose", { ...input, text: "DIFFERENT" })).error,
      "idempotency_conflict",
    );
    assert.equal(
      (await tool(reader, "workspace_propose", { ...input, expectedHash: hash("SECOND\n") })).error,
      "forbidden",
    );
    const unknown = await author
      .callTool({ name: "workspace_apply_proposal", arguments: { id: proposal.id } })
      .catch(() => ({ isError: true }));
    assert.equal(unknown.isError, true);
    await assert.rejects(
      callWorkspace(
        { ...credentials[0], endpoint, ca: fs.readFileSync(cert) },
        { op: "apply", id: proposal.id },
      ),
      /forbidden/,
    );
    assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), original);

    // Stop the actual TLS and MCP processes. A new local process must find the persisted queue.
    await author.close();
    const stopped = once(tls, "exit");
    tls.kill();
    await stopped;
    assert.equal(loadState(state).proposals[0].id, proposal.id);
    tls = await startTls();
    author = await connect("remote", credentialFiles[0]);
    const local = await connect("local", state),
      local2 = await connect("local", state);
    assert.deepEqual((await local.listTools()).tools.map((t) => t.name).sort(), [
      "workspace_apply_proposal",
      "workspace_get_proposal",
      "workspace_pending_proposals",
      "workspace_reject_proposal",
      "workspace_restore_proposal",
    ]);
    assert.equal((await tool(local, "workspace_pending_proposals")).proposals[0].id, proposal.id);
    assert.equal(
      (await tool(local, "workspace_get_proposal", { id: proposal.id })).text,
      replacement,
    );

    // A cooperating operator holds the shared lock: application fails closed, changes nothing.
    const fd = fs.openSync(`${state}.lock`, "wx");
    try {
      assert.equal(
        (await tool(local, "workspace_apply_proposal", { id: proposal.id })).error,
        "busy",
      );
      assert.equal((await tool(author, "workspace_propose", input)).error, "busy");
      assert.throws(
        () => revoke(state, credentials[0].capability),
        (error) => error.code === "EEXIST",
      );
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(`${state}.lock`);
    }
    const applications = await Promise.all([
      tool(local, "workspace_apply_proposal", { id: proposal.id }),
      tool(local2, "workspace_apply_proposal", { id: proposal.id }),
    ]);
    for (const value of applications)
      assert.ok(value.status === "applied" || value.error === "busy");
    assert.equal(
      (await tool(local, "workspace_apply_proposal", { id: proposal.id })).status,
      "applied",
    );
    const backup = path.join(`${state}.private`, `${proposal.id}.before`);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
    assert.equal((await tool(author, "workspace_read", { path: "code.ts" })).text, replacement);
    assert.equal((await tool(author, "workspace_propose", input)).id, proposal.id);
    assert.equal(loadState(state).proposals.length, 1);
    assert.equal(
      (
        await tool(local, "workspace_restore_proposal", {
          id: proposal.id,
          expectedHash: hash(original),
        })
      ).error,
      "hash_conflict",
    );
    fs.writeFileSync(path.join(one, "code.ts"), "EDITOR CHANGE\n");
    assert.equal(
      (
        await tool(local, "workspace_restore_proposal", {
          id: proposal.id,
          expectedHash: hash(replacement),
        })
      ).error,
      "hash_conflict",
    );
    assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), "EDITOR CHANGE\n");
    fs.writeFileSync(path.join(one, "code.ts"), replacement);
    fs.writeFileSync(backup, "CORRUPTED BACKUP");
    assert.equal(
      (
        await tool(local, "workspace_restore_proposal", {
          id: proposal.id,
          expectedHash: hash(replacement),
        })
      ).error,
      "backup_mismatch",
    );
    assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), replacement);
    fs.writeFileSync(backup, original);
    assert.equal(
      (
        await tool(local, "workspace_restore_proposal", {
          id: proposal.id,
          expectedHash: hash(replacement),
        })
      ).status,
      "restored",
    );
    assert.equal(
      (
        await tool(local, "workspace_restore_proposal", {
          id: proposal.id,
          expectedHash: hash(replacement),
        })
      ).status,
      "restored",
    );
    assert.equal((await tool(author, "workspace_read", { path: "code.ts" })).text, original);
    assert.equal(
      (
        await tool(author, "workspace_propose", {
          ...input,
          expectedHash: hash(replacement),
          idempotencyKey: "stale-submit",
        })
      ).error,
      "hash_conflict",
    );
    const conflicted = await tool(author, "workspace_propose", {
      ...input,
      idempotencyKey: "editor-conflict",
    });
    fs.writeFileSync(path.join(one, "code.ts"), "EDITOR NEW WORK\n");
    assert.equal(
      (await tool(local, "workspace_apply_proposal", { id: conflicted.id })).status,
      "conflict",
    );
    assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), "EDITOR NEW WORK\n");
    const reject = await tool(author, "workspace_propose", {
      ...input,
      expectedHash: hash("EDITOR NEW WORK\n"),
      idempotencyKey: "reject-me",
    });
    assert.equal(
      (await tool(local, "workspace_reject_proposal", { id: reject.id })).status,
      "rejected",
    );
    assert.equal(
      (await tool(local, "workspace_apply_proposal", { id: reject.id })).status,
      "rejected",
    );
    const revoked = await tool(author, "workspace_propose", {
      ...input,
      expectedHash: hash("EDITOR NEW WORK\n"),
      idempotencyKey: "revoke-me",
    });
    revoke(state, credentials[0].capability);
    assert.equal(
      (await tool(local, "workspace_apply_proposal", { id: revoked.id })).status,
      "revoked",
    );
    assert.equal((await tool(author, "workspace_read", { path: "code.ts" })).error, "unauthorized");
    assert.equal((await tool(reader, "workspace_read", { path: "code.ts" })).text, "SECOND\n");
    assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), "EDITOR NEW WORK\n");
    assert.throws(() => grant(state, `${state}.private`, "backup-reader"), /invalid_selection/);

    // Prepare fragments beside private test state; never edits existing MCP messages/config.
    const existing = path.join(privateState, "existing-config.toml");
    const existingText = '[mcp_servers.mind_shared_messages]\ncommand = "existing"\n';
    fs.writeFileSync(existing, existingText);
    for (const role of ["remote", "local"]) {
      const output = path.join(privateState, `${role}.toml`);
      if (role === "remote") {
        logs += execFileSync(
          process.execPath,
          [
            path.resolve("scripts/setup-shared-workspace.mjs"),
            "--role",
            role,
            "--credential",
            credentialFiles[0],
            "--output",
            output,
          ],
          { encoding: "utf8", windowsHide: true },
        );
      } else await setupWorkspace({ role, state, credential: credentialFiles[0], output });
      const fragment = fs.readFileSync(output, "utf8");
      for (const c of credentials) assert.ok(!fragment.includes(c.token));
      assert.ok(fragment.includes(`mcp_servers.mind_workspace_${role}`));
      const configured = new Client({ name: `from-helper-${role}`, version: "1" });
      const configuredTransport = new StdioClientTransport({
        command: JSON.parse(fragment.match(/^command = (.+)$/m)[1]),
        args: JSON.parse(fragment.match(/^args = (.+)$/m)[1]),
        stderr: "pipe",
      });
      await configured.connect(configuredTransport);
      clients.push(configured);
      if (configuredTransport.stderr)
        configuredTransport.stderr.on("data", (chunk) => (logs += chunk));
      assert.equal((await configured.listTools()).tools.length, role === "remote" ? 3 : 5);
      await assert.rejects(setupWorkspace({ role, state, credential: credentialFiles[0], output }));
    }
    assert.equal(fs.readFileSync(existing, "utf8"), existingText);
    for (const c of credentials) assert.ok(!logs.includes(c.token));
    assert.ok(
      !logs.includes(original) && !logs.includes(replacement) && !logs.includes("EDITOR NEW WORK"),
    );
    console.log(
      JSON.stringify({
        proof: "real-MCP-TLS-local-apply",
        twoRemoteClients: true,
        twoLocalProcesses: true,
        persistedAfterRestart: true,
        backupVerified: true,
        conditionalRestoreVerified: true,
        editorConflictPreserved: true,
        pendingRevocationDenied: true,
        helperAdditive: true,
      }),
    );
  },
);
