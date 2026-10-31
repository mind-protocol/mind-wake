import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerScopedWorkspaceTools } from "./scoped-mcp.mjs";
import { result } from "./mcp-result.mjs";
import {
  localGrantScope,
  createScopedWorkspaceSession,
  localRestoreOperation,
  localApply,
  localProposals,
  grant,
  revoke,
  hash,
  loadState,
  saveState,
  SEARCH_LIMITS,
  createWorkspaceServer,
} from "./workspace.mjs";

function fixture(t) {
  fs.mkdirSync(".local", { recursive: true });
  const base = fs.mkdtempSync(path.resolve(".local/scoped-files-"));
  const one = path.join(base, "one"),
    two = path.join(base, "two"),
    state = path.join(base, "private", "state.json");
  fs.mkdirSync(one);
  fs.mkdirSync(two);
  fs.mkdirSync(path.dirname(state));
  fs.writeFileSync(path.join(one, "story.md"), "An ordinary draft.\nA small discovery.\n");
  fs.writeFileSync(path.join(two, "other.md"), "OTHER_SCOPE_SENTINEL");
  const sessions = [];
  t.after(() => {
    for (const s of sessions) s.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });
  function make(rights, options = {}) {
    const { root = one, name = "writing", participant = `actor-${sessions.length}` } = options;
    const credential = localGrantScope(state, { name, root, participant, rights });
    const controller = new AbortController();
    const session = createScopedWorkspaceSession({
      stateFile: state,
      credential,
      signal: controller.signal,
    });
    sessions.push(session);
    return { ...session, credential, controller };
  }
  return { base, one, two, state, make };
}
const edit = (op, path, text, expectedHash, key) => ({
  op,
  path,
  ...(text === undefined ? {} : { text }),
  ...(expectedHash === undefined ? {} : { expectedHash }),
  idempotencyKey: key,
});

test("independent rights: read-only never mutates; list/search/create do not imply read or write", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.one, "story.md"));
  const reader = f.make(["read"]);
  const stateBefore = fs.readFileSync(f.state);
  assert.match(reader.call({ op: "read", path: "story.md" }).text, /ordinary/);
  for (const op of ["list", "search", "create", "write", "delete", "propose", "grant", "restore"])
    assert.throws(() => reader.call(edit(op, "story.md", "x", hash(before), "deny")), /forbidden/);
  assert.deepEqual(fs.readFileSync(path.join(f.one, "story.md")), before);
  assert.deepEqual(fs.readFileSync(f.state), stateBefore);
  const lister = f.make(["list"]);
  assert.equal(lister.call({ op: "list" }).entries[0].name, "story.md");
  assert.throws(() => lister.call({ op: "read", path: "story.md" }), /forbidden/);
  const creator = f.make(["create"]);
  creator.call(edit("create", "created.txt", "hello", undefined, "only-create"));
  assert.equal(fs.readFileSync(path.join(f.one, "created.txt"), "utf8"), "hello");
  assert.throws(
    () => creator.call(edit("write", "created.txt", "bad", hash("hello"), "deny-write")),
    /forbidden/,
  );
  assert.throws(() => creator.call({ op: "read", path: "created.txt" }), /forbidden/);
});

