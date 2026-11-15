/** Engine owner survives closing the desktop; only an explicit owned handoff replaces its child. */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { OwnedRuntime } from "./owned-runtime.mjs";
import { codexRuntimeEnv } from "./installation.mjs";

/**
 * Point d'entrée du moteur. `engineFromSource: true` dans le manifeste (installation de
 * développement) : le moteur tourne depuis src/ avec le chargeur TypeScript des services,
 * sans `npm run build` ; une modification de la logique de réveil demande seulement un
 * redémarrage du moteur. Sinon, le JS compilé de dist/.
 */
export function engineEntry(m) {
  const source = path.join(m.repoDir, "src/cli/main.ts");
  if (m.engineFromSource === true && fs.existsSync(source)) {
    const hooks = path.join(m.repoDir, "test/fixtures/store-ledger/ts-hooks.ts");
    return {
      entry: source,
      args: [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        pathToFileURL(hooks).href,
        source,
      ],
    };
  }
  const entry = path.join(m.repoDir, "dist/cli/main.js");
  return { entry, args: [entry] };
}
export function createEngineOwner(manifestFile, { daemonArgs = [] } = {}) {
  const owner = new OwnedRuntime(manifestFile, "daemon", async ({ file, instance }) => {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")),
      { entry, args: entryArgs } = engineEntry(m);
    const { ProcessTreeSupervisor } = await import(
      pathToFileURL(path.join(m.repoDir, "dist/runner/process-tree.js")).href
    );
    const tree = new ProcessTreeSupervisor(path.join(m.dataDir, "engine-runtime"));
    const processTree = tree.spawn("owned-engine", randomUUID(), {
      executable: m.node,
      args: [...entryArgs, "daemon", "run", ...daemonArgs],
      cwd: m.repoDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !/(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i.test(k),
          ),
        ),
        ...codexRuntimeEnv(m),
        // Claude sessions receive the MIND MCP (message_owner…) written by the installation.
        ...(fs.existsSync(path.join(path.dirname(manifestFile), "claude-mcp.json"))
          ? {
              MIND_WAKE_CLAUDE_MCP_CONFIG: path.join(path.dirname(manifestFile), "claude-mcp.json"),
            }
          : {}),
        // Debug logs of the Claude CLI, one per session, to diagnose tool stalls.
        MIND_WAKE_CLAUDE_DEBUG_DIR: path.join(m.dataDir, "runtimes", "claude", "debug"),
        MIND_WAKE_DATA_DIR: m.dataDir,
        MIND_WAKE_REPO_DIR: m.repoDir,
        MIND_WAKE_OWNED_RECEIPT: file,
        MIND_WAKE_OWNED_INSTANCE: instance,
        MIND_WAKE_OWNED_ENTRY: entry,
      },
    });
    const pid = await processTree.started();
    const child = new EventEmitter();
    child.pid = pid;
    child.connected = true;
    child.exitCode = null;
    child.send = (message) => processTree.send(JSON.stringify(message));
    child.kill = () => {
      if (processTree.hasExited) return false;
      void processTree.terminateTree();
      return true;
    };
    void (async () => {
      let line;
      while ((line = await processTree.readLine()) !== null) process.stdout.write(line + "\n");
    })();
    void processTree.exited.then((exit) => {
      child.connected = false;
      child.exitCode = exit.mainExitCode;
      child.emit("exit", exit.mainExitCode, null);
    });
    return { child, entry };
  });
  return owner;
}
export async function superviseEngine(manifestFile) {
  const owner = createEngineOwner(manifestFile);
  const stop = () => {
    void owner.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await owner.start();
    await owner.finished;
  } finally {
    await owner.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { manifest: { type: "string" } } });
  if (!values.manifest) throw Error("Manifest required");
  await superviseEngine(path.resolve(values.manifest));
}
