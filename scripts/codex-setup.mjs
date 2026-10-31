/** Codex prerequisites. No shell, auth cache access, model call or daemon activation. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { discoverCodex } from "../dist/adapters/codex/executable.js";
import { checkCodexCompatibility } from "../dist/adapters/codex/compatibility.js";
import { parseCodexVersion } from "../dist/adapters/codex/protocol.js";

/** Bounded process, fixed argv, no shell. Raw provider output is never included in errors. */
export function runProcess(
  executable,
  args,
  { env = process.env, timeout = 30000, signal, interactive = false } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Commande annulée ; relancer setup pour reprendre."));
    const child = spawn(executable.path, [...(executable.prefixArgs ?? []), ...args], {
      env,
      shell: false,
      windowsHide: !interactive,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      failed = false,
      settled = false;
    let treeUnconfirmed = false;
    const stopError = (reason) =>
      Error(
        reason +
          (treeUnconfirmed
            ? " Arrêt de l’arborescence non confirmé ; vérifier les processus locaux avant de reprendre."
            : ""),
      );
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal?.removeEventListener("abort", cancel);
      if (error) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        reject(error);
      } else resolve(result);
    };
    let stopTimer;
    const stop = (reason) => {
      if (failed || settled) return;
      failed = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          path.join(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false },
        );
        killer.unref();
        killer.on("error", () => {
          treeUnconfirmed = true;
          child.kill();
        });
        killer.once("exit", (code) => {
          if (code !== 0) {
            treeUnconfirmed = true;
            child.kill();
          }
        });
        const killerDeadline = setTimeout(() => {
          treeUnconfirmed = true;
          killer.kill();
          child.kill();
        }, 1500);
        killer.once("close", () => clearTimeout(killerDeadline));
      } else child.kill("SIGKILL");
      stopTimer = setTimeout(() => {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(
          Error(
            reason +
              " Arrêt du processus non confirmé ; vérifier les processus locaux avant de reprendre.",
          ),
        );
      }, 5000);
      child.once("close", () => finish(stopError(reason)));
    };
    const cancel = () => stop("Commande annulée ; relancer setup pour reprendre.");
    const timer = setTimeout(
      () => stop("Délai dépassé ; vérifier réseau/droits puis relancer setup."),
      timeout,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024)
        stop("Sortie de commande excessive ; installation interrompue.");
    });
    // Drain stderr without storing it: status may print account information or secrets.
    child.stderr?.resume();
    child.once("error", () =>
      finish(Error("Processus indisponible ; vérifier Node/npm, PATH et droits d’exécution.")),
    );
    child.once("close", (code, signalName) => {
      if (!failed) finish(null, { status: code, signal: signalName, stdout });
    });
  });
}

export function findNpm(env = process.env) {
  const dirs = [
    path.dirname(process.execPath),
    ...(env.PATH || env.Path || "").split(path.delimiter),
  ];
  for (const dir of dirs.filter(Boolean)) {
    const script = path.join(dir, "node_modules/npm/bin/npm-cli.js");
    if (fs.existsSync(script)) return { path: process.execPath, prefixArgs: [script] };
  }
  throw Error(
    "npm absent : installer Node/npm depuis nodejs.org, rouvrir le terminal puis relancer npm run setup -- --apply. Aucun téléchargement Codex effectué.",
  );
}

export function codexEnvironment(env = process.env, home) {
  return {
    ...env,
    CODEX_HOME: path.resolve(home || env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  };
}

export async function prepareCodex(
  {
    apply = false,
    login = false,
    noOpen = false,
    noninteractive = false,
    env = process.env,
    signal,
  } = {},
  dependencies = {},
) {
  const discover = dependencies.discover ?? discoverCodex;
  const run = dependencies.run ?? runProcess;
  const check = dependencies.check ?? checkCodexCompatibility;
  const npm = dependencies.npm ?? findNpm;
  let executable = discover(env);
  if (!apply)
    return {
      mode: "plan",
      found: !!executable,
      executable,
      codexHome: env.CODEX_HOME,
      steps: [
        executable
          ? "réutiliser Codex et vérifier son protocole"
          : "installer Codex officiel avec npm install --global @openai/codex@latest puis vérifier le binaire",
        "vérifier codex login status ; connexion humaine seulement avec --login dans un terminal",
      ],
    };
  if (!executable) {
    if (env.MIND_WAKE_CODEX_BIN)
      throw Error(
        "MIND_WAKE_CODEX_BIN ne désigne pas un Codex utilisable. Corriger ce chemin avant de reprendre ; aucune réinstallation automatique.",
      );
    const npmExe = npm(env);
    const installed = await run(
      npmExe,
      ["install", "--global", "@openai/codex@latest", "--no-audit", "--no-fund"],
      { env, timeout: 180000, signal },
    );
    if (installed.status !== 0)
      throw Error(
        "Installation Codex refusée par npm. Vérifier réseau/proxy, droits du préfixe npm et Node/npm ; puis relancer setup --apply. Aucune configuration Wake activée.",
      );
    executable = discover(env);
    if (!executable) {
      const prefix = await run(npmExe, ["prefix", "--global"], { env, signal });
      if (prefix.status === 0 && prefix.stdout.trim() && !/[\r\n\0]/.test(prefix.stdout.trim()))
        executable = discover({
          ...env,
          PATH: prefix.stdout.trim() + path.delimiter + (env.PATH || env.Path || ""),
        });
    }
    if (!executable)
      throw Error(
        "npm terminé mais Codex introuvable. Vérifier npm prefix --global et PATH, rouvrir le terminal puis relancer setup --apply.",
      );
  }
  const versionResult = await run(executable, ["--version"], { env, signal });
  const version =
    versionResult.status === 0 ? parseCodexVersion(versionResult.stdout.trim()) : null;
  if (!version)
    throw Error(
      "Version Codex illisible ou commande refusée. Vérifier le chemin du binaire officiel ; aucune configuration Wake modifiée.",
    );
  const compatibility = await check(executable);
  const status = await run(executable, ["login", "status"], { env, signal });
  if (status.status !== 0) {
    const resume =
      "Dans un terminal visible, reprendre avec npm run setup -- --apply --login (même --codex-home, --data-dir et options). La connexion se fait dans le navigateur officiel ; aucun secret à copier dans le chat.";
    if (
      !login ||
      noOpen ||
      noninteractive ||
      !(dependencies.isInteractive ?? (() => process.stdin.isTTY && process.stdout.isTTY))()
    )
      throw Error("Codex n’est pas connecté, ou son statut est indisponible. " + resume);
    const result = await run(executable, ["login"], {
      env,
      signal,
      interactive: true,
      timeout: 300000,
    });
    if (result.status !== 0) throw Error("Connexion Codex annulée ou échouée. " + resume);
    const after = await run(executable, ["login", "status"], { env, signal });
    if (after.status !== 0) throw Error("Connexion Codex non confirmée après login. " + resume);
  }
  return { executable, version, compatibility, codexHome: env.CODEX_HOME, authenticated: true };
}