test("search stays in its scope, literal queries, bounded output, explicit truncation and secret exclusion", (t) => {
  const f = fixture(t),
    a = f.make(["search", "read", "list"]);
  const b = f.make(["search"], { root: f.two, name: "other" });
  assert.equal(a.call({ op: "search", query: "discovery", mode: "content" }).results[0].line, 2);
  assert.equal(
    a.call({ op: "search", query: "OTHER_SCOPE_SENTINEL", mode: "content" }).results.length,
    0,
  );
  assert.equal(
    b.call({ op: "search", query: "OTHER_SCOPE_SENTINEL", mode: "content" }).results.length,
    1,
  );
  assert.throws(() => a.call({ op: "search", path: "../two", query: "other" }), /unsafe_path/);
  assert.throws(() => a.call({ op: "search", scope: "other", query: "other" }), /forbidden/);
  assert.equal(a.call({ op: "search", query: ".*", mode: "content" }).results.length, 0);
  fs.writeFileSync(path.join(f.one, "notes.md"), "api_key=syntheticCredentialValue123456");
  fs.writeFileSync(path.join(f.one, "token-economy.md"), "Ordinary business document");
  fs.writeFileSync(path.join(f.one, ".env"), "secret");
  assert.match(a.call({ op: "read", path: "token-economy.md" }).text, /Ordinary/);
  assert.throws(() => a.call({ op: "read", path: "notes.md" }), /sensitive_content/);
  const found = a.call({ op: "search", query: "syntheticCredentialValue", mode: "content" });
  assert.deepEqual(found.results, []);
  assert.ok(!JSON.stringify(a.call({ op: "list" })).includes("notes.md"));
  const safe = JSON.stringify(found);
  assert.ok(!safe.includes("syntheticCredentialValue123456") && !safe.includes(f.base));
  const long = "a".repeat(1000) + "needle" + "b".repeat(1000);
  fs.writeFileSync(path.join(f.one, "long.md"), long);
  const snippet = a.call({ op: "search", query: "needle", mode: "content" }).results[0];
  assert.ok(snippet.snippet.length <= 160 && snippet.snippetTruncated);
  for (let i = 0; i < SEARCH_LIMITS.entries + 10; i++)
    fs.mkdirSync(path.join(f.one, `dir-${String(i).padStart(4, "0")}`));
  const bounded = a.call({ op: "search", query: "dir-", mode: "name" });
  assert.ok(bounded.truncated);
  assert.ok(
    bounded.results.length <= SEARCH_LIMITS.results && bounded.scanned <= SEARCH_LIMITS.entries,
  );
});

test("create/write/delete, stale hashes, idempotent replay across sessions and reversible snapshots", (t) => {
  const f = fixture(t),
    a = f.make(["read", "create", "write", "delete"]);
  const initial = a.call({ op: "read", path: "story.md" });
  const createRequest = edit("create", "fresh.md", "created", undefined, "create-001");
  const created = a.call(createRequest);
  assert.equal(created.status, "applied");
  assert.equal(fs.readFileSync(path.join(f.one, "fresh.md"), "utf8"), "created");
  assert.throws(
    () => a.call(edit("create", "fresh.md", "overwrite", undefined, "create-002")),
    /hash_conflict/,
  );
  assert.throws(() => a.call({ ...createRequest, text: "different" }), /idempotency_conflict/);
  const restarted = createScopedWorkspaceSession({
    stateFile: f.state,
    credential: a.credential,
    signal: new AbortController().signal,
  });
  t.after(() => restarted.stop());
  assert.equal(restarted.call(createRequest).id, created.id);
  assert.throws(
    () => a.call(edit("write", "story.md", "bad", hash("stale"), "stale")),
    /hash_conflict/,
  );
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), initial.text);
  const write = edit("write", "story.md", "Revised", initial.hash, "write-001");
  const written = a.call(write);
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), "Revised");
  assert.throws(
    () => a.call(edit("delete", "story.md", undefined, initial.hash, "stale-delete")),
    /hash_conflict/,
  );
  const deleted = a.call(edit("delete", "story.md", undefined, hash("Revised"), "delete-001"));
  assert.equal(fs.existsSync(path.join(f.one, "story.md")), false);
  assert.throws(() => localRestoreOperation(f.state, deleted.id, hash("Revised")), /hash_conflict/);
  revoke(f.state, a.credential.capability);
  assert.throws(() => restarted.call(createRequest), /unauthorized/);
  assert.equal(localRestoreOperation(f.state, deleted.id, null).status, "restored");
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), "Revised");
  assert.equal(localRestoreOperation(f.state, deleted.id, null).status, "restored");
  assert.equal(localRestoreOperation(f.state, written.id, hash("Revised")).status, "restored");
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), initial.text);
  assert.equal(localRestoreOperation(f.state, created.id, hash("created")).status, "restored");
  assert.equal(fs.existsSync(path.join(f.one, "fresh.md")), false);
  const privateFiles = fs.readdirSync(`${f.state}.private`);
  assert.equal(privateFiles.length, 4);
  assert.ok(
    privateFiles.some(
      (p) => fs.readFileSync(path.join(`${f.state}.private`, p), "utf8") === initial.text,
    ),
  );
});

