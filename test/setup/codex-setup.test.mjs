import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareCodex, runProcess, codexEnvironment, findNpm } from "../../scripts/codex-setup.mjs";
import { discoverCodex } from "../../dist/adapters/codex/executable.js";
import { codexRuntimeEnv, prepareInstallation } from "../../scripts/installation.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const schema = fs.readFileSync(new URL("../fixtures/codex/schema.json", import.meta.url));
const SECRET = "SECRET_SENTINEL_DO_NOT_LOG";
let dir, env, script, executable;
const fixture = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), env = process.env;
const root = env.FIXTURE_ROOT;
if(args.includes('generate-json-schema')) {
  const out = args[args.indexOf('--out')+1];
  fs.mkdirSync(out,{recursive:true});
  fs.copyFileSync(new URL('./schema.json',import.meta.url),path.join(out,'schema.json'));
  process.exit(0);
}
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,home:env.CODEX_HOME,pid:process.pid})+'\\n');
if(args[0]==='install') {
  if(env.FAIL_INSTALL) { console.error('${SECRET}'); process.exit(17); }
  if(!env.NO_BINARY) {
    const base=path.join(root,'npm prefix with spaces');
    const file=path.join(base,'node_modules/@openai/codex/bin/codex.js');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.copyFileSync(new URL(import.meta.url),file);
    fs.copyFileSync(new URL('./schema.json',import.meta.url),path.join(path.dirname(file),'schema.json'));
    fs.writeFileSync(path.join(base,'codex.cmd'),'fixture shim (never executed)');
  }
  process.exit(0);
}
if(args[0]==='prefix') { console.log(path.join(root,'npm prefix with spaces')); process.exit(0); }
if(args[0]==='--version') { console.log(env.BAD_VERSION?'junk':'codex-cli 0.200.1'); process.exit(0); }
if(args[0]==='login' && args[1]==='status') {
  console.log('${SECRET}');console.error('${SECRET}');
  process.exit(fs.existsSync(path.join(root,'logged-in'))?0:1);
}
if(args[0]==='login') {
  if(env.CANCEL_LOGIN) process.exit(130);
  if(!env.FAIL_AFTER_LOGIN) fs.writeFileSync(path.join(root,'logged-in'),'fixture');
  process.exit(0);
}
if(args[0]==='mcp' && args[1]==='list') { console.log(env.MCP_ENTRIES || '[]'); process.exit(0); }
if(args[0]==='hang') setInterval(()=>{},1000);
else process.exit(2);
`;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-setup-fixture-"));
  script = path.join(dir, "fixture with spaces.mjs");
  fs.writeFileSync(script, fixture);
  fs.writeFileSync(path.join(dir, "schema.json"), schema);
  env = {
    ...process.env,
    PATH: "",
    Path: "",
    USERPROFILE: path.join(dir, "user"),
    HOME: path.join(dir, "user"),
    LOCALAPPDATA: path.join(dir, "local"),
    APPDATA: path.join(dir, "roaming"),
    CODEX_HOME: path.join(dir, "chosen codex home"),
    FIXTURE_ROOT: dir,
  };
  delete env.MIND_WAKE_CODEX_BIN;
  delete env.CODEX_INSTALL_DIR;
  executable = { path: process.execPath, prefixArgs: [script] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const calls = () =>
  fs.existsSync(path.join(dir, "calls.jsonl"))
    ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    : [];
const deps = () => ({ discover: () => executable, npm: () => executable });

test("plan absent: no process, install, login, profile or MCP mutation", async () => {
  const before = fs.readdirSync(dir);
  const plan = await prepareCodex(
    { env },
    {
      discover: () => null,
      run: () => assert.fail("process started"),
      check: () => assert.fail("schema export"),
    },
  );
  assert.equal(plan.mode, "plan");
  assert.equal(plan.found, false);
  assert.deepEqual(fs.readdirSync(dir), before);
  const cli = await runProcess(
    { path: process.execPath },
    [
      path.join(repo, "scripts/setup.mjs"),
      "--engine-only",
      "--no-open",
      "--login",
      "--data-dir",
      path.join(dir, "data"),
    ],
    { env },
  );
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).codex.found, false);
  assert.equal(fs.existsSync(path.join(dir, "data")), false);
  assert.deepEqual(calls(), []);
});
test("existing compatible binary remains unchanged, auth preserved, chosen home reused", async () => {
  fs.writeFileSync(path.join(dir, "logged-in"), "existing");
  const original = fs.readFileSync(script, "utf8");
  const result = await prepareCodex({ apply: true, env }, deps());
  assert.equal(result.version, "0.200.1");
  assert.equal(result.authenticated, true);
  assert.equal(fs.readFileSync(script, "utf8"), original);
  assert.deepEqual(
    calls().map((c) => c.args),
    [["--version"], ["login", "status"]],
  );
  assert.ok(calls().every((c) => c.home === env.CODEX_HOME));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});
test("absent: official npm argv, re-detection after prefix, spaces and npm wrapper", async () => {
  fs.writeFileSync(path.join(dir, "logged-in"), "existing");
  const result = await prepareCodex({ apply: true, env }, { npm: () => executable });
  assert.equal(result.authenticated, true);
  assert.match(result.executable.prefixArgs[0], /npm prefix with spaces/);
  assert.deepEqual(calls()[0].args, [
    "install",
    "--global",
    "@openai/codex@latest",
    "--no-audit",
    "--no-fund",
  ]);
  const second = await prepareCodex(
    { apply: true, env: { ...env, PATH: path.join(dir, "npm prefix with spaces") } },
    { npm: () => assert.fail("reinstall") },
  );
  assert.deepEqual(second.executable, result.executable);
});
test("failed install or successful npm without binary cannot report ready or leak stderr", async () => {
  for (const fail of [{ FAIL_INSTALL: "1" }, { NO_BINARY: "1" }]) {
    await assert.rejects(
      prepareCodex({ apply: true, env: { ...env, ...fail } }, { npm: () => executable }),
      (error) => {
        assert.ok(!error.message.includes(SECRET));
        assert.match(error.message, /npm|Codex introuvable/);
        return true;
      },
    );
  }
});
test("Node/npm missing and explicit broken path give actionable failure", async () => {
  // The real Node distribution can include npm even when PATH is empty.
  const npm = findNpm(env);
  assert.equal(npm.path, process.execPath);
  await assert.rejects(
    prepareCodex(
      { apply: true, env },
      {
        discover: () => null,
        npm: () => {
          throw Error("npm absent : installer Node/npm");
        },
      },
    ),
    /npm absent/,
  );
  await assert.rejects(
    prepareCodex({
      apply: true,
      env: { ...env, MIND_WAKE_CODEX_BIN: path.join(dir, "missing.exe") },
    }),
    /MIND_WAKE_CODEX_BIN/,
  );
});
test("missing login in no-open/noninteractive/background: no hidden login", async () => {
  for (const options of [
    {},
    { login: true, noOpen: true },
    { login: true, noninteractive: true },
    { login: true },
  ]) {
    await assert.rejects(
      prepareCodex({ apply: true, env, ...options }, { ...deps(), isInteractive: () => false }),
      /terminal visible/,
    );
  }
  assert.ok(calls().every((c) => c.args[0] !== "login" || c.args[1] === "status"));
});
test("explicit interactive login checks status again, without logging provider output", async () => {
  const run = (exe, args, opts) => runProcess(exe, args, { ...opts, interactive: false });
  const result = await prepareCodex(
    { apply: true, login: true, env },
    { ...deps(), run, isInteractive: () => true },
  );
  assert.equal(result.authenticated, true);
  assert.deepEqual(
    calls().map((c) => c.args),
    [["--version"], ["login", "status"], ["login"], ["login", "status"]],
  );
});
test("cancelled login and login without valid subsequent status leave resumable failure", async () => {
  const run = (exe, args, opts) => runProcess(exe, args, { ...opts, interactive: false });
  for (const mode of [{ CANCEL_LOGIN: "1" }, { FAIL_AFTER_LOGIN: "1" }])
    await assert.rejects(
      prepareCodex(
        { apply: true, login: true, env: { ...env, ...mode } },
        { ...deps(), run, isInteractive: () => true },
      ),
      (error) => {
        assert.match(error.message, /reprendre|confirmée/);
        assert.ok(!error.message.includes(SECRET));
        return true;
      },
    );
});
test("invalid version stops before authentication", async () => {
  await assert.rejects(
    prepareCodex({ apply: true, env: { ...env, BAD_VERSION: "1" } }, deps()),
    /Version Codex illisible/,
  );
  assert.deepEqual(
    calls().map((c) => c.args),
    [["--version"]],
  );
});
test("Windows app/native path and npm shim discovery are stable and shell-free", () => {
  const native = path.join(env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "sentinel");
  assert.deepEqual(discoverCodex(env), { path: native });
  const bin = path.join(dir, "bin with spaces & symbols");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex.cmd"), "must not execute");
  assert.deepEqual(discoverCodex({ ...env, PATH: bin }), { path: native });
  const js = path.join(bin, "node_modules/@openai/codex/bin/codex.js");
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, "");
  assert.deepEqual(discoverCodex({ ...env, PATH: bin }), {
    path: process.execPath,
    prefixArgs: [js],
  });
  const manifest = prepareInstallation(repo, path.join(dir, "profile"), {
    executable: { path: process.execPath, prefixArgs: [js] },
    codexHome: env.CODEX_HOME,
  });
  assert.deepEqual(codexRuntimeEnv(manifest), {
    CODEX_HOME: env.CODEX_HOME,
    MIND_WAKE_CODEX_BIN: js,
  });
  assert.deepEqual(discoverCodex({ ...env, ...codexRuntimeEnv(manifest) }), {
    path: process.execPath,
    prefixArgs: [js],
  });
});
test("pre-existing MCP conflict is refused before profile/launcher/desktop mutation", async () => {
  // Run actual entrypoint, only fixture Codex is discoverable.
  const bin = path.join(dir, "npm prefix with spaces");
  await runProcess(executable, ["install"], { env });
  fs.writeFileSync(path.join(dir, "logged-in"), "yes");
  const data = path.join(dir, "untouched-profile");
  const result = await runProcess(
    { path: process.execPath },
    [
      path.join(repo, "scripts/setup.mjs"),
      "--apply",
      "--engine-only",
      "--no-open",
      "--data-dir",
      data,
    ],
    {
      env: {
        ...env,
        PATH: bin,
        MCP_ENTRIES: JSON.stringify([
          { name: "mind-wake", transport: { type: "stdio", command: "other" } },
        ]),
      },
      timeout: 60000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(data), false);
  assert.ok(!result.stdout.includes(SECRET));
  assert.ok(!calls().some((c) => c.args[0] === "mcp" && c.args[1] === "add"));
});
test("actual apply entrypoint with missing auth prints a resumable error without secret or profile", async () => {
  await runProcess(executable, ["install"], { env });
  const data = path.join(dir, "no-auth-profile");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "scripts/setup.mjs"),
      "--apply",
      "--engine-only",
      "--no-open",
      "--data-dir",
      data,
    ],
    {
      env: { ...env, PATH: path.join(dir, "npm prefix with spaces") },
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      shell: false,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminal visible/);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
  assert.equal(fs.existsSync(data), false);
  assert.ok(!calls().some((c) => c.args[0] === "login" && c.args.length === 1));
  assert.ok(!calls().some((c) => c.args[0] === "mcp"));
});
test("process timeout, cancellation and missing command never return success", async () => {
  await assert.rejects(runProcess(executable, ["hang"], { env, timeout: 300 }), /Délai dépassé/);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(runProcess(executable, ["hang"], { env, signal: abort.signal }), /annulée/);
  assert.equal(calls().filter((c) => c.args[0] === "hang").length, 2);
  for (const call of calls().filter((c) => c.args[0] === "hang"))
    assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
  await assert.rejects(
    runProcess({ path: path.join(dir, "absent.exe") }, [], { env }),
    /Processus indisponible/,
  );
});
test("home option wins over inherited CODEX_HOME without changing process environment", () => {
  assert.equal(
    codexEnvironment(env, path.join(dir, "explicit")).CODEX_HOME,
    path.join(dir, "explicit"),
  );
  assert.equal(codexEnvironment(env).CODEX_HOME, env.CODEX_HOME);
});
