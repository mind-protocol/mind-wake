#!/usr/bin/env node
/** Local checkout setup; no downloads, model calls, policy changes or payment. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepareInstallation, desktopExecutable } from "./installation.mjs";
import { ensureHub, nodeArgs, startLocal } from "./start-local.mjs";
class SetupError extends Error {}
const repoDir = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    apply: { type: "boolean" },
    "data-dir": { type: "string" },
    "no-open": { type: "boolean" },
  },
});
const dataDir = path.resolve(
  values["data-dir"] ||
    process.env.MIND_WAKE_DATA_DIR ||
    path.join(process.env.LOCALAPPDATA || "", "mind-wake"),
);
const desktopExe = desktopExecutable(repoDir);
function command(exe, args, env = process.env) {
  const r = spawnSync(exe, args, {
    cwd: repoDir,
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30000,
  });
  if (r.error || r.status !== 0)
    throw new SetupError(
      "Commande locale refusée ou indisponible : " +
        path.basename(exe) +
        " " +
        args.slice(0, 2).join(" "),
    );
  return r.stdout;
}
try {
  if (process.platform !== "win32")
    throw new SetupError("Cette première installation locale cible Windows.");
  if (!fs.existsSync(desktopExe))
    throw new SetupError(
      "Desktop absent : construire le projet (npm run build, npm run desktop:ui, cargo build --manifest-path desktop/src-tauri/Cargo.toml) avant de relancer.",
    );
  if (!fs.existsSync(path.join(repoDir, "dist/cli/main.js")))
    throw new SetupError("Moteur absent : npm run build.");
  const codex = command("where.exe", ["codex.exe"]).trim().split(/\r?\n/)[0];
  const expectedLauncher = path.join(dataDir, "installation/mcp.mjs");
  const existing = spawnSync(codex, ["mcp", "get", "mind-wake", "--json"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  if (existing.status === 0) {
    const entry = JSON.parse(existing.stdout);
    if (
      entry.transport?.type !== "stdio" ||
      entry.transport?.command !== process.execPath ||
      JSON.stringify(entry.transport?.args) !== JSON.stringify([expectedLauncher])
    )
      throw new SetupError(
        "Le MCP mind-wake existe avec une autre configuration. Rien remplacé : choisir le même dossier de données ou résoudre le conflit.",
      );
  }
  if (!values.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          dataDir,
          steps: [
            "préparer le profil sans changer son activation",
            "créer ou réutiliser les deux identités locales",
            "démarrer le hub et vérifier le MCP",
            "enregistrer mind-wake dans Codex sans écraser un autre serveur",
            "ouvrir le desktop sur ce même profil",
          ],
          apply: "npm run setup -- --apply --data-dir " + JSON.stringify(dataDir),
        },
        null,
        2,
      ),
    );
  } else {
    command(process.execPath, [
      path.join(repoDir, "node_modules/typescript/bin/tsc"),
      "-p",
      path.join(repoDir, "tsconfig.build.json"),
    ]);
    const init = JSON.parse(
      command(process.execPath, [
        path.join(repoDir, "dist/cli/main.js"),
        "init",
        "--data-dir",
        dataDir,
        "--json",
      ]),
    );
    if (!init.ok) throw new SetupError("Préparation du profil refusée.");
    const m = prepareInstallation(repoDir, dataDir);
    await ensureHub(m);
    const client = new Client({ name: "mind-wake-setup", version: "0.1.0" });
    try {
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [m.launcher] }),
      );
      const tools = await client.listTools();
      const identity = await client.callTool({ name: "whoami", arguments: {} });
      const state = await client.callTool({ name: "wake_status", arguments: {} });
      if (identity.isError || state.isError)
        throw new SetupError("Connexion MCP ou lecture Wake refusée.");
      if (existing.status !== 0)
        command(codex, ["mcp", "add", "mind-wake", "--", process.execPath, m.launcher]);
      const confirmed = JSON.parse(command(codex, ["mcp", "get", "mind-wake", "--json"]));
      if (JSON.stringify(confirmed.transport?.args) !== JSON.stringify([m.launcher]))
        throw new SetupError("Enregistrement MCP non confirmé.");
      if (!values["no-open"]) await startLocal(m.manifestFile, "desktop");
      const result = {
        mode: "installed-local",
        dataDir,
        engine: { prepared: true, profileState: init.data.profile.state, activationChanged: false },
        mcp: {
          registeredIn: "Codex",
          authenticated: true,
          tools: tools.tools.length,
          newSessionRequired: true,
        },
        desktop: { required: true, present: true, launched: !values["no-open"] },
        runtimeMcpConfig: m.mcpFile,
        manifest: m.manifestFile,
        limits: [
          "installation de développement depuis ce dépôt, pas de paquet public",
          "clés locales sur disque, coffre Windows non livré",
          "aucun réveil ni consentement de policy déclenché par setup",
        ],
      };
      fs.writeFileSync(
        path.join(dataDir, "installation/last-setup.json"),
        JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
      );
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.close();
    }
  }
} catch (error) {
  if (error instanceof SetupError) process.stderr.write(error.message + "\n");
  process.stderr.write(
    "Installation incomplète. Vérifier les prérequis, un éventuel conflit du MCP mind-wake et les journaux du hub. Aucune policy activée.\n",
  );
  process.exitCode = 1;
}
