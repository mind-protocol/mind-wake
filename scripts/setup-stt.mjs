/** Install local dictation in the selected profile, without relying on the launcher's PATH. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw Error(
      `Transcription : ${command} a échoué. ${result.stderr || result.error?.message || result.status}`,
    );
  return result.stdout?.trim() ?? "";
}

export function findPython(execute = run, env = process.env) {
  const candidates = [
    ["py", ["-3.12"]],
    ["py", ["-3"]],
    ["python", []],
  ];
  for (const root of [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Python"),
    env.ProgramFiles,
  ]) {
    if (!root || !fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).filter((name) => /^Python3/i.test(name)))
      candidates.push([path.join(root, entry, "python.exe"), []]);
  }
  for (const [command, prefix] of candidates) {
    try {
      return execute(
        command,
        [
          ...prefix,
          "-c",
          "import sys; assert (3, 9) <= sys.version_info[:2] < (3, 14); print(sys.executable)",
        ],
        { timeout: 10_000 },
      );
    } catch {
      /* Try another real interpreter, including installs absent from PATH. */
    }
  }
  return null;
}

export function prepareStt(dataDir, { execute = run, env = process.env, model = "small" } = {}) {
  console.error(
    "Transcription locale : préparation de Python et du modèle (le premier téléchargement peut prendre plusieurs minutes)…",
  );
  dataDir = path.resolve(dataDir);
  const configFile = path.join(dataDir, "voice-input.json");
  const current = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  // Preserve explicit voice configuration, including a Telegram fallback already in use.
  const telegramFile = path.join(dataDir, "telegram.json");
  const telegram = fs.existsSync(telegramFile)
    ? JSON.parse(fs.readFileSync(telegramFile, "utf8"))
    : {};
  const previous = current.transcription?.model ? current.transcription : telegram.transcription;
  const installDir = path.join(dataDir, "installation", "stt");
  fs.mkdirSync(installDir, { recursive: true });
  const python = previous?.model
    ? previous.python || "python"
    : path.join(installDir, "venv", "Scripts", "python.exe");
  if (!previous?.model && !fs.existsSync(python)) {
    let base = findPython(execute, env);
    if (!base) {
      execute(
        "winget",
        [
          "install",
          "--id",
          "Python.Python.3.12",
          "--exact",
          "--source",
          "winget",
          "--scope",
          "user",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
        { stdio: "inherit", timeout: 900_000 },
      );
      base = findPython(execute, env);
    }
    if (!base)
      throw Error(
        "Python introuvable après installation. Installer Python 3.12 puis relancer le même setup.",
      );
    console.error("Transcription locale : création de l’environnement Python isolé…");
    execute(base, ["-m", "venv", path.join(installDir, "venv")], { timeout: 300_000 });
  }
  if (!previous?.model)
    execute(
      python,
      // PyAV 19 removed metadata_errors, still used by faster-whisper 1.2.1.
      // https://github.com/SYSTRAN/faster-whisper/issues/1589
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "faster-whisper==1.2.1",
        "av==18.1.0",
      ],
      { stdio: "inherit", timeout: 900_000 },
    );
  const selectedModel = previous?.model || model;
  const cache = path.join(installDir, "models");
  console.error(
    previous?.model
      ? "Transcription locale : vérification de la configuration existante…"
      : "Transcription locale : téléchargement du modèle et test audio…",
  );
  // Verify offline inference, including audio decoding. Never record a ready config on failure.
  const probe = `import json, sys, tempfile, wave, os
from faster_whisper import WhisperModel, download_model
name, cache, existing = sys.argv[1:]
location = name if existing == 'yes' else download_model(name, cache_dir=cache)
m = WhisperModel(location, device='cpu', compute_type='int8', local_files_only=True)
with tempfile.TemporaryDirectory() as d:
 p = os.path.join(d, 'silence.wav')
 with wave.open(p, 'wb') as w:
  w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(32000))
 segments, info = m.transcribe(p, language='fr', beam_size=1)
 list(segments)
print(json.dumps({'python': sys.executable, 'model': location}))`;
  const verified = JSON.parse(
    execute(python, ["-c", probe, selectedModel, cache, previous?.model ? "yes" : "no"], {
      timeout: 900_000,
    }),
  );
  if (!path.isAbsolute(verified.python) || typeof verified.model !== "string" || !verified.model)
    throw Error("Vérification de transcription invalide ; configuration conservée.");
  if (!previous?.model) {
    const tmp = `${configFile}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          ...current,
          transcription: {
            python: verified.python,
            model: verified.model,
            device: "auto",
            language: "fr",
          },
        },
        null,
        2,
      ) + "\n",
    );
    fs.renameSync(tmp, configFile);
  }
  const result = {
    ready: true,
    preserved: Boolean(previous?.model),
    ...verified,
    configFile: previous?.model && !current.transcription?.model ? telegramFile : configFile,
  };
  fs.writeFileSync(
    path.join(installDir, "status.json"),
    JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2),
  );
  console.error("Transcription locale : modèle chargé et traitement audio vérifié.");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" }, model: { type: "string" } },
  });
  try {
    console.log(
      JSON.stringify(
        prepareStt(
          values["data-dir"] ||
            process.env.MIND_WAKE_DATA_DIR ||
            path.join(process.env.LOCALAPPDATA, "mind-wake"),
          { model: values.model },
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
