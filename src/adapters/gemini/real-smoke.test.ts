/**
 * Test de fumée RÉEL, désactivé par défaut : appelle le client officiel `gemini` installé,
 * avec la connexion déjà configurée par l'utilisateur. Consomme une requête de son quota.
 * N'est lancé que par `MIND_WAKE_REAL_SMOKE=1` et après feu vert explicite de l'humain.
 *
 * - Sur l'hôte, `--approval-mode default` : en non interactif, toute demande de
 *   confirmation est refusée ; aucun mode sans approbation. Dossier de travail temporaire
 *   et vide, extensions et serveurs MCP désactivés.
 * - Un seul lancement, aucune nouvelle tentative : une erreur d'authentification ou une
 *   limitation fait échouer le test tel quel.
 * - L'adapter n'est pas employé tel quel : son `GEMINI_CLI_HOME` propre à Wake n'a pas de
 *   connexion. Seuls ses arguments et son lecteur de flux le sont. Aucun credential n'est
 *   lu, copié ou journalisé : la CLI les trouve seule dans le profil de l'utilisateur.
 * - La sortie brute est écrite dans `MIND_WAKE_REAL_SMOKE_OUT` si fourni, pour être
 *   expurgée à la main avant de devenir une fixture.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs } from "./config.js";
import { parseStreamLine } from "./protocol.js";

const ENABLED = process.env["MIND_WAKE_REAL_SMOKE"] === "1";
const PROMPT = "Réponds uniquement par le mot OK. N'utilise aucun outil.";

/** Variables nécessaires pour que la CLI retrouve le profil et Node ; aucune autre. */
const PASSED_ENV = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "PATH",
  "Path",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
];

function geminiEntry(): string {
  const explicit = process.env["MIND_WAKE_GEMINI_ENTRY"];
  if (explicit !== undefined) return explicit;
  return path.join(
    process.env["APPDATA"] ?? "",
    "npm",
    "node_modules",
    "@google",
    "gemini-cli",
    "bundle",
    "gemini.js",
  );
}

describe.skipIf(!ENABLED)("Gemini CLI réel (MIND_WAKE_REAL_SMOKE=1)", () => {
  it("répond en stream-json avec statistiques d'usage, sans mode sans approbation", async () => {
    const entry = geminiEntry();
    expect(fs.existsSync(entry)).toBe(true);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-gemini-smoke-"));
    const args = [
      entry,
      ...buildArgs({ prompt: PROMPT, model: "flash", approvalMode: "default" }),
      "--extensions",
      "none",
      "--allowed-mcp-server-names",
      "mindwake-aucun",
    ];
    const env: Record<string, string> = {};
    for (const key of PASSED_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    try {
      const { code, stdout, stderr } = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("error", reject);
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          resolve({ code: exitCode, stdout: out, stderr: err });
        });
      });
      const target = process.env["MIND_WAKE_REAL_SMOKE_OUT"];
      if (target !== undefined) {
        fs.writeFileSync(target, JSON.stringify({ args: args.slice(1), code, stdout, stderr }));
      }
      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map(parseStreamLine);
      expect(code, `sortie ${String(code)} : ${stderr.slice(0, 500)}`).toBe(0);
      expect(events[0]?.kind).toBe("init");
      const result = events.find((event) => event.kind === "result");
      expect(result).toMatchObject({ status: "success" });
      expect(result?.kind === "result" ? result.stats?.totalTokens : 0).toBeGreaterThan(0);
      expect(events.some((event) => event.kind === "tool_use")).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 150_000);
});