test("replay never overwrites later editor work; restore detects conflict and damaged backups", (t) => {
  const f = fixture(t),
    a = f.make(["write"]);
  const initial = fs.readFileSync(path.join(f.one, "story.md"), "utf8");
  const request = edit("write", "story.md", "Applied", hash(initial), "one");
  const applied = a.call(request);
  fs.writeFileSync(path.join(f.one, "story.md"), "Editor work");
  assert.equal(a.call(request).id, applied.id);
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), "Editor work");
  assert.throws(() => localRestoreOperation(f.state, applied.id, hash("Applied")), /hash_conflict/);
  fs.writeFileSync(path.join(f.one, "story.md"), "Applied");
  fs.writeFileSync(path.join(`${f.state}.private`, `${applied.id}.before`), "corrupt");
  assert.throws(
    () => localRestoreOperation(f.state, applied.id, hash("Applied")),
    /backup_mismatch/,
  );
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), "Applied");
});

test("UTF-8 BOM and non-ASCII originals restore byte for byte after direct and reviewed writes", (t) => {
  const f = fixture(t),
    a = f.make(["read", "write", "delete", "propose"]);
  const original = Buffer.from("\uFEFFÉté — récit\r\n");
  fs.writeFileSync(path.join(f.one, "story.md"), original);
  const initial = a.call({ op: "read", path: "story.md" });
  assert.equal(initial.hash, hash(original));
  const written = a.call(edit("write", "story.md", "Nouvelle version", initial.hash, "bom-write"));
  localRestoreOperation(f.state, written.id, hash("Nouvelle version"));
  assert.deepEqual(fs.readFileSync(path.join(f.one, "story.md")), original);
  const deleted = a.call(edit("delete", "story.md", undefined, initial.hash, "bom-delete"));
  localRestoreOperation(f.state, deleted.id, null);
  assert.deepEqual(fs.readFileSync(path.join(f.one, "story.md")), original);
  const proposed = a.call(edit("propose", "story.md", "Relu", initial.hash, "bom-review"));
  localApply(f.state, proposed.id);
  localApply(f.state, proposed.id, hash("Relu"));
  assert.deepEqual(fs.readFileSync(path.join(f.one, "story.md")), original);
});

test("named credentials cannot use legacy HTTPS implicit rights; no listener or socket", async (t) => {
  const f = fixture(t),
    a = f.make(["read", "propose", "create", "write", "delete", "search"]);
  const legacy = grant(f.state, f.two, "legacy-http");
  const server = createWorkspaceServer({ stateFile: f.state });
  // Exercise the existing request boundary without connecting a transport.
  const handler = server.listeners("request")[0];
  async function request(credential, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = "POST";
    req.url = "/v1/workspace";
    req.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "x-workspace-capability": credential.capability,
      "x-workspace-participant": credential.participant,
    };
    let status, response;
    await handler(req, {
      writeHead(code) {
        status = code;
      },
      end(text) {
        response = JSON.parse(text);
      },
    });
    return { status, response };
  }
  for (const op of ["list", "read", "propose", "search", "create", "write", "delete"]) {
    const reply = await request(a.credential, edit(op, "story.md", "Forbidden", hash("stale"), op));
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.response, { error: "forbidden" });
  }
  assert.equal(
    (await request(legacy, { op: "read", path: "other.md" })).response.result.text,
    "OTHER_SCOPE_SENTINEL",
  );
  assert.equal(
    (
      await request(legacy, {
        op: "create",
        path: "new.md",
        text: "x",
        idempotencyKey: "legacy-deny",
      })
    ).response.error,
    "forbidden",
  );
  assert.match(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), /ordinary/);
  assert.equal(server.listening, false);
});

