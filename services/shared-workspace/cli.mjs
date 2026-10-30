import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { grant, revoke, loadState, createWorkspaceServer, callWorkspace } from "./workspace.mjs";

const {
  positionals: [command],
  values: args,
} = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    root: { type: "string" },
    "data-root": { type: "string", multiple: true },
    participant: { type: "string" },
    propose: { type: "boolean" },
    credential: { type: "string" },
    capability: { type: "string" },
    endpoint: { type: "string" },
    ca: { type: "string" },
    key: { type: "string" },
    cert: { type: "string" },
    port: { type: "string" },
    request: { type: "string" },
    output: { type: "string" },
  },
});
const requireArg = (name) => {
  if (!args[name]) throw new Error(`missing_${name}`);
  return args[name];
};
try {
  switch (command) {
    case "grant": {
      for (const name of ["state", "root", "participant", "credential", "endpoint", "ca"])
        requireArg(name);
      const endpoint = new URL(args.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/v1/workspace"
      )
        throw new Error("invalid_endpoint");
      fs.accessSync(args.ca, fs.constants.R_OK);
      const credentialPath = path.join(
        fs.realpathSync.native(path.dirname(path.resolve(args.credential))),
        path.basename(args.credential),
      );
      const roots = [path.resolve(args.root)];
      if (fs.existsSync(args.state)) roots.push(...loadState(args.state).grants.map((g) => g.root));
      for (const root of roots) {
        const relative = path.relative(root, credentialPath);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
          throw new Error("credential_inside_shared_folder");
      }
      // Reserve credential output before creating any permission; never print its contents.
      const fd = fs.openSync(requireArg("credential"), "wx", 0o600);
      try {
        const credential = grant(
          requireArg("state"),
          requireArg("root"),
          requireArg("participant"),
          args.propose,
          { dataRoots: args["data-root"] ?? [] },
        );
        fs.writeFileSync(
          fd,
          JSON.stringify(
            { ...credential, endpoint: requireArg("endpoint"), caFile: requireArg("ca") },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            capability: credential.capability,
            rights: args.propose ? ["read", "propose"] : ["read"],
          }),
        );
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    case "revoke":
      revoke(requireArg("state"), requireArg("capability"));
      console.log("revoked");
      break;
    case "serve": {
      const port = Number(requireArg("port"));
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
      const server = createWorkspaceServer({
        stateFile: requireArg("state"),
        key: fs.readFileSync(requireArg("key")),
        cert: fs.readFileSync(requireArg("cert")),
      });
      // v0 explicitly stays loopback; no public listener, tunnel or firewall changes.
      server.listen(port, "127.0.0.1", () =>
        console.log(JSON.stringify({ listening: "127.0.0.1", port: server.address().port })),
      );
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => {
          server.closeAllConnections();
          server.close();
        });
      break;
    }
    case "call": {
      const credential = JSON.parse(fs.readFileSync(requireArg("credential"), "utf8"));
      const result = await callWorkspace(
        { ...credential, ca: fs.readFileSync(credential.caFile) },
        JSON.parse(fs.readFileSync(requireArg("request"), "utf8")),
      );
      // File bodies/proposed code go only to explicitly chosen output, never logs/stdout.
      fs.writeFileSync(requireArg("output"), JSON.stringify(result, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      console.log("result_saved");
      break;
    }
    default:
      console.log(
        "Commands: grant --state --root [--data-root LOCAL_INSTALLATION_DATA_DIR] --participant [--propose] --credential --endpoint --ca; revoke --state --capability; serve --state --key --cert --port; call --credential --request --output",
      );
  }
} catch {
  // Avoid TLS/filesystem/parse errors leaking local paths or untrusted request bodies.
  console.error("workspace_command_failed (check arguments, permissions and local configuration)");
  process.exitCode = 1;
}
