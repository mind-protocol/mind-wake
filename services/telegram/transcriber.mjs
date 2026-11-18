/**
 * Transcription locale des vocaux Telegram (sidecar Python `transcribe.py`, faster-whisper),
 * extraite de scripts/telegram-bridge.mjs pour être éprouvée telle quelle sur un vrai fichier
 * (mandat du 16 nov. 2026, point 5). `config` est la configuration du bridge (telegram.json) :
 * sont lus `transcription.python`, `transcription.model` et, en option, `device`, `computeType`,
 * `gpuModel`, `language`, `initialPrompt` (voir transcribe.py ; absents = comportement par défaut).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readSttVocabulary, whisperHotwordArguments } from "../voice/stt-vocabulary.mjs";

/** Lance un sous-processus ; rejette avec un message court (fin de stderr) en cas d'échec. */
export function runProcess(command, args, { cwd, env, input, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      out += data;
    });
    child.stderr.on("data", (data) => {
      err += data;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Sous-processus Telegram : délai dépassé"));
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("Sous-processus Telegram indisponible"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      // Dernière ligne utile de stderr (ex. « RuntimeError: Aucune parole reconnue »), sans chemin long.
      const last = err.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      reject(Error(`Sous-processus Telegram : échec ${code}${last ? ` — ${last.slice(0, 160)}` : ""}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** Options facultatives de `transcription` → arguments de transcribe.py. */
export function transcriptionOptionArguments(transcription = {}) {
  const flags = { device: "--device", computeType: "--compute-type", gpuModel: "--gpu-model", language: "--language", initialPrompt: "--initial-prompt" };
  return Object.entries(flags).flatMap(([key, flag]) => (typeof transcription[key] === "string" ? [flag, transcription[key]] : []));
}

/**
 * Fonction `transcribe(bytes)` du bridge : OGG/Opus → texte. Avec `dataDir`, le vocabulaire du
 * profil (stt-vocabulary.json, relu à chaque vocal) biaise Whisper (`hotwords`).
 */
export function localTranscriber(config, repo, run = runProcess, { dataDir } = {}) {
  return async (bytes) => {
    if (!config.transcription?.model) throw Error("Modèle vocal local non configuré");
    const vocabulary = dataDir ? readSttVocabulary(dataDir) : null;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-tg-"));
    try {
      const audio = path.join(temp, "voice.ogg");
      fs.writeFileSync(audio, bytes);
      const result = JSON.parse(
        await run(
          config.transcription.python ?? "python",
          [
            path.join(repo, "services/telegram/transcribe.py"), audio, config.transcription.model,
            ...(vocabulary ? whisperHotwordArguments(vocabulary) : []),
            ...transcriptionOptionArguments(config.transcription),
          ],
          { cwd: repo },
        ),
      );
      return result.text;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
}