test("interrupted intents reconcile from actual disk, including absent create/delete", (t) => {
  const f = fixture(t),
    a = f.make(["create", "write", "delete"]);
  const create = edit("create", "new.md", "New", undefined, "create");
  const c = a.call(create);
  let state = loadState(f.state);
  state.operations[0].status = "prepared";
  saveState(f.state, state);
  assert.equal(a.call(create).status, "applied");
  fs.unlinkSync(path.join(f.one, "new.md"));
  state = loadState(f.state);
  state.operations[0].status = "prepared";
  saveState(f.state, state);
  assert.equal(a.call(create).status, "applied");
  assert.equal(fs.readFileSync(path.join(f.one, "new.md"), "utf8"), "New");
  const remove = edit("delete", "new.md", undefined, hash("New"), "delete");
  const d = a.call(remove);
  state = loadState(f.state);
  state.operations[1].status = "prepared";
  saveState(f.state, state);
  assert.equal(a.call(remove).status, "applied");
  localRestoreOperation(f.state, d.id, null);
  state = loadState(f.state);
  state.operations[1].status = "restoring";
  saveState(f.state, state);
  assert.equal(localRestoreOperation(f.state, d.id, null).status, "restored");
  assert.equal(localRestoreOperation(f.state, c.id, hash("New")).status, "restored");
});

