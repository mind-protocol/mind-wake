#!/usr/bin/env node
/** Local operator orchestration. No peer instructions, activation, detached processes or grants. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { privateFile, privateTarget } from "../services/shared-workspace/private-files.mjs";
import {
  loadScopedCredential,
  diagnoseScopedWorkspace,
  privateHost,
} from "../services/shared-workspace/scoped-client.mjs";
import {
  preflightScopedJob,
  readScopedJobConfig,
} from "../services/shared-workspace/scoped-job.mjs";
import { loadState } from "../services/shared-workspace/workspace.mjs";
import { checkUpdate } from "./app-update.mjs";
import {
  preflightWorkspace,
  guardWorkspace,
  applyWorkspace,
  rollbackWorkspace,
} from "./aurore-bootstrap-workspace.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const encode = (o) => Buffer.from(JSON.stringify(o, null, 2) + "\n");
const fail = (code) => {
  throw Error(code);
};
function keys(o, names, at) {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !names.includes(k))
  )
    fail("invalid_fields:" + at);
}
function absolute(f, at) {
  if (typeof f !== "string" || !path.isAbsolute(f)) fail("absolute_path_required:" + at);
  return path.resolve(f);
}
function regular(f) {
  absolute(f, "file");
  const s = fs.lstatSync(f);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail("regular_unlinked_file_required");
  // Reject any redirected ancestor, not just a symlink at the leaf.
  if (fs.realpathSync.native(f).toLowerCase() !== path.resolve(f).toLowerCase())
    fail("redirected_path");
  return f;
}
function snapshot(f) {
  if (!fs.existsSync(f)) return { sha256: null, bytes: null };
  regular(f);
  const bytes = fs.readFileSync(f);
  return { sha256: hash(bytes), bytes };
}
function managedTarget(file) {
  absolute(file, "managed_file");
  const parent = path.dirname(file);
  if (fs.realpathSync.native(parent).toLowerCase() !== path.resolve(parent).toLowerCase())
    fail("redirected_write_parent");
  return path.resolve(file);
}
function atomic(f, bytes) {
  const temp = `${f}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, f);
}
const inside = (r, f) => {
  const rel = path.relative(r, f);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const apiPaths = [
  "scripts/setup-scoped-workspace-job.mjs",
  "scripts/setup-shared-workspace.mjs",
  "scripts/desktop-maintenance.mjs",
  "scripts/desktop-supervisor.mjs",
  "scripts/owned-runtime.mjs",
  "scripts/engine-supervisor.mjs",
  "services/maintenance/controller.ts",
  "services/maintenance/local-adapter.ts",
  "services/maintenance/pump.ts",
  "services/mcp/shared-https.ts",
  "services/shared-workspace/scoped-client.mjs",
  "services/shared-workspace/scoped-job.mjs",
  "services/shared-workspace/mcp-scoped.mjs",
  "test/fixtures/store-ledger/ts-hooks.ts",
  "src/runner/process-tree.ts",
  "scripts/app-update.mjs",
  "scripts/managed-mcp-launcher.mjs",
];
function runtimePreflight(repo) {
  for (const rel of apiPaths)
    if (!fs.existsSync(path.join(repo, rel))) fail("runtime_prerequisite_missing:" + rel);
  if (
    !fs
      .readFileSync(path.join(repo, "scripts/desktop-supervisor.mjs"), "utf8")
      .includes("superviseDesktopMaintenance")
  )
    fail("supervisor_maintenance_hook_missing");
  if (
    !fs.readFileSync(path.join(repo, "scripts/app-update.mjs"), "utf8").includes("expectedRevision")
  )
    fail("updater_expected_revision_missing");
  // Actual module loading and policy validation happen separately; existence is not activation evidence.
}
function policyPreflight(repo, policyFile) {
  const result = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      pathToFileURL(path.join(repo, "test/fixtures/store-ledger/ts-hooks.ts")).href,
      "--input-type=module",
      "-e",
      "const m=await import(process.argv[1]); m.readMaintenancePolicy(process.argv[2]);",
      pathToFileURL(path.join(repo, "services/maintenance/controller.ts")).href,
      policyFile,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
  );
  return result;
}
function sourceState(repo, expectedRevision) {
  try {
    const opts = {
      cwd: repo,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const head = execFileSync("git", ["rev-parse", "HEAD"], opts).trim();
    const dirty = !!execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      opts,
    ).trim();
    return {
      state: dirty
        ? "buildWIP"
        : head === expectedRevision
          ? "clean_source"
          : "source_revision_differs",
      head,
      dirty,
    };
  } catch {
    return { state: "source_unattested" };
  }
}

export class FileTransaction {
  constructor(dir) {
    this.dir = dir;
    this.entries = [];
    fs.mkdirSync(dir, { mode: 0o700 });
    this.save();
  }
  save() {
    atomic(
      path.join(this.dir, "journal.json"),
      encode({ version: 1, entries: this.entries, workspaceUpdate: this.workspaceUpdate }),
    );
  }
  write(file, bytes, expected) {
    file = managedTarget(file);
    const old = snapshot(file);
    if (old.sha256 !== expected) fail("concurrent_change");
    const next = hash(bytes);
    if (next === expected) return;
    const n = this.entries.length;
    const backup = old.bytes === null ? null : `${n}.before`;
    if (backup) atomic(path.join(this.dir, backup), old.bytes);
    const entry = { file, before: old.sha256, after: next, backup };
    this.entries.push(entry);
    this.save(); // intent durable before replacing the file
    if (snapshot(file).sha256 !== expected) fail("concurrent_change");
    atomic(file, bytes);
  }
  rollback() {
    return rollback(this.dir);
  }
}
export function rollback(dir) {
  dir = fs.realpathSync.native(absolute(dir, "rollback"));
  const journal = json(privateFile(path.join(dir, "journal.json")));
  if (journal.version !== 1 || !Array.isArray(journal.entries)) fail("invalid_journal");
  const workspace = rollbackWorkspace(journal.workspaceUpdate, dir);
  const results = [];
  for (const e of [...journal.entries].reverse()) {
    const file = managedTarget(e.file);
    const now = snapshot(file).sha256;
    if (now === e.before) {
      results.push({ state: "already_restored" });
      continue;
    }
    if (now !== e.after) {
      results.push({ state: "concurrent_change_preserved" });
      continue;
    }
    if (e.backup === null && e.before === null) {
      if (snapshot(file).sha256 !== e.after) {
        results.push({ state: "concurrent_change_preserved" });
        continue;
      }
      fs.unlinkSync(file);
    } else {
      if (!/^\d+\.before$/.test(e.backup)) fail("invalid_backup");
      const bytes = fs.readFileSync(regular(path.join(dir, e.backup)));
      if (hash(bytes) !== e.before) fail("backup_hash_mismatch");
      if (snapshot(file).sha256 !== e.after) {
        results.push({ state: "concurrent_change_preserved" });
        continue;
      }
      atomic(file, bytes);
    }
    results.push({ state: "restored" });
  }
  return {
    state:
      results.some((r) => r.state === "concurrent_change_preserved") ||
      ["concurrent_change_preserved", "workspace_needs_local_review"].includes(workspace.state)
        ? "rollback_conflict"
        : "rolled_back",
    files: results,
    workspace,
  };
}

export async function preflight(planFile) {
  regular(privateFile(planFile));
  const p = json(planFile);
  keys(
    p,
    [
      "version",
      "role",
      "operatorApproved",
      "manifestFile",
      "manifestSha256",
      "transactionRoot",
      "release",
      "maintenance",
      "filesystem",
      "client",
      "workspace",
    ],
    "plan",
  );
  if (
    p.version !== 1 ||
    p.operatorApproved !== true ||
    !["target", "client", "workspace"].includes(p.role)
  )
    fail("local_operator_plan_required");
  if (p.role === "workspace") {
    for (const k of [
      "manifestFile",
      "manifestSha256",
      "release",
      "maintenance",
      "filesystem",
      "client",
    ])
      if (p[k] !== undefined) fail("app_fields_in_workspace_only_plan");
    privateTarget(path.join(absolute(p.transactionRoot, "transactionRoot"), "probe"));
    if (
      fs.realpathSync.native(p.transactionRoot).toLowerCase() !==
      path.resolve(p.transactionRoot).toLowerCase()
    )
      fail("redirected_transaction_root");
    const workspace = preflightWorkspace(p.workspace);
    if (inside(workspace.root, p.transactionRoot) || inside(workspace.root, planFile))
      fail("workspace_private_plan_or_transaction_inside_repo");
    return {
      p,
      inputs: new Map([[planFile, snapshot(planFile).sha256]]),
      workspace,
      report: {
        mode: "dryrun",
        role: p.role,
        preflight: "passed",
        prepared: false,
        configured: false,
        workspace: workspace.report,
        workspaceRevision: workspace.before,
        sourceRevision: "not_updated",
        loadedVersion: { app: "unknown", daemon: "unknown", mcp: "unknown" },
        states: ["workspace_preflight_ready", "needs_next_wake_proof"],
      },
    };
  }
  const inputs = new Map();
  const pin = (f, field = "local_input") => {
    absolute(f, field);
    if (!fs.existsSync(f)) fail("input_file_missing:" + field);
    regular(privateFile(absolute(f, "input")));
    inputs.set(f, snapshot(f).sha256);
    return f;
  };
  pin(planFile);
  pin(p.manifestFile, "manifestFile");
  if (inputs.get(p.manifestFile) !== p.manifestSha256) fail("manifest_hash_mismatch");
  const m = json(p.manifestFile);
  if (m.version !== 1) fail("installation_manifest_version");
  for (const k of ["repoDir", "dataDir", "node", "desktopExe"]) absolute(m[k], "manifest." + k);
  if (fs.realpathSync.native(m.repoDir).toLowerCase() !== path.resolve(m.repoDir).toLowerCase())
    fail("redirected_repo");
  regular(m.node);
  regular(m.desktopExe);
  const version = execFileSync(m.node, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  }).trim();
  if (!/^v(?:24\.(?:1[7-9]|[2-9]\d)|26\.(?:1[3-9]|[2-9]\d))\./.test(version))
    fail("manifest_node_version_unsupported");
  if (
    path.resolve(p.manifestFile).toLowerCase() !==
    path.join(m.dataDir, "installation/manifest.json").toLowerCase()
  )
    fail("manifest_data_dir_mismatch");
  const transactionRoot = privateTarget(
    path.join(absolute(p.transactionRoot, "transactionRoot"), "probe"),
  );
  if (!fs.statSync(path.dirname(transactionRoot)).isDirectory()) fail("transaction_root_required");
  if (
    fs.realpathSync.native(p.transactionRoot).toLowerCase() !==
    path.resolve(p.transactionRoot).toLowerCase()
  )
    fail("redirected_transaction_root");
  runtimePreflight(m.repoDir);
  for (const rel of apiPaths)
    inputs.set(path.join(m.repoDir, rel), snapshot(path.join(m.repoDir, rel)).sha256);
  // Load actual helpers and dependencies now, before any write.
  const helpers = await Promise.all([
    import(pathToFileURL(path.join(m.repoDir, "scripts/setup-shared-workspace.mjs")).href),
    import(pathToFileURL(path.join(m.repoDir, "scripts/setup-scoped-workspace-job.mjs")).href),
  ]);
  await import("@modelcontextprotocol/server");
  await import("zod");
  const report = {
    mode: "dryrun",
    role: p.role,
    preflight: "passed",
    prepared: false,
    configured: false,
    listening: "unknown",
    loadedVersion: { app: "unknown", daemon: "unknown", mcp: "unknown" },
    reading: "not_probed",
    installation: { revision: m.revision ?? null, source: sourceState(m.repoDir, m.revision) },
    sourceRevision: m.revision ?? null,
    states: [],
    limits: [
      "existing_installation_required",
      "existing_private_tls_required",
      "no_grant_created",
      "no_runtime_activation",
      "loaded_versions_require_live_controller",
    ],
  };
  if (p.role === "target") {
    if (!process.execArgv.includes("--experimental-transform-types"))
      fail("target_requires_experimental_transform_types_flag");
    if (p.client) fail("client_fields_in_target_plan");
    keys(p.release, ["approved", "source", "branch", "expectedRevision"], "release");
    if (p.release.approved !== true || !/^[a-f0-9]{40,64}$/.test(p.release.expectedRevision))
      fail("approved_revision_required");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(p.release.branch) || p.release.branch.includes(".."))
      fail("invalid_branch");
    const source = p.release.source;
    if (typeof source !== "string") fail("approved_source_required");
    if (path.isAbsolute(source)) {
      if (!fs.statSync(source).isDirectory()) fail("approved_local_source_missing");
      const ref = execFileSync("git", ["rev-parse", `refs/heads/${p.release.branch}`], {
        cwd: source,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (ref !== p.release.expectedRevision) fail("approved_local_source_revision_mismatch");
    } else {
      const u = new URL(source);
      if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
        fail("approved_source_invalid");
    }
    if (m.development !== false || process.env.MIND_WAKE_DEV === "1")
      fail("updater_disabled_for_development");
    if (!fs.existsSync(path.join(path.dirname(m.node), "node_modules/npm/bin/npm-cli.js")))
      fail("npm_cli_missing_beside_manifest_node");
    if (m.revision !== p.release.expectedRevision) {
      try {
        execFileSync("cargo", ["--version"], { windowsHide: true, stdio: "pipe", timeout: 10000 });
      } catch {
        fail("cargo_toolchain_missing_for_source_update");
      }
    }
    keys(p.maintenance, ["policyFile", "bindingFile", "storeFile"], "maintenance");
    pin(p.maintenance.policyFile, "maintenance.policyFile");
    pin(p.maintenance.bindingFile, "maintenance.bindingFile");
    privateTarget(absolute(p.maintenance.storeFile, "maintenance.storeFile"));
    if (fs.existsSync(p.maintenance.storeFile)) pin(p.maintenance.storeFile);
    try {
      policyPreflight(m.repoDir, p.maintenance.policyFile);
    } catch {
      fail("maintenance_policy_or_controller_prerequisite_invalid");
    }
    const policy = json(p.maintenance.policyFile),
      binding = json(p.maintenance.bindingFile);
    if (
      binding.endpoint !== policy.sharedEndpoint ||
      typeof binding.key !== "string" ||
      !binding.key
    )
      fail("maintenance_binding_mismatch");
    const hub = new URL(binding.endpoint);
    if (!privateHost(hub.hostname.replace(/^\[|\]$/g, "")))
      fail("maintenance_private_transport_required");
    if (!Object.values(policy.releases).some((r) => r.revision === p.release.expectedRevision))
      fail("maintenance_release_not_locally_approved");
    keys(
      p.filesystem,
      ["configFile", "workspace", "scope", "root", "participant", "rights", "existingJobSha256"],
      "filesystem",
    );
    pin(p.filesystem.configFile, "filesystem.configFile");
    const pf = preflightScopedJob(p.filesystem.configFile);
    if (pf.status !== "ready_to_start") fail("filesystem_preflight:" + pf.reason);
    const cfg = readScopedJobConfig(p.filesystem.configFile);
    for (const k of ["stateFile", "keyFile", "certFile"]) pin(cfg[k]);
    const root = fs.realpathSync.native(absolute(p.filesystem.root, "filesystem.root"));
    if (
      !Array.isArray(p.filesystem.rights) ||
      !p.filesystem.rights.includes("list") ||
      !p.filesystem.rights.includes("read")
    )
      fail("explicit_list_read_rights_required");
    const grants = loadState(cfg.stateFile).grants;
    if (
      !grants.some(
        (g) =>
          g.active &&
          g.scope === p.filesystem.scope &&
          g.participant === p.filesystem.participant &&
          fs.realpathSync.native(g.root) === root &&
          JSON.stringify([...g.rights].sort()) === JSON.stringify([...p.filesystem.rights].sort()),
      )
    )
      fail("locally_selected_grant_mismatch");
    const workspace = fs.realpathSync.native(
      absolute(p.filesystem.workspace, "filesystem.workspace"),
    );
    if (workspace.toLowerCase() !== path.join(m.dataDir, "workspace").toLowerCase())
      fail("workspace_installation_mismatch");
    const jobs = fs.realpathSync.native(path.join(workspace, "jobs"));
    if (jobs.toLowerCase() !== path.join(workspace, "jobs").toLowerCase()) fail("redirected_jobs");
    const jobFile = path.join(jobs, "serve-scoped-workspace.mjs");
    if (snapshot(jobFile).sha256 !== (p.filesystem.existingJobSha256 ?? null))
      fail("job_file_collision");
    for (const g of grants) {
      const protectedPaths = [
        ...inputs.keys(),
        p.transactionRoot,
        p.maintenance.storeFile,
        jobFile,
      ];
      if (protectedPaths.some((f) => inside(g.root, f)))
        fail("bootstrap_private_file_inside_scope");
    }
    report.states.push("target_preflight_ready", "needs_supervised_start");
    if (path.isAbsolute(source))
      report.limits.push(
        "local_source_remote_update_unavailable_use_approved_https_for_remote_updates",
      );
  } else {
    if (p.release || p.maintenance || p.filesystem || p.workspace)
      fail("target_fields_in_client_plan");
    keys(
      p.client,
      ["credentialFile", "nativeConfig", "nativeConfigSha256", "scope", "participant", "probe"],
      "client",
    );
    pin(p.client.credentialFile, "client.credentialFile");
    pin(p.client.nativeConfig, "client.nativeConfig");
    if (inputs.get(p.client.nativeConfig) !== p.client.nativeConfigSha256)
      fail("native_config_hash_mismatch");
    const credential = loadScopedCredential(p.client.credentialFile);
    pin(json(p.client.credentialFile).caFile);
    if (credential.participant !== p.client.participant) fail("client_participant_mismatch");
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(p.client.scope ?? "") ||
      typeof p.client.probe !== "string" ||
      !p.client.probe ||
      /[\\:\x00-\x1f]/.test(p.client.probe) ||
      p.client.probe.split("/").some((x) => !x || x === "." || x === "..")
    )
      fail("explicit_scope_and_probe_required");
    if (fs.readFileSync(p.client.nativeConfig, "utf8").includes("mind_workspace_scoped"))
      fail("mcp_server_already_present");
    report.states.push("client_preflight_ready", "needs_native_session_reload");
  }
  const workspace = p.workspace ? preflightWorkspace(p.workspace) : null;
  if (workspace) {
    if (inside(workspace.root, p.transactionRoot) || inside(workspace.root, planFile))
      fail("workspace_private_plan_or_transaction_inside_repo");
    report.workspace = workspace.report;
    report.workspaceRevision = workspace.before;
    report.states.push("needs_next_wake_proof");
  }
  return { p, m, inputs, report, helpers, workspace };
}

// Existing Job Object supervisor owns the complete update command tree.
// CLI does not launch daemons or UI; their ownership stays with the installed controls.
function commandRunner(tree, signal, errorFile) {
  return async (exe, args, cwd, log) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|^GIT_CONFIG_/i.test(k),
      ),
    );
    env.GIT_TERMINAL_PROMPT = "0";
    signal.throwIfAborted();
    const child = tree.spawn("bootstrap", randomUUID(), {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./aurore-bootstrap-command.mjs", import.meta.url)),
        exe,
        JSON.stringify(args),
        errorFile,
      ],
      cwd,
      env,
    });
    const stop = () => {
      void child.terminateTree();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await child.started();
      let out = "",
        line;
      while ((line = await child.readLine()) !== null) {
        fs.writeSync(log, line + "\n");
        out = (out + line + "\n").slice(-8192);
      }
      const result = await child.exited;
      signal.throwIfAborted();
      if (result.mainExitCode !== 0) fail("approved_update_command_failed");
      return out;
    } finally {
      signal.removeEventListener("abort", stop);
      if (!child.hasExited) await child.terminateTree();
    }
  };
}
export async function bootstrap(
  planFile,
  { apply = false, probe = false, signal = new AbortController().signal } = {},
) {
  let ctx;
  try {
    ctx = await preflight(planFile);
  } catch (e) {
    e.bootstrapPhase = "preflight";
    throw e;
  }
  const { p, m, inputs, helpers } = ctx;
  const report = ctx.report;
  if (probe && p.role !== "client") fail("probe_requires_client_role");
  const guard = () => {
    signal.throwIfAborted();
    for (const [file, sha] of inputs)
      if (snapshot(file).sha256 !== sha) fail("concurrent_input_change");
  };
  if (!apply) return report; // no directories, reports, sockets, jobs or config written
  guard();
  if (ctx.workspace) guardWorkspace(ctx.workspace);
  const tx = new FileTransaction(path.join(p.transactionRoot, "bootstrap-" + randomUUID()));
  report.mode = "apply";
  report.transaction = tx.dir;
  try {
    if (ctx.workspace) {
      report.workspace = applyWorkspace(ctx.workspace, tx, guard);
      report.workspaceRevision = report.workspace.workspaceRevision;
    }
    if (p.role === "workspace") {
      report.states = ["workspace_prepared", "needs_next_wake_proof"];
    } else if (p.role === "target") {
      // Stage the existing updater in an owned directory. Live manifest is switched only by CAS.
      const staged = path.join(tx.dir, "manifest.json");
      atomic(
        staged,
        encode({ ...m, updateSource: p.release.source, updateBranch: p.release.branch }),
      );
      const { ProcessTreeSupervisor } = await import(
        pathToFileURL(path.join(m.repoDir, "src/runner/process-tree.ts")).href
      );
      const tree = new ProcessTreeSupervisor(path.join(tx.dir, "update-runtime"));
      const updated = await checkUpdate(staged, {
        expectedRevision: p.release.expectedRevision,
        beforeStep: guard,
        run: commandRunner(tree, signal, path.join(tx.dir, "update-command.stderr.log")),
      });
      if (
        !["installed", "current"].includes(updated.state) ||
        updated.revision !== p.release.expectedRevision
      )
        fail("approved_update_failed:" + updated.state);
      const next = json(staged);
      runtimePreflight(next.repoDir);
      try {
        policyPreflight(next.repoDir, p.maintenance.policyFile);
      } catch {
        fail("new_release_controller_or_policy_prerequisite_invalid");
      }
      // New release APIs are loaded before modifying the target. No stale launcher into an old release.
      const jobHelper = await import(
        pathToFileURL(path.join(next.repoDir, "scripts/setup-scoped-workspace-job.mjs")).href
      );
      const staging = path.join(tx.dir, "workspace");
      fs.mkdirSync(staging);
      fs.mkdirSync(path.join(staging, "jobs"));
      const prepared = jobHelper.prepareScopedJob({
        workspace: staging,
        config: p.filesystem.configFile,
      });
      guard();
      const jobFile = path.join(p.filesystem.workspace, prepared.script);
      tx.write(
        jobFile,
        fs.readFileSync(path.join(staging, prepared.script)),
        p.filesystem.existingJobSha256 ?? null,
      );
      const active = { ...next, maintenance: p.maintenance };
      guard();
      tx.write(p.manifestFile, encode(active), p.manifestSha256);
      report.installation = {
        revision: next.revision,
        updaterState: updated.state,
        source: sourceState(next.repoDir, next.revision),
      };
      report.sourceRevision = next.revision;
      report.supervisedStart = {
        state: "needs_supervised_start",
        tool: "start_background_job",
        arguments: {
          title: "Scoped workspace",
          script: prepared.script,
          args: [],
          idempotency_key: "bootstrap-scoped-" + hash(fs.readFileSync(jobFile)).slice(0, 20),
        },
        desktop: {
          state: "needs_existing_desktop_supervisor_start",
          command: m.node,
          args: [
            "--experimental-transform-types",
            "--disable-warning=ExperimentalWarning",
            "--import",
            pathToFileURL(path.join(next.repoDir, "test/fixtures/store-ledger/ts-hooks.ts")).href,
            path.join(next.repoDir, "scripts/desktop-supervisor.mjs"),
            "--manifest",
            p.manifestFile,
          ],
          note: "Foreground invocation by the local owner; existing supervisor owns the app. No --startup, no Wake resume.",
        },
        verify: [
          "list_background_jobs: running, not queued",
          "jobs/runs/<returned-id>/scoped-ready.json: listener evidence",
          "client --apply --probe: TLS list/read",
          "fresh maintenance diagnose: loaded app revision; daemon/MCP may remain unknown",
        ],
        maintenanceProbe: {
          tool: "request_maintenance",
          arguments: {
            requestId: randomUUID(),
            target: json(p.maintenance.policyFile).target,
            action: "diagnose",
            release: Object.entries(json(p.maintenance.policyFile).releases).find(
              ([, r]) => r.revision === p.release.expectedRevision,
            )[0],
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
          resultTool: "get_maintenance_result",
          note: "Fresh for five minutes; regenerate requestId/issuedAt/expiresAt before later submission. Requires a diagnostic grant for the actual sender.",
        },
      };
      atomic(path.join(tx.dir, "supervised-start.json"), encode(report.supervisedStart));
    } else {
      const candidate = path.join(tx.dir, "native-candidate.toml");
      await helpers[0].setupWorkspace({
        role: "scoped",
        credential: p.client.credentialFile,
        baseConfig: p.client.nativeConfig,
        output: candidate,
      });
      guard();
      tx.write(p.client.nativeConfig, fs.readFileSync(candidate), p.client.nativeConfigSha256);
      if (probe) {
        const result = await diagnoseScopedWorkspace({
          credential: p.client.credentialFile,
          scope: p.client.scope,
          probe: p.client.probe,
        });
        report.reading = result.status;
        report.probe = result;
        if (result.endpointReadVerified) report.listening = "tls_response_observed";
      }
    }
    report.prepared = true;
    report.configured = p.role !== "workspace";
    atomic(path.join(tx.dir, "report.json"), encode(report));
    return report;
  } catch (e) {
    let state;
    try {
      state = tx.rollback();
    } catch {
      state = { state: "rollback_failed", needsLocalReview: true };
    }
    return {
      ...report,
      prepared: state.state === "rolled_back" ? false : "unknown",
      configured: state.state === "rolled_back" ? false : "unknown",
      state: "apply_failed",
      reason: /^[a-z_]+(?::[A-Za-z0-9_./-]+)?$/.test(e.message)
        ? e.message
        : "bootstrap_operation_refused",
      rollback: state,
      ...(ctx.workspace
        ? {
            workspaceRevision: state.workspace?.workspaceRevision ?? "unknown",
            workspace: {
              state: "apply_failed",
              nextWake: { state: "needs_next_wake_proof", personalityLoaded: "unknown" },
            },
          }
        : {}),
    };
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  let attemptedApply = false;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { values } = parseArgs({
      options: {
        plan: { type: "string" },
        apply: { type: "boolean" },
        probe: { type: "boolean" },
        rollback: { type: "string" },
      },
    });
    if (values.rollback && (values.plan || values.apply || values.probe))
      fail("rollback_exclusive");
    if (values.probe && !values.apply) fail("probe_requires_apply");
    attemptedApply = values.apply === true || !!values.rollback;
    const result = values.rollback
      ? rollback(values.rollback)
      : await bootstrap(absolute(values.plan, "plan"), {
          apply: values.apply,
          probe: values.probe,
          signal: abort.signal,
        });
    console.log(JSON.stringify(result, null, 2));
    if (
      result.state === "apply_failed" ||
      result.state === "rollback_conflict" ||
      (values.probe && result.reading !== "read_succeeded")
    )
      process.exitCode = 1;
  } catch (e) {
    const code = /^[a-z_]+(?::[A-Za-z0-9_./-]+)?$/.test(e.message)
      ? e.message
      : e.code === "ENOENT"
        ? "local_file_missing"
        : "preflight_refused";
    const untouched = e.bootstrapPhase === "preflight" || !attemptedApply;
    console.log(
      JSON.stringify({
        state: untouched ? "preflight_refused" : "operation_refused",
        reason: code,
        mutated: untouched ? false : "unknown",
      }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
