import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramApi, TelegramBridge } from "../services/telegram/bridge.mjs";
import { localTranscriber, runProcess } from "../services/telegram/transcriber.mjs";
import { ownerSpeaker } from "../services/telegram/owner-voice.mjs";
import { synth as neuralSynth } from "../services/tts-local/client.mjs";
import {
  acquireTelegramLock,
  ownsTelegramLock,
  releaseTelegramLock,
} from "./telegram-lock.mjs";

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
if (!acquireTelegramLock(lock)) process.exit(0);
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
const { workspaceDirFor } = await import("../dist/daemon/paths.js");
const { routeTelegramHandle } = await import("../dist/communication/telegram-handle-route.js");
const { TelegramPublic } = await import("../dist/communication/telegram-public.js");
const { routeMarcoHandles } = await import("../dist/communication/telegram-marco-route.js");
const active = () =>
  !stopping &&
  externalInboxSyncAllowed(dataDir) &&
  JSON.parse(fs.readFileSync(configFile, "utf8")).enabled === true;
/** WAV/MP3 → OGG/Opus (format des vocaux Telegram). */
const toOgg = async (input, ogg) =>
  run(config.ffmpeg ?? "ffmpeg", ["-v", "error", "-y", "-i", input, "-c:a", "libopus", "-b:a", "32k", ogg]);
