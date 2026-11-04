import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureWakeScreenshot } from "../../dist/daemon/wake-screenshot.js";
import { externalInboxSyncAllowed } from "../../dist/communication/external-inbox-policy.js";
import { compactScreenshot } from "./compact-image.mjs";
const dir =
  process.env.MIND_WAKE_DATA_DIR ??
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mind-wake");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 6_000_000) throw Error("Audio trop volumineux");
}
try {
  const request = JSON.parse(input);
  if (!externalInboxSyncAllowed(dir))
    throw Error("Dictée suspendue : Wake est en pause ou arrêté.");
  let data;
  if (request.action === "snapshot") {
    const image = await captureWakeScreenshot("primary");
    if (!image) throw Error("Capture de l’écran principal indisponible.");
    const bytes = await compactScreenshot(image.base64);
    data = { base64: bytes.toString("base64"), capturedAt: image.capturedAt, bytes: bytes.length };
  } else if (request.action === "transcribe") {
    if (
      typeof request.audio !== "string" ||
      request.audio.length > 5_500_000 ||
      !/^[-A-Za-z0-9+/=]+$/.test(request.audio)
    )
      throw Error("Audio invalide");
    let config;
    for (const name of ["voice-input.json", "telegram.json"]) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (value.transcription?.model) {
          config = value.transcription;
          break;
        }
      } catch {}
    }
    if (!config) throw Error("Configurer un modèle de transcription local dans voice-input.json.");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wake-dictation-"));
    try {
      const file = path.join(temp, "voice.webm");
      fs.writeFileSync(file, Buffer.from(request.audio, "base64"));
      data = await new Promise((resolve, reject) => {
        const child = spawn(
          config.python ?? "python",
          [path.join(repo, "services/telegram/transcribe.py"), file, config.model, "--allow-empty"],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (part) => {
          out += part;
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("Transcription trop longue."));
        }, 120_000);
        child.on("error", () => {
          clearTimeout(timer);
          reject(Error("Transcription locale indisponible."));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(Error("Échec de la transcription locale."));
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(Error("Transcription invalide."));
          }
        });
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } else throw Error("Action vocale inconnue.");
  console.log(JSON.stringify({ ok: true, data }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { message: error.message } }));
  process.exitCode = 1;
}
