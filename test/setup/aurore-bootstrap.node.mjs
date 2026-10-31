import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  bootstrap,
  preflight,
  rollback,
  FileTransaction,
} from "../../scripts/aurore-bootstrap.mjs";
import {
  localGrantScope,
  createScopedWorkspaceServer,
} from "../../services/shared-workspace/workspace.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const sha = (f) => hash(fs.readFileSync(f));
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const repo = path.resolve(".");
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function tree(root) {
  const result = {};
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) visit(f);
      else result[path.relative(root, f)] = sha(f);
    }
  };
  visit(root);
  return result;
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wake-bootstrap-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, "data"),
    priv = path.join(base, "private"),
    source = path.join(base, "source");
  for (const d of [
    priv,
    source,
    path.join(data, "installation"),
    path.join(data, "workspace/jobs"),
    path.join(data, "workspace/shared"),
    path.join(base, "transactions"),
  ])
    fs.mkdirSync(d, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(source, "sentinel"), "approved fixture source");
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  const revision = git(source, "rev-parse", "HEAD");
  const exe = path.join(priv, "desktop-marker.exe");
  fs.writeFileSync(exe, "not a Windows executable; never launched");
  const manifest = path.join(data, "installation/manifest.json");
  save(manifest, {
    version: 1,
    dataDir: data,
    repoDir: repo,
    node: process.execPath,
    desktopExe: exe,
    revision,
    development: false,
    codex: { sentinel: "identity retained" },
    pipe: "fixture-pipe",
    customSetting: "keep",
  });
  for (const f of ["installation/keys.json", "profile.json", "pairing.json"])
    fs.writeFileSync(path.join(data, f), "fixture-private-sentinel-" + f);
  const key = path.join(priv, "key.pem"),
    cert = path.join(priv, "cert.pem");
  execFileSync(
    "C:/Program Files/Git/usr/bin/openssl.exe",
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
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const root = path.join(data, "workspace/shared"),
    state = path.join(priv, "state.json");
  fs.writeFileSync(
    path.join(root, "probe.md"),
    "Fixture content never included in bootstrap logs.\n",
  );
  const grant = localGrantScope(state, {
    name: "writing",
    root,
    dataRoots: [data],
    participant: "reader",
    rights: ["list", "read"],
  });
  const config = path.join(priv, "server.json");
  save(config, { stateFile: state, keyFile: key, certFile: cert, host: "127.0.0.1", port: 0 });
  const policy = path.join(priv, "policy.json"),
    binding = path.join(priv, "binding.json");
  save(policy, {
    target: "agent-abcdefghjk",
    sharedEndpoint: "https://127.0.0.1:443/v1/messages",
    grants: [{ actor: "agent-bcdefghjkm", actions: ["diagnose", "relaunch_app"] }],
    releases: { approved: { revision } },
  });
  save(binding, { endpoint: "https://127.0.0.1:443/v1/messages", key: "fixture-secret-binding" });
  const target = {
    version: 1,
    role: "target",
    operatorApproved: true,
    manifestFile: manifest,
    manifestSha256: sha(manifest),
    transactionRoot: path.join(base, "transactions"),
    release: { approved: true, source, branch: "main", expectedRevision: revision },
    maintenance: {
      policyFile: policy,
      bindingFile: binding,
      storeFile: path.join(priv, "maintenance.sqlite"),
    },
    filesystem: {
      configFile: config,
      workspace: path.join(data, "workspace"),
      scope: "writing",
      root,
      participant: "reader",
      rights: ["list", "read"],
    },
  };
  const plan = path.join(priv, "target-plan.json");
  save(plan, target);
  return {
    base,
    data,
    priv,
    source,
    revision,
    manifest,
    root,
    state,
    grant,
    key,
    cert,
    config,
    policy,
    binding,
    target,
    plan,
  };
}
test("dryrun has zero file effects and no false loaded/listening claim", async (t) => {
  const f = fixture(t),
    before = tree(f.base);
  const r = await bootstrap(f.plan);
  assert.equal(r.preflight, "passed");
  assert.equal(r.prepared, false);
  assert.equal(r.listening, "unknown");
  assert.equal(r.loadedVersion.app, "unknown");
  assert.deepEqual(tree(f.base), before);
  const out = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      pathToFileURL(path.join(repo, "test/fixtures/store-ledger/ts-hooks.ts")).href,
      path.join(repo, "scripts/aurore-bootstrap.mjs"),
      "--plan",
      f.plan,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(out).mode, "dryrun");
  assert.deepEqual(tree(f.base), before);
  assert.equal(out.includes("fixture-secret-binding"), false);
});
test("invalid plans, absent service/controller and grants fail before every mutation", async (t) => {
  const f = fixture(t);
  for (const change of [
    (p) => (p.operatorApproved = false),
    (p) => (p.manifestSha256 = "0".repeat(64)),
    (p) => (p.release.expectedRevision = "0".repeat(40)),
    (p) => (p.filesystem.participant = "unapproved"),
    (p) => (p.filesystem.rights = ["list", "read", "write"]),
    (p) => (p.maintenance.bindingFile = path.join(f.priv, "missing.json")),
    (p) => (p.filesystem.configFile = path.join(f.priv, "missing-service.json")),
    (p) => (p.untrustedShell = "whoami"),
  ]) {
    const p = structuredClone(f.target);
    change(p);
    save(f.plan, p);
    const before = tree(f.base);
    await assert.rejects(() => bootstrap(f.plan, { apply: true }));
    assert.deepEqual(tree(f.base), before);
  }
  // Real absent-controller installation, no stubbed API.
  const empty = path.join(f.base, "empty-runtime");
  fs.mkdirSync(empty);
  const m = JSON.parse(fs.readFileSync(f.manifest));
  m.repoDir = empty;
  save(f.manifest, m);
  f.target.manifestSha256 = sha(f.manifest);
  save(f.plan, f.target);
  const before = tree(f.base);
  await assert.rejects(
    () => preflight(f.plan),
    /runtime_prerequisite_missing:scripts\/setup-scoped/,
  );
  assert.deepEqual(tree(f.base), before);
  for (const rel of [
    "scripts/setup-scoped-workspace-job.mjs",
    "scripts/setup-shared-workspace.mjs",
    "scripts/desktop-maintenance.mjs",
    "scripts/desktop-supervisor.mjs",
    "scripts/owned-runtime.mjs",
    "scripts/engine-supervisor.mjs",
  ]) {
    const dest = path.join(empty, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), dest);
  }
  const beforeController = tree(f.base);
  await assert.rejects(
    () => preflight(f.plan),
    /runtime_prerequisite_missing:services\/maintenance\/controller.ts/,
  );
  assert.deepEqual(tree(f.base), beforeController);
});
test(
  "target applies actual Git updater current path under Job Object, preserves identity, prepares real helper and rolls back",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      original = fs.readFileSync(f.manifest);
    const sentinels = ["installation/keys.json", "profile.json", "pairing.json"].map((n) => [
      n,
      sha(path.join(f.data, n)),
    ]);
    const r = await bootstrap(f.plan, { apply: true });
    assert.equal(
      r.configured,
      true,
      JSON.stringify(r) +
        " " +
        (r.configured
          ? ""
          : fs.readFileSync(path.join(r.transaction, "update.json"), "utf8") +
            " " +
            fs.readFileSync(path.join(r.transaction, "update-command.stderr.log"), "utf8")),
    );
    assert.equal(r.installation.updaterState, "current");
    assert.equal(r.loadedVersion.app, "unknown");
    assert.equal(r.supervisedStart.state, "needs_supervised_start");
    assert.equal(r.supervisedStart.tool, "start_background_job");
    const m = JSON.parse(fs.readFileSync(f.manifest));
    assert.deepEqual(m.codex, { sentinel: "identity retained" });
    assert.equal(m.customSetting, "keep");
    assert.deepEqual(m.maintenance, f.target.maintenance);
    for (const [n, h] of sentinels) assert.equal(sha(path.join(f.data, n)), h);
    const job = path.join(f.data, "workspace/jobs/serve-scoped-workspace.mjs");
    assert.match(fs.readFileSync(job, "utf8"), /runScopedWorkspaceJob/);
    assert.equal(rollback(r.transaction).state, "rolled_back");
    assert.deepEqual(fs.readFileSync(f.manifest), original);
    assert.equal(fs.existsSync(job), false);
  },
);
test(
  "concurrent manifest edit during real Git updater is preserved before activation",
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    let changed = false;
    const timer = setInterval(() => {
      if (!changed && fs.readdirSync(f.target.transactionRoot).length) {
        const value = JSON.parse(fs.readFileSync(f.manifest));
        value.ownerConcurrentEdit = true;
        save(f.manifest, value);
        changed = true;
      }
    }, 5);
    t.after(() => clearInterval(timer));
    const r = await bootstrap(f.plan, { apply: true });
    assert.equal(changed, true);
    assert.equal(r.state, "apply_failed");
    assert.equal(JSON.parse(fs.readFileSync(f.manifest)).ownerConcurrentEdit, true);
    assert.equal(
      fs.existsSync(path.join(f.data, "workspace/jobs/serve-scoped-workspace.mjs")),
      false,
    );
  },
);
test(
  "client additive MCP, real private TLS list/read, actual generated MCP stdio and concurrent rollback",
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const server = createScopedWorkspaceServer({
      stateFile: f.state,
      key: fs.readFileSync(f.key),
      cert: fs.readFileSync(f.cert),
      signal: controller.signal,
    });
    t.after(() => controller.abort());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const credential = path.join(f.priv, "credential.json");
    save(credential, {
      ...f.grant,
      endpoint: `https://127.0.0.1:${server.address().port}/v1/scoped-workspace`,
      caFile: f.cert,
    });
    const native = path.join(f.priv, "config.toml");
    const prefix = Buffer.from(
      '# Native settings\r\n[mcp_servers.existing]\r\ncommand = "retained"\r\n',
    );
    fs.writeFileSync(native, prefix);
    const p = {
      version: 1,
      role: "client",
      operatorApproved: true,
      manifestFile: f.manifest,
      manifestSha256: sha(f.manifest),
      transactionRoot: f.target.transactionRoot,
      client: {
        credentialFile: credential,
        nativeConfig: native,
        nativeConfigSha256: sha(native),
        scope: "writing",
        participant: "reader",
        probe: "probe.md",
      },
    };
    const plan = path.join(f.priv, "client-plan.json");
    save(plan, p);
    const before = tree(f.base);
    await bootstrap(plan);
    assert.deepEqual(tree(f.base), before);
    const r = await bootstrap(plan, { apply: true, probe: true });
    assert.equal(r.configured, true, JSON.stringify(r));
    assert.equal(r.reading, "read_succeeded");
    assert.equal(r.listening, "tls_response_observed");
    assert.equal(r.probe.probe.sha256, sha(path.join(f.root, "probe.md")));
    assert.deepEqual(fs.readFileSync(native).subarray(0, prefix.length), prefix);
    const body = fs.readFileSync(native, "utf8").split("[mcp_servers.mind_workspace_scoped]")[1];
    const command = JSON.parse(body.match(/command = (.+)/)[1]),
      args = JSON.parse(body.match(/args = (.+)/)[1]);
    const client = new Client({ name: "bootstrap-fixture", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command, args, stderr: "pipe" }));
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 7);
      const list = await client.callTool({ name: "workspace_list", arguments: { path: "" } });
      assert.equal(list.isError, undefined);
      const read = await client.callTool({
        name: "workspace_read",
        arguments: { path: "probe.md" },
      });
      assert.equal(read.isError, undefined);
    } finally {
      await client.close();
    }
    const output = JSON.stringify(r);
    for (const secret of [
      f.grant.token,
      "fixture-secret-binding",
      "Fixture content never included",
    ])
      assert.equal(output.includes(secret), false);
    fs.appendFileSync(native, "\n# concurrent owner edit\n");
    const concurrent = fs.readFileSync(native);
    assert.equal(rollback(r.transaction).state, "rollback_conflict");
    assert.deepEqual(fs.readFileSync(native), concurrent);
  },
);
test("combined target plan updates workspace independently and rolls back both owned changes", async (t) => {
  const f = fixture(t),
    origin = path.join(f.base, "workspace-origin"),
    active = path.join(f.base, "active-workspace");
  git(f.base, "clone", "-c", "core.autocrlf=false", f.source, origin);
  git(f.base, "clone", "-c", "core.autocrlf=false", origin, active);
  git(active, "remote", "set-url", "origin", origin);
  git(origin, "config", "user.name", "Fixture");
  git(origin, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(origin, "AGENTS.md"), "approved workspace instructions\n");
  git(origin, "add", "AGENTS.md");
  git(origin, "commit", "-m", "workspace instructions");
  const workspaceRevision = git(origin, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(active, "artifacts"));
  fs.writeFileSync(path.join(active, "artifacts/PERSONALITY.md"), "local personality\n");
  f.target.workspace = {
    approved: true,
    root: active,
    origin,
    expectedHead: f.revision,
    expectedRevision: workspaceRevision,
  };
  save(f.plan, f.target);
  const original = fs.readFileSync(f.manifest),
    before = tree(f.base);
  const dry = await bootstrap(f.plan);
  assert.equal(dry.workspaceRevision, f.revision);
  assert.deepEqual(tree(f.base), before);
  const r = await bootstrap(f.plan, { apply: true });
  assert.equal(r.configured, true, JSON.stringify(r));
  assert.equal(r.sourceRevision, f.revision);
  assert.equal(r.installation.revision, f.revision);
  assert.equal(r.workspaceRevision, workspaceRevision);
  assert.notEqual(r.workspaceRevision, r.sourceRevision);
  assert.equal(r.loadedVersion.app, "unknown");
  assert.equal(r.workspace.nextWake.personalityLoaded, "unknown");
  assert.equal(rollback(r.transaction).state, "rolled_back");
  assert.equal(git(active, "rev-parse", "HEAD"), f.revision);
  assert.deepEqual(fs.readFileSync(f.manifest), original);
  assert.equal(
    fs.readFileSync(path.join(active, "artifacts/PERSONALITY.md"), "utf8"),
    "local personality\n",
  );
});

