import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { grant, revoke, callWorkspace, createWorkspaceServer, hash, LIMITS } from "./workspace.mjs";

test("real TLS, two clients and two selected temporary folders; deny boundary failures", async (t) => {
  fs.mkdirSync(".local", { recursive: true });
  const base = fs.mkdtempSync(path.resolve(".local/workspace-transport-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "AppData", "Local", "chosen-installation");
  const workspace = path.join(dataRoot, "workspace");
  const selection = { dataRoots: [dataRoot] };
  const one = path.join(workspace, "one"),
    two = path.join(workspace, "two"),
    stateFile = path.join(base, "private", "state.json");
  fs.mkdirSync(one, { recursive: true });
  fs.mkdirSync(two, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "config.json"), '{"private":"synthetic"}');
  fs.writeFileSync(path.join(dataRoot, "auth.json"), '{"key":"synthetic"}');
  fs.writeFileSync(path.join(dataRoot, "control.sqlite"), "SYNTHETIC ONLY");
  const protectedNames = [
    "runtime",
    "runtimes",
    "installation",
    "auth",
    "profiles",
    "secrets",
    "credentials",
    "codex-home",
    "claude-home",
    ".codex",
    ".ssh",
    ".hidden",
  ];
  for (const name of protectedNames) {
    for (const parent of [dataRoot, one]) {
      const folder = path.join(parent, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "config.json"), '{"key":"synthetic"}');
      assert.throws(
        () => grant(stateFile, folder, "refused", false, selection),
        /invalid_selection/,
      );
    }
  }
  for (const folder of [
    base,
    path.join(base, "AppData"),
    path.join(base, "AppData", "Local"),
    path.join(base, "AppData", "Roaming"),
    path.join(base, "AppData", "LocalLow"),
    dataRoot,
  ]) {
    fs.mkdirSync(folder, { recursive: true });
    assert.throws(() => grant(stateFile, folder, "refused", false, selection), /invalid_selection/);
  }
  // A workspace-shaped filename is not permission: custom data root must be local metadata.
  assert.throws(() => grant(stateFile, one, "undeclared"), /invalid_selection/);
  const workspaceCapability = grant(stateFile, workspace, "synthetic-workspace", false, selection);
  revoke(stateFile, workspaceCapability.capability);
  fs.writeFileSync(path.join(one, "code.ts"), "export const answer = 1;\n");
  fs.writeFileSync(path.join(two, "code.ts"), "second selected folder\n");
  fs.writeFileSync(path.join(base, "outside.txt"), "OUTSIDE");
  fs.writeFileSync(path.join(one, ".env"), "PRIVATE");
  fs.writeFileSync(path.join(one, "secret.json"), "PRIVATE");
  fs.writeFileSync(path.join(one, "huge.txt"), Buffer.alloc(LIMITS.file + 1));
  fs.writeFileSync(path.join(one, "binary.txt"), Buffer.from([0xff, 0]));
  fs.linkSync(path.join(base, "outside.txt"), path.join(one, "hard.txt"));
  // Junctions do not require Windows Developer Mode/admin privileges.
  fs.symlinkSync(two, path.join(one, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => grant(stateFile, path.join(one, "escape"), "linked-root", false, selection),
    /unsafe_path/,
  );
  const cert = path.join(base, "cert.pem"),
    key = path.join(base, "key.pem");
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
  const server = createWorkspaceServer({
    stateFile,
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `https://127.0.0.1:${server.address().port}/v1/workspace`;
  const ca = fs.readFileSync(cert);
  const a = { ...grant(stateFile, one, "marco", true, selection), ca, endpoint };
  const b = { ...grant(stateFile, two, "reader", false, selection), ca, endpoint };
  const call = (client, body) => callWorkspace(client, body);
  const deny = (client, body, code) =>
    assert.rejects(call(client, body), (error) => error.message === code);

  const listed = await call(a, { op: "list" });
  assert.deepEqual(
    listed.entries.map((e) => e.name),
    ["code.ts"],
  );
  assert.equal(listed.entries[0].hash, hash("export const answer = 1;\n"));
  for (const name of protectedNames) {
    await deny(a, { op: "read", path: `${name}/config.json` }, "unsafe_path");
  }
  for (const outside of ["../../config.json", "../../auth.json", "../../control.sqlite"]) {
    await deny(a, { op: "read", path: outside }, "unsafe_path");
  }
  const first = await call(a, { op: "read", path: "code.ts" });
  assert.equal((await call(b, { op: "read", path: "code.ts" })).text, "second selected folder\n");
  // A REAL local file change is seen by the next remote HTTPS request, with a new hash.
  fs.writeFileSync(path.join(one, "code.ts"), "export const answer = 2;\n");
  const second = await call(a, { op: "read", path: "code.ts" });
  assert.notEqual(first.hash, second.hash);
  assert.match(second.text, /answer = 2/);
  await deny(
    a,
    {
      op: "propose",
      path: "code.ts",
      expectedHash: first.hash,
      text: "stale",
      idempotencyKey: "stale-test",
    },
    "hash_conflict",
  );
  const proposal = await call(a, {
    op: "propose",
    idempotencyKey: "valid-test",
    path: "code.ts",
    expectedHash: second.hash,
    text: "export const answer = 3;\n",
  });
  assert.equal(proposal.applied, false);
  assert.equal(proposal.proposedHash, hash(proposal.text));
  assert.equal(fs.readFileSync(path.join(one, "code.ts"), "utf8"), second.text);
  await deny(
    b,
    {
      op: "propose",
      path: "code.ts",
      expectedHash: hash("second selected folder\n"),
      text: "no",
      idempotencyKey: "readonly-test",
    },
    "forbidden",
  );
  for (const op of ["apply", "exec", "delete", "grant"])
    await deny(a, { op, path: "code.ts" }, "forbidden");
  for (const unsafe of [
    "../outside.txt",
    "/outside.txt",
    "C:/outside.txt",
    "escape/code.ts",
    ".env",
    "secret.json",
    "code.ts:stream",
    "x\\..\\code.ts",
  ]) {
    await deny(a, { op: "read", path: unsafe }, "unsafe_path");
  }
  await deny(a, { op: "read", path: "hard.txt" }, "unsupported_file");
  await deny(a, { op: "read", path: "binary.txt" }, "unsupported_file");
  await deny(a, { op: "read", path: "huge.txt" }, "file_limit");
  await deny({ ...a, token: "0".repeat(64) }, { op: "list" }, "unauthorized");
  await deny({ ...a, participant: "reader" }, { op: "list" }, "unauthorized");
  await deny({ ...a, capability: b.capability }, { op: "list" }, "unauthorized");
  await assert.rejects(call({ ...a, ca: undefined }, { op: "list" }));
  await assert.rejects(
    call({ ...a, endpoint: endpoint.replace("https:", "http:") }, { op: "list" }),
    /invalid_endpoint/,
  );
  // Bypass client-side size guard to prove server transport rejects an oversized upload.
  const raw = (data, finish = true) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        endpoint,
        {
          method: "POST",
          ca,
          agent: false,
          headers: {
            authorization: `Bearer ${a.token}`,
            "x-workspace-participant": a.participant,
            "x-workspace-capability": a.capability,
            "content-type": "application/json",
          },
        },
        (res) => {
          let value = "";
          res.on("data", (c) => (value += c));
          res.on("end", () => resolve({ status: res.statusCode, value }));
        },
      );
      req.on("error", reject);
      req.write(data);
      if (finish) req.end();
    });
  assert.equal((await raw("x".repeat(LIMITS.body + 1))).status, 413);
  const start = Date.now();
  await assert.rejects(raw("{", false));
  const incompleteBodyDeadlineMs = Date.now() - start;
  assert.ok(incompleteBodyDeadlineMs >= 4000 && incompleteBodyDeadlineMs < 9000);
  // Revocation is also enforced on a request authenticated before its upload finished.
  const arrived = once(server, "request");
  let pendingRequest;
  const pendingResult = new Promise((resolve, reject) => {
    pendingRequest = https.request(
      endpoint,
      {
        method: "POST",
        ca,
        agent: false,
        headers: {
          authorization: `Bearer ${a.token}`,
          "x-workspace-participant": a.participant,
          "x-workspace-capability": a.capability,
          "content-type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    pendingRequest.on("error", reject);
    pendingRequest.write("{");
  });
  await arrived;
  revoke(stateFile, a.capability);
  pendingRequest.end('"op":"list"}');
  assert.equal(await pendingResult, 401);
  await deny(a, { op: "read", path: "code.ts" }, "unauthorized");
  assert.equal((await call(b, { op: "read", path: "code.ts" })).text, "second selected folder\n");
  // Exercise the actual operator/client CLI with a separately spawned service.
  const cli = path.resolve("services/shared-workspace/cli.mjs");
  const serverProcess = spawn(
    process.execPath,
    [cli, "serve", "--state", stateFile, "--key", key, "--cert", cert, "--port", "0"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => serverProcess.kill());
  let serverLogs = "";
  serverProcess.stderr.on("data", (chunk) => (serverLogs += chunk));
  const listening = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI start deadline")), 5000);
    serverProcess.once("error", reject);
    serverProcess.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      serverLogs += chunk;
      resolve(JSON.parse(chunk));
    });
  });
  const credential = path.join(base, "cli-credential.json");
  const unsafeCredential = path.join(two, "capability.json");
  const refusedGrant = spawnSync(
    process.execPath,
    [
      cli,
      "grant",
      "--state",
      stateFile,
      "--root",
      two,
      "--data-root",
      dataRoot,
      "--participant",
      "unsafe",
      "--credential",
      unsafeCredential,
      "--endpoint",
      endpoint,
      "--ca",
      cert,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refusedGrant.status, 1);
  assert.equal(fs.existsSync(unsafeCredential), false);
  const grantLog = execFileSync(
    process.execPath,
    [
      cli,
      "grant",
      "--state",
      stateFile,
      "--root",
      two,
      "--data-root",
      dataRoot,
      "--participant",
      "cli-reader",
      "--credential",
      credential,
      "--endpoint",
      `https://127.0.0.1:${listening.port}/v1/workspace`,
      "--ca",
      cert,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const requestFile = path.join(base, "request.json"),
    outputFile = path.join(base, "result.json");
  fs.writeFileSync(requestFile, JSON.stringify({ op: "read", path: "code.ts" }));
  const clientLog = execFileSync(
    process.execPath,
    [cli, "call", "--credential", credential, "--request", requestFile, "--output", outputFile],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(fs.readFileSync(outputFile, "utf8")).text, "second selected folder\n");
  const cliCredential = JSON.parse(fs.readFileSync(credential, "utf8"));
  const logs = serverLogs + grantLog + clientLog;
  assert.ok(
    !logs.includes(cliCredential.token) &&
      !logs.includes("second selected folder") &&
      !logs.includes(two),
  );
  const exited = once(serverProcess, "exit");
  serverProcess.kill();
  await exited;
  assert.throws(() => grant(stateFile, base, "bad-root"), /invalid_selection/);
  console.log(
    JSON.stringify({
      proof: "TLS-two-clients-two-folders",
      changedFileObserved: true,
      firstHash: first.hash,
      nextHash: second.hash,
      proposalApplied: false,
      revokedClientDenied: true,
      unaffectedClientWorks: true,
      junctionDenied: true,
      incompleteBodyDeadlineMs,
      cliProcessVerified: true,
      selectedAppDataWorkspaceVerified: true,
    }),
  );
});
