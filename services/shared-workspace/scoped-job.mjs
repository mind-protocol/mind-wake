/** Owner-only server imported in a Wake job process; no child or automatic restart. */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { privateFile } from "../../scripts/setup-shared-workspace.mjs";
import { createScopedWorkspaceServer, loadState } from "./workspace.mjs";

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function readScopedJobConfig(file) {
  file = privateFile(file);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const stateFile = privateFile(config.stateFile);
  const keyFile = privateFile(config.keyFile);
  const certFile = privateFile(config.certFile);
  // Every retained grant matters, including revoked grants and legacy roots.
  for (const { root } of loadState(stateFile).grants) {
    for (const target of [file, stateFile, `${stateFile}.private`, keyFile, certFile])
      if (inside(root, target)) throw new Error("private_file_inside_scope");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error("invalid_port");
  // Explicit operator-selected interface. No tunnel, DNS, firewall or route is created.
  if (
    typeof config.host !== "string" ||
    !config.host ||
    ["0.0.0.0", "::", "*"].includes(config.host)
  )
    throw new Error("explicit_host_required");
  return { stateFile, keyFile, certFile, host: config.host, port: config.port };
}

export async function runScopedWorkspaceJob(file) {
  const job = process.env.MIND_WAKE_JOB_ID;
  const output = process.env.MIND_WAKE_JOB_OUTPUT;
  if (!/^job_[0-9a-f-]{36}$/.test(job ?? "") || !output || !path.isAbsolute(output))
    throw new Error("supervised_wake_job_required");
  const config = readScopedJobConfig(file);
  const controller = new AbortController();
  const server = createScopedWorkspaceServer({
    stateFile: config.stateFile,
    key: fs.readFileSync(config.keyFile),
    cert: fs.readFileSync(config.certFile),
    signal: controller.signal,
  });
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    server.listen(config.port, config.host);
    await once(server, "listening");
    // Non-secret readiness evidence for the owner. Never publish config/state/tokens.
    fs.writeFileSync(
      path.join(output, "scoped-ready.json"),
      JSON.stringify({
        job,
        pid: process.pid,
        host: config.host,
        port: server.address().port,
        route: "/v1/scoped-workspace",
      }),
      { flag: "wx", mode: 0o600 },
    );
    await once(server, "close");
  } finally {
    stop();
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
  }
}