test("transaction rejects concurrent writes, preserves concurrent rollback and validates backups", (t) => {
  const f = fixture(t),
    file = path.join(f.priv, "owned.txt");
  fs.writeFileSync(file, "before");
  const tx = new FileTransaction(path.join(f.base, "tx"));
  assert.throws(() => tx.write(file, Buffer.from("after"), "0".repeat(64)), /concurrent_change/);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  tx.write(file, Buffer.from("after"), sha(file));
  fs.writeFileSync(file, "owner change");
  assert.equal(tx.rollback().state, "rollback_conflict");
  assert.equal(fs.readFileSync(file, "utf8"), "owner change");
  fs.writeFileSync(file, "after");
  fs.writeFileSync(path.join(tx.dir, "0.before"), "tampered");
  assert.throws(() => tx.rollback(), /backup_hash_mismatch/);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
});
test(
  "approved revision installation executes real Git, npm build and locked Cargo fixture without loading desktop",
  { timeout: 120000 },
  async (t) => {
    const f = fixture(t);
    const priorPath = process.env.PATH;
    process.env.PATH =
      "C:/Users/reyno/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin;" + priorPath;
    t.after(() => {
      process.env.PATH = priorPath;
    });
    for (const [name, value] of Object.entries({
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      CARGO_NET_OFFLINE: "true",
    })) {
      const old = process.env[name];
      process.env[name] = value;
      t.after(() => {
        if (old === undefined) delete process.env[name];
        else process.env[name] = old;
      });
    }
    // This source is a tiny real executable fixture, not a Wake binary or identity attestation.
    const required = [
      "scripts/setup-scoped-workspace-job.mjs",
      "scripts/setup-shared-workspace.mjs",
      "scripts/desktop-maintenance.mjs",
      "scripts/desktop-supervisor.mjs",
      "scripts/owned-runtime.mjs",
      "scripts/engine-supervisor.mjs",
      "scripts/app-update.mjs",
      "scripts/managed-mcp-launcher.mjs",
      "services/maintenance/controller.ts",
      "services/maintenance/local-adapter.ts",
      "services/maintenance/pump.ts",
      "services/mcp/shared-https.ts",
      "services/shared-workspace/scoped-client.mjs",
      "services/shared-workspace/scoped-job.mjs",
      "services/shared-workspace/mcp-scoped.mjs",
      "services/shared-workspace/private-files.mjs",
      "services/shared-workspace/workspace.mjs",
      "test/fixtures/store-ledger/ts-hooks.ts",
      "src/runner/process-tree.ts",
      "src/scheduler/instance-lock.ts",
      "src/communication/maintenance-protocol.ts",
      "src/contracts/lifecycle.ts",
    ];
    for (const rel of required) {
      const dest = path.join(f.source, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(repo, rel), dest);
    }
    save(path.join(f.source, "package.json"), {
      name: "bootstrap-synthetic-fixture",
      version: "1.0.0",
      private: true,
      scripts: { build: "node fixture-build.cjs", "desktop:ui": "node fixture-build.cjs" },
    });
    save(path.join(f.source, "package-lock.json"), {
      name: "bootstrap-synthetic-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "bootstrap-synthetic-fixture", version: "1.0.0" } },
    });
    fs.writeFileSync(
      path.join(f.source, "fixture-build.cjs"),
      "const fs=require('node:fs'),path=require('node:path');fs.mkdirSync('dist/cli',{recursive:true});fs.writeFileSync('dist/cli/main.js','// fixture only');for(const name of ['zod','better-sqlite3'])fs.cpSync(path.join(" +
        JSON.stringify(path.join(repo, "node_modules")) +
        ",name),path.join('node_modules',name),{recursive:true});",
    );
    fs.writeFileSync(
      path.join(f.source, ".gitignore"),
      "node_modules/\ndist/\ndesktop/src-tauri/target/\n",
    );
    fs.mkdirSync(path.join(f.source, "desktop/src-tauri/src"), { recursive: true });
    fs.writeFileSync(
      path.join(f.source, "desktop/src-tauri/Cargo.toml"),
      '[package]\nname = "mind-wake-desktop"\nversion = "0.0.0"\nedition = "2021"\n',
    );
    fs.writeFileSync(
      path.join(f.source, "desktop/src-tauri/Cargo.lock"),
      'version = 4\n[[package]]\nname = "mind-wake-desktop"\nversion = "0.0.0"\n',
    );
    fs.writeFileSync(
      path.join(f.source, "desktop/src-tauri/src/main.rs"),
      'fn main() { println!("synthetic fixture, not Wake"); }',
    );
    git(f.source, "add", ".");
    git(f.source, "commit", "-m", "approved miniature build fixture");
    const rev = git(f.source, "rev-parse", "HEAD");
    f.target.release.expectedRevision = rev;
    const policy = JSON.parse(fs.readFileSync(f.policy));
    policy.releases.approved.revision = rev;
    save(f.policy, policy);
    save(f.plan, f.target);
    const r = await bootstrap(f.plan, { apply: true });
    assert.equal(
      r.configured,
      true,
      JSON.stringify(r) +
        (r.configured
          ? ""
          : fs.readFileSync(path.join(r.transaction, "update-command.stderr.log"), "utf8")),
    );
    assert.equal(r.installation.updaterState, "installed");
    assert.equal(r.installation.revision, rev);
    assert.equal(r.loadedVersion.app, "unknown");
    const m = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(fs.readFileSync(m.desktopExe).subarray(0, 2).toString(), "MZ");
    assert.equal(m.customSetting, "keep");
    assert.equal(rollback(r.transaction).state, "rolled_back");
    assert.equal(JSON.parse(fs.readFileSync(f.manifest)).revision, f.revision);
  },
);
