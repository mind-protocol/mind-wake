import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramApi, TelegramBridge } from "../services/telegram/bridge.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(
  process.argv[2] ??
    process.env.MIND_WAKE_DATA_DIR ??
    path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mind-wake"),
);
const configFile = path.join(dataDir, "telegram.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (config.enabled !== true) process.exit(0);
if (
  !/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken) ||
  !/^@?[A-Za-z0-9_]+$/.test(config.ownerUsername)
)
  throw Error("Configuration Telegram invalide");
const lock = path.join(dataDir, "telegram.pid");
try {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      process.exit(0);
    } catch {}
  }
  fs.unlinkSync(lock);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir },
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
    }, 300_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("Sous-processus Telegram indisponible"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(Error(`Sous-processus Telegram : échec ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
const cli = async (args, input) =>
  JSON.parse(
    await run(
      process.execPath,
      [path.join(repo, "dist/cli/main.js"), ...args, "--data-dir", dataDir, "--json"],
      input,
    ),
  );
const { conversation } = await import("../desktop/ui/build/conversation.js");
const { externalInboxSyncAllowed } = await import("../dist/communication/external-inbox-policy.js");
const { requestHumanWake } = await import("../dist/daemon/human-wake.js");
const active = () =>
  !stopping &&
  externalInboxSyncAllowed(dataDir) &&
  JSON.parse(fs.readFileSync(configFile, "utf8")).enabled === true;
const bridge = new TelegramBridge({
  dataDir,
  username: config.ownerUsername,
  ownerId: config.ownerId,
  api: new TelegramApi(config.botToken),
  active,
  readThread: async () => {
    const [envelope, helpers] = await Promise.all([
      cli(["messages"]),
      run(process.execPath, [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        path.join(repo, "test/fixtures/store-ledger/ts-hooks.ts"),
        path.join(repo, "services/helpers/helpers-main.ts"),
        "answers",
        "--json",
      ])
        .then(JSON.parse)
        .catch(() => null),
    ]);
    if (!envelope.ok || !envelope.data?.profileId) throw Error("Fil Wake indisponible");
    return conversation(envelope, helpers)?.items ?? [];
  },
  receive: async (text, id) => {
    const result = await cli(["reply", "--idempotency-key", id], text);
    if (!result.ok || result.data?.status === "refused")
      throw Error("Message Telegram non enregistré");
    if (active()) requestHumanWake(dataDir, Date.now());
  },
  transcribe: async (bytes) => {
    if (!config.transcription?.model) throw Error("Modèle vocal local non configuré");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-tg-"));
    try {
      const audio = path.join(temp, "voice.ogg");
      fs.writeFileSync(audio, bytes);
      const result = JSON.parse(
        await run(config.transcription.python ?? "python", [
          path.join(repo, "services/telegram/transcribe.py"),
          audio,
          config.transcription.model,
        ]),
      );
      return result.text;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
  speak:
    config.sendAudio === true
      ? async (text) => {
          const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-tg-tts-"));
          try {
            const input = path.join(temp, "text.txt"),
              wav = path.join(temp, "voice.wav"),
              ogg = path.join(temp, "voice.ogg");
            fs.writeFileSync(input, text);
            await run("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(repo, "services/telegram/speak.ps1"),
              "-InputFile",
              input,
              "-OutputFile",
              wav,
            ]);
            await run(config.ffmpeg ?? "ffmpeg", [
              "-v",
              "error",
              "-y",
              "-i",
              wav,
              "-c:a",
              "libopus",
              "-b:a",
              "32k",
              ogg,
            ]);
            return fs.readFileSync(ogg);
          } finally {
            fs.rmSync(temp, { recursive: true, force: true });
          }
        }
      : undefined,
});
try {
  const me = await bridge.api.call("getMe");
  console.log(`Telegram @${me.username} → @${config.ownerUsername.replace(/^@/, "")}`);
  const loop = async (method) => {
    while (!stopping) {
      try {
        if (!active()) {
          if (method === "incoming") bridge.set("status", "suspended");
          await delay(1500);
          continue;
        }
        if (method === "incoming") bridge.set("status", "active");
        await bridge[method]();
        if (method === "outgoing") await delay(1500);
      } catch (error) {
        const detail = String(error.message ?? error.name)
          .replace(/[0-9]{7,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
          .slice(0, 200);
        console.error(`Telegram ${method} : ${detail}`);
        bridge.set(
          `${method}Error`,
          JSON.stringify({
            at: new Date().toISOString(),
            code: error.telegramCode ?? "local/network",
          }),
        );
        // Only errors authored here are logged; URLs containing credentials never are.
        console.error(
          `Telegram ${method} : synchronisation différée (${error.retryAfter ?? 5}s ; code ${error.telegramCode ?? "local/network"})`,
        );
        await delay(Math.max(5, error.retryAfter ?? 5) * 1000);
      }
    }
  };
  await Promise.all([loop("outgoing"), loop("incoming")]);
} finally {
  bridge.close();
  fs.rmSync(lock, { force: true });
}
