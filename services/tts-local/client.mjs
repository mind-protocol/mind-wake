/**
 * Voix locale neuronale pour tous les agents (NLR, 16 nov. 2026 17:54 : « la vraie voix locale
 * pour VOX, pour tout le monde » ; 17:55 : appeler n'importe quel agent et l'entendre avec sa voix).
 *
 * - getVoice(agentId) : voix du registre (voices.json), par id, alias ou nom affiché ; sinon la
 *   voix par défaut. Fonction pure, utilisable sans serveur (page Appel, desktop, pont Telegram).
 * - synth(agentId, text) : WAV produit par le serveur local services/tts-local/server.py
 *   (Qwen3-TTS sur GPU, Piper sur CPU en secours). Désactivé tant que <data>/tts-local.json n'a pas
 *   "enabled": true (écrit par scripts/install-tts-local.ps1).
 *
 * Toutes les voix sont dessinées (description texte) ou des voix de série : aucun clonage de
 * personne réelle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VOICES_FILE = path.join(here, "voices.json");
export const SERVER_SCRIPT = path.join(here, "server.py");
export const DEFAULT_URL = "http://127.0.0.1:8766";
export const SYNTH_TIMEOUT_MS = 90_000;
export const MAX_TEXT = 5000;

const registryCache = new Map();

/** Registre des voix (mis en cache par chemin + date de modification). */
export function loadVoices(file = VOICES_FILE) {
  const mtime = fs.statSync(file).mtimeMs;
  const cached = registryCache.get(file);
  if (cached && cached.mtime === mtime) return cached.registry;
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!registry?.voices?.[registry.default]) throw Error("Registre de voix invalide : voix par défaut absente.");
  registryCache.set(file, { mtime, registry });
  return registry;
}

/** Clé de comparaison : minuscules, sans accents, @ et espaces → tirets. */
export function voiceKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Données du profil (même règle que le pont Telegram). */
export function defaultDataDir() {
  return path.resolve(process.env.MIND_WAKE_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mind-wake"));
}

/**
 * Voix d'un agent : id exact, alias, puis nom affiché (« Orion », « Équinoxe »). Inconnu ou vide
 * → voix par défaut (matched: false). `reference` pointe la référence figée si elle existe.
 */
export function getVoice(agentId, { registry = loadVoices(), dataDir = defaultDataDir() } = {}) {
  const key = voiceKey(agentId);
  const entries = Object.entries(registry.voices);
  const found =
    (key && entries.find(([id]) => voiceKey(id) === key)) ||
    (key && entries.find(([, v]) => (v.aliases ?? []).some((a) => voiceKey(a) === key))) ||
    (key && entries.find(([, v]) => voiceKey(v.name) === key));
  const [id, voice] = found || [registry.default, registry.voices[registry.default]];
  const gender = voice.gender === "male" ? "male" : "female";
  const stored = path.join(dataDir, "tts-local", "voices", `${id}.wav`);
  const reference = voice.reference
    ? path.resolve(dataDir, voice.reference)
    : fs.existsSync(stored)
      ? stored
      : null;
  return {
    id,
    agentId: String(agentId ?? ""),
    matched: Boolean(found),
    name: voice.name ?? id,
    gender,
    lang: voice.lang ?? "fr",
    instruct: voice.instruct,
    refText: voice.refText ?? registry.refText,
    reference,
    piper: voice.piper ?? registry.fallback?.piper?.[gender] ?? null,
    piperEn: registry.fallback?.piper?.en ?? null,
  };
}

/** Toutes les voix connues, pour un sélecteur (page Appel, réglages). */
export function listVoices(options = {}) {
  const registry = options.registry ?? loadVoices();
  return Object.keys(registry.voices).map((id) => getVoice(id, { ...options, registry }));
}

/** Réglages locaux : <data>/tts-local.json. Absent → désactivé. */
export function localTtsConfig(dataDir = defaultDataDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "tts-local.json"), "utf8"));
    return {
      enabled: raw.enabled === true,
      url: typeof raw.url === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(raw.url) ? raw.url : DEFAULT_URL,
      python: typeof raw.python === "string" ? raw.python : null,
      autostart: raw.autostart !== false,
    };
  } catch {
    return { enabled: false, url: DEFAULT_URL, python: null, autostart: false };
  }
}

async function fetchWithTimeout(fetchImpl, url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** État du serveur local, ou null s'il ne répond pas. */
export async function localTtsHealth({ url = DEFAULT_URL, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${url}/health`, {}, timeoutMs);
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

let starting = null;
/** Lance server.py (détaché, sans fenêtre) si absent, puis attend /health (chargement GPU). */
export async function ensureServer(config, { fetchImpl = fetch, spawnImpl = spawn, waitMs = 180_000, pollMs = 1000, dataDir = defaultDataDir() } = {}) {
  if (await localTtsHealth({ url: config.url, fetchImpl })) return true;
  if (!config.autostart || !config.python) return false;
  if (!starting) {
    const port = new URL(config.url).port;
    const child = spawnImpl(config.python, [SERVER_SCRIPT, "serve", "--port", port, "--data-dir", dataDir], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on?.("error", () => {});
    child.unref?.();
    starting = (async () => {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        if (await localTtsHealth({ url: config.url, fetchImpl })) return true;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return false;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

/**
 * WAV de `text` avec la voix de `agentId`. Rejette si la voix locale est désactivée ou absente :
 * l'appelant passe au fournisseur suivant (Windows SAPI pour Telegram).
 */
export async function synth(agentId, text, options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  const config = options.config ?? localTtsConfig(dataDir);
  if (!config.enabled) throw Error("voix locale neuronale non installée (tts-local.json)");
  const body = String(text ?? "").trim();
  if (!body) throw Error("texte vide");
  if (body.length > MAX_TEXT) throw Error(`texte trop long (${body.length} > ${MAX_TEXT})`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const ready = await (options.ensure ?? ensureServer)(config, { fetchImpl, dataDir });
  if (!ready) throw Error("serveur de voix locale indisponible");
  const voice = getVoice(agentId, { registry: options.registry, dataDir });
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.url}/synth`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body, lang: options.lang ?? voice.lang, voice }),
    },
    options.timeoutMs ?? SYNTH_TIMEOUT_MS,
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw Error(`voix locale HTTP ${response.status}${detail ? ` : ${detail}` : ""}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("latin1") !== "RIFF") throw Error("réponse audio locale invalide");
  return { bytes, voice, engine: response.headers.get("x-tts-engine") ?? "local" };
}