test("paths, junctions, symlinks and hardlinks fail closed for reads and mutations", (t) => {
  const f = fixture(t),
    a = f.make(["read", "create", "write", "delete", "search"]);
  fs.linkSync(path.join(f.two, "other.md"), path.join(f.one, "hard.md"));
  fs.symlinkSync(
    f.two,
    path.join(f.one, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const names = [
    "../two/other.md",
    "/other.md",
    "C:/other.md",
    "C:\\other.md",
    "story.md:ads",
    "a/../story.md",
    "hard.md",
    "escape/other.md",
    "escape/fresh.md",
    "./story.md",
    "a//b.md",
    "NUL.md",
    "story.md.",
  ];
  for (const name of names) {
    for (const body of [
      { op: "read", path: name },
      edit("create", name, "overwrite", undefined, "path-create"),
      edit("write", name, "overwrite", hash("OTHER_SCOPE_SENTINEL"), "path-write"),
      edit("delete", name, undefined, hash("OTHER_SCOPE_SENTINEL"), "path-delete"),
    ])
      assert.throws(() => a.call(body), undefined, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(path.join(f.two, "other.md"), "utf8"), "OTHER_SCOPE_SENTINEL");
  assert.ok(
    !JSON.stringify(
      a.call({ op: "search", query: "OTHER_SCOPE_SENTINEL", mode: "content" }),
    ).includes("OTHER_SCOPE_SENTINEL"),
  );
  // A linked ancestor above the selected root is rejected too.
  assert.throws(
    () => f.make(["read"], { name: "linked", root: path.join(f.one, "escape") }),
    /unsafe_path/,
  );
});

test("local scope selection, recipient binding, revocation and no authority from received messages", (t) => {
  const f = fixture(t),
    a = f.make(["read"]);
  assert.throws(() => f.make(["read"], { root: f.one, name: "different" }), /scope_conflict/);
  assert.throws(() => f.make(["read"], { root: f.two, name: "writing" }), /scope_conflict/);
  assert.throws(() => f.make(["shell"]), /invalid_selection/);
  assert.throws(
    () => localGrantScope(f.state, { root: f.one, participant: "x", rights: ["read"] }),
    /invalid_selection/,
  );
  assert.throws(
    () =>
      localGrantScope(f.state, {
        name: "relative",
        root: "one",
        participant: "x",
        rights: ["read"],
      }),
    /invalid_selection/,
  );
  assert.throws(
    () =>
      localGrantScope(f.state, { name: "state", root: f.base, participant: "x", rights: ["read"] }),
    /invalid_selection/,
  );
  for (const injection of [{ root: f.two }, { rights: ["write"] }, { participant: "owner" }])
    assert.throws(() => a.call({ op: "read", path: "story.md", ...injection }), /invalid_request/);
  const forged = createScopedWorkspaceSession({
    stateFile: f.state,
    credential: { ...a.credential, participant: "owner" },
    signal: new AbortController().signal,
  });
  t.after(() => forged.stop());
  assert.throws(() => forged.call({ op: "read", path: "story.md" }), /unauthorized/);
  revoke(f.state, a.credential.capability);
  assert.throws(() => a.call({ op: "read", path: "story.md" }), /unauthorized/);
  const b = f.make(["read"], { root: f.two, name: "other" });
  assert.equal(b.call({ op: "read", path: "other.md" }).text, "OTHER_SCOPE_SENTINEL");
});

test("legacy grant compatibility: proposals reviewed locally, no silent search/create/write/delete upgrade", (t) => {
  const f = fixture(t);
  const credential = grant(f.state, f.one, "legacy", true);
  const a = createScopedWorkspaceSession({
    stateFile: f.state,
    credential,
    signal: new AbortController().signal,
  });
  t.after(() => a.stop());
  const before = a.call({ op: "read", path: "story.md" });
  assert.equal(a.call({ op: "list" }).entries.length, 1);
  for (const op of ["search", "create", "write", "delete"])
    assert.throws(() => a.call(edit(op, "story.md", "bad", before.hash, "denied")), /forbidden/);
  const proposal = a.call(edit("propose", "story.md", "Reviewed", before.hash, "review"));
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), before.text);
  assert.equal(localProposals(f.state, proposal.id).status, "pending");
  assert.equal(localApply(f.state, proposal.id).status, "applied");
  assert.equal(localApply(f.state, proposal.id, hash("Reviewed")).status, "restored");
  assert.deepEqual(loadState(f.state).grants[0].rights, ["read", "propose"]);
  const pending = a.call(
    edit("propose", "story.md", "Never applied", before.hash, "revoked-review"),
  );
  revoke(f.state, credential.capability);
  assert.equal(localProposals(f.state, pending.id).status, "revoked");
  assert.equal(fs.readFileSync(path.join(f.one, "story.md"), "utf8"), before.text);
});

// A real SDK client/server protocol exchange with a test-only memory transport.
function pair() {
  const a = {
    start: async () => {},
    close: async () => {
      a.onclose?.();
    },
    send: async (message) => {
      queueMicrotask(() => b.onmessage?.(structuredClone(message)));
    },
  };
  const b = {
    start: async () => {},
    close: async () => {
      b.onclose?.();
    },
    send: async (message) => {
      queueMicrotask(() => a.onmessage?.(structuredClone(message)));
    },
  };
  return [a, b];
}
test("SDK MCP discovery/calls, sanitized failures and supervised stop deny queued work without sockets", async (t) => {
  const f = fixture(t),
    a = f.make(["read", "search", "create", "delete"]);
  const server = new McpServer({ name: "synthetic-scoped", version: "1" });
  registerScopedWorkspaceTools(server, a);
  const client = new Client({ name: "synthetic-recipient", version: "1" });
  const [ct, st] = pair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(st);
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "workspace_create",
    "workspace_delete",
    "workspace_list",
    "workspace_propose",
    "workspace_read",
    "workspace_search",
    "workspace_write",
  ]);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    return { response, value: JSON.parse(response.content[0].text) };
  };
  assert.match((await call("workspace_read", { path: "story.md" })).value.text, /ordinary/);
  assert.equal(
    (await call("workspace_search", { query: "discovery", mode: "content" })).value.results.length,
    1,
  );
  assert.equal(
    (
      await call("workspace_create", {
        path: "mcp.md",
        text: "Made over MCP",
        idempotencyKey: "mcp-create",
      })
    ).value.status,
    "applied",
  );
  assert.equal(fs.readFileSync(path.join(f.one, "mcp.md"), "utf8"), "Made over MCP");
  assert.equal(
    (
      await call("workspace_write", {
        path: "mcp.md",
        text: "Denied",
        expectedHash: hash("Made over MCP"),
        idempotencyKey: "deny",
      })
    ).value.error,
    "forbidden",
  );
  const malformed = await call("workspace_read", { path: "../other.md" });
  assert.equal(malformed.response.isError, true);
  assert.deepEqual(malformed.value, { error: "unsafe_path" });
  const secretError = await result(() => {
    throw new Error(`untrusted body ${a.credential.token} ${f.one}`);
  });
  assert.deepEqual(JSON.parse(secretError.content[0].text), { error: "operation_failed" });
  const queued = call("workspace_delete", {
    path: "mcp.md",
    expectedHash: hash("Made over MCP"),
    idempotencyKey: "never",
  });
  a.controller.abort();
  assert.equal((await queued).value.error, "stopped");
  assert.equal(fs.readFileSync(path.join(f.one, "mcp.md"), "utf8"), "Made over MCP");
  assert.equal((await call("workspace_read", { path: "story.md" })).value.error, "stopped");
  assert.throws(
    () => createScopedWorkspaceSession({ stateFile: f.state, credential: a.credential }),
    /supervision_required/,
  );
});