/** Voix locale Windows (speak.ps1) puis ffmpeg. */
const localSpeech = async (text) => {
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
    await toOgg(wav, ogg);
    return fs.readFileSync(ogg);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
/** Voix neuronale locale (services/tts-local, voix de Marco) puis ffmpeg ; rejette si non installée. */
const neuralSpeech = async (text) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-tg-neural-"));
  try {
    const wav = path.join(temp, "voice.wav"),
      ogg = path.join(temp, "voice.ogg");
    fs.writeFileSync(wav, (await neuralSynth("marco", text, { dataDir })).bytes);
    await toOgg(wav, ogg);
    return fs.readFileSync(ogg);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
/** ElevenLabs (clé et voix du profil, lues par services/elevenlabs) puis ffmpeg. */
const elevenLabsSpeech = async (text) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-tg-el-"));
  try {
    const mp3 = path.join(temp, "voice.mp3"),
      ogg = path.join(temp, "voice.ogg");
    // runProcess garde la dernière ligne de stderr (ex. « ElevenLabs est désactivé. ») dans l'erreur.
    await runProcess(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        path.join(repo, "test/fixtures/store-ledger/ts-hooks.ts"),
        path.join(repo, "services/elevenlabs/telegram-voice-main.ts"),
        mp3,
      ],
      { cwd: repo, env: { ...process.env, MIND_WAKE_DATA_DIR: dataDir }, input: text, timeoutMs: 75_000 },
    );
    await toOgg(mp3, ogg);
    return fs.readFileSync(ogg);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
let publicChat = null;
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
  transcribe: localTranscriber(config, repo, runProcess, { dataDir }),
  // Fichiers entrants (photos, documents…) : W/artifacts/inbox-telegram/<date>/ (mandat du 16 nov. 2026).
  inboxDir: () => path.join(workspaceDirFor(dataDir), "artifacts", "inbox-telegram"),
  // « @vox … » : vers le fil de la room ou de l'agent, table relue dans les affectations.
  routeHandle: async (handle, text, id) => routeTelegramHandle(dataDir, handle, text, id),
  // Groupe public : chaque message d'une personne réveille Crypto (NLR, 16 nov. 2026 17:01).
  publicMessage: async (message) => publicChat?.receive(message),
  // Relais du fil (coupé depuis le 16 nov.) : vocal seulement si sendAudio.
  speak: config.sendAudio === true ? localSpeech : undefined,
  // Vocal après chaque telegram_send_owner (NLR, 16 nov. 2026 17:31) ; "ownerVoice": false le coupe.
  ownerSpeak:
    config.ownerVoice === false
      ? null
      : ownerSpeaker({ elevenlabs: elevenLabsSpeech, neural: neuralSpeech, local: localSpeech }),
});
try {
  // Un timeout réseau au démarrage ne doit pas tuer le pont (panne du 17 nov. 2026) : on réessaie.
  let me;
  for (let attempt = 1; ; attempt++) {
    try {
      me = await bridge.api.call("getMe");
      break;
    } catch (error) {
      if (!error?.networkCode || stopping) throw error;
      const wait = Math.min(60_000, 2_000 * attempt);
      console.error(`Telegram getMe : réseau indisponible (${error.networkCode}), nouvel essai dans ${wait / 1000}s`);
      await delay(wait);
    }
  }
  console.log(`Telegram @${me.username} → @${config.ownerUsername.replace(/^@/, "")}`);
  const loop = async (method) => {
    while (!stopping) {
      if (!ownsTelegramLock(lock)) {
        // Another bridge took over telegram.pid: two getUpdates consumers must never coexist.
        console.error("Telegram : verrou repris par un autre pont, arrêt");
        stopping = true;
        break;
      }
      try {
        if (!active()) {
          if (method === "incoming") bridge.set("status", "suspended");
          await delay(1500);
          continue;
        }
        if (method === "incoming") bridge.set("status", "active");
        // NLR, 16 nov. 2026 11:58 : plus de relais systématique du fil vers son Telegram.
        // Présence de telegram-relay.off = relais coupé ; les envois passent par telegram_send_owner.
        if (method === "outgoing" && fs.existsSync(path.join(dataDir, "telegram-relay.off"))) {
          await delay(1500);
          continue;
        }
        if (method === "marcoHandles") {
          // @handles en tête d'un message de Marco à NLR (NLR, 16 nov. 2026 18:04–18:05).
          routeMarcoHandles(dataDir, { log: (line) => console.error(`${new Date().toISOString()} Telegram ${line}`) });
          await delay(3000);
          continue;
        }
        if (method === "publicReplies") {
          await publicChat?.tick();
          await delay(5000);
          continue;
        }
        if (method === "ownerVoices") {
          await bridge.ownerVoices((line) => console.error(`${new Date().toISOString()} Telegram vocal : ${line}`));
          await delay(2000);
          continue;
        }
        await bridge[method]();
        if (method === "outgoing") await delay(1500);
      } catch (error) {
        const detail = String(error.message ?? error.name)
          .replace(/[0-9]{7,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
          .slice(0, 200);
        // Horodaté : sans l'heure, le journal ne permettait pas de dater le gel du 16 nov. 2026.
        console.error(`${new Date().toISOString()} Telegram ${method} : ${detail}`);
        try {
          bridge.set(
            `${method}Error`,
            JSON.stringify({
              at: new Date().toISOString(),
              code: error.telegramCode ?? "local/network",
              ...(error.networkCode ? { network: error.networkCode } : {}),
            }),
          );
        } catch (stateError) {
          // Base pleine ou verrouillée (SQLITE_FULL vu le 16 nov.) : la boucle continue au lieu de tomber.
          console.error(`Telegram ${method} : état non écrit (${stateError.code ?? stateError.name})`);
        }
        // Only errors authored here are logged; URLs containing credentials never are.
        console.error(
          `Telegram ${method} : synchronisation différée (${error.retryAfter ?? 5}s ; code ${error.telegramCode ?? "local/network"})`,
        );
        await delay(Math.max(5, error.retryAfter ?? 5) * 1000);
      }
    }
  };
  // Réponses de Crypto postées dans le groupe public, sous les gardes de telegram-public.ts.
  // "publicChannel": false dans telegram.json coupe ce chemin.
  if (config.publicChannel !== false)
    publicChat = new TelegramPublic(dataDir, {
      chat: typeof config.channel === "string" ? config.channel : "@mindprotocol_ai",
      api: bridge.api,
      ownerChat: () => bridge.get("chat"),
      ownerUser: () => bridge.get("user"),
      log: (line) => console.error(`${new Date().toISOString()} Telegram ${line}`),
    });
  await Promise.all([loop("outgoing"), loop("incoming"), loop("ownerVoices"), loop("publicReplies"), loop("marcoHandles")]);
} finally {
  publicChat?.close();
  bridge.close();
  releaseTelegramLock(lock);
}