test("local CLI scope definition/revocation/restore works without endpoint or existing grant migration", (t) => {
  const f = fixture(t);
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wake-cli-private-"));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  f.state = path.join(privateRoot, "state.json");
  const cli = path.resolve("services/shared-workspace/cli.mjs");
  const credentialFile = path.join(privateRoot, "client.json");
  const output = execFileSync(
    process.execPath,
    [
      cli,
      "scope-grant",
      "--state",
      f.state,
      "--root",
      f.one,
      "--name",
      "cli",
      "--participant",
      "recipient",
      "--rights",
      "create,read",
      "--credential",
      credentialFile,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
  assert.ok(!output.includes(credential.token));
  assert.deepEqual(loadState(f.state).grants[0].rights, ["create", "read"]);
  assert.equal(loadState(f.state).grants[0].scope, "cli");
  const session = createScopedWorkspaceSession({
    stateFile: f.state,
    credential,
    signal: new AbortController().signal,
  });
  t.after(() => session.stop());
  const record = session.call(edit("create", "cli.md", "CLI file", undefined, "cli"));
  execFileSync(
    process.execPath,
    [cli, "revoke", "--state", f.state, "--capability", credential.capability],
    { windowsHide: true },
  );
  assert.throws(() => session.call({ op: "read", path: "cli.md" }), /unauthorized/);
  const restored = execFileSync(
    process.execPath,
    [
      cli,
      "scope-restore",
      "--state",
      f.state,
      "--operation",
      record.id,
      "--expected-hash",
      hash("CLI file"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(restored).status, "restored");
  assert.equal(fs.existsSync(path.join(f.one, "cli.md")), false);
  const refused = spawnSync(
    process.execPath,
    [
      cli,
      "scope-grant",
      "--state",
      f.state,
      "--root",
      f.two,
      "--name",
      "two",
      "--participant",
      "x",
      "--rights",
      "read",
      "--credential",
      path.join(f.two, "client.json"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refused.status, 1);
  assert.equal(fs.existsSync(path.join(f.two, "client.json")), false);
});
