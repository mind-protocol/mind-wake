/**
 * Disjoncteur ElevenLabs durable. Un refus de compte (HTTP 401, 402, quota ou crédits
 * épuisés) coupe toute génération vocale jusqu'à une réactivation humaine explicite :
 * case « Autoriser la génération » cochée de nouveau dans Réglages, ou
 * `mind-wake elevenlabs enable`. Aucun retest ni sonde automatique.
 *
 * L'état vit dans un fichier dédié plutôt que dans `elevenlabs.json` : ce dernier porte
 * la clé API et un schéma strict réécrit par `configure`, et un champ inconnu y rendait
 * toute la configuration illisible.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OwnerMessages } from "./owner-messages.js";

export const ELEVENLABS_CIRCUIT_FILE = "elevenlabs-circuit.json";
export const ELEVENLABS_CONFIG_FILE = "elevenlabs.json";
/** Message renvoyé par chaque chemin de génération tant que le disjoncteur est ouvert. */
export const VOICE_CUT_MESSAGE =
  "ElevenLabs : voix coupée : crédits ElevenLabs épuisés, réactivation manuelle (Réglages > Voix, ou `mind-wake elevenlabs enable`).";
/** Même agent que la réponse rapide : l'avis apparaît dans le fil principal du desktop. */
const NOTICE_AGENT_ID = "claude-wake";

export interface ElevenLabsCircuit {
  readonly open: true;
  readonly reason: string;
  readonly status: number | null;
  readonly code?: string;
  readonly at: string;
  readonly notified?: "owner_message" | "errors_log";
}

const circuitFile = (dir: string) => path.join(dir, ELEVENLABS_CIRCUIT_FILE);
const errorsFile = (dir: string) => path.join(dir, "elevenlabs-audio", "errors.jsonl");

/** Fichier présent mais illisible : traité comme ouvert, jamais comme une autorisation. */
export function readElevenLabsCircuit(dir: string): ElevenLabsCircuit | null {
  let raw: string;
  try {
    raw = fs.readFileSync(circuitFile(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<ElevenLabsCircuit>;
    return {
      open: true,
      reason: typeof value.reason === "string" ? value.reason : "état illisible",
      status: typeof value.status === "number" ? value.status : null,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      at: typeof value.at === "string" ? value.at : "",
      ...(value.notified ? { notified: value.notified } : {}),
    };
  } catch {
    return { open: true, reason: "état illisible", status: null, at: "" };
  }
}

/** Refus de compte qui ne se résoudra pas seul : la prochaine tentative serait aussi payante ou vaine. */
export function accountRefusal(status: number, code?: string): string | undefined {
  if (code && /quota|credit|payment|insufficient|limit_reached/i.test(code))
    return `crédits ElevenLabs épuisés (${code})`;
  if (status === 401) return "HTTP 401 : clé refusée ou crédits épuisés";
  if (status === 402) return "HTTP 402 : paiement requis, crédits épuisés";
  return undefined;
}

export function appendElevenLabsError(
  dir: string,
  entry: { status: number | null; message: string; code?: string; event?: string },
): void {
  try {
    fs.mkdirSync(path.dirname(errorsFile(dir)), { recursive: true });
    fs.appendFileSync(
      errorsFile(dir),
      JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Le journal d'erreurs ne doit jamais masquer l'erreur d'origine.
  }
}

/**
 * Ouvre le disjoncteur. Seul le premier processus qui crée le fichier publie l'avis :
 * deux générations concurrentes refusées ne produisent qu'un message.
 */
export function openElevenLabsCircuit(
  dir: string,
  trip: { status: number | null; reason: string; code?: string },
  notify: (text: string, key: string) => void = publishNotice(dir),
): boolean {
  const at = new Date().toISOString();
  const circuit = {
    open: true as const,
    reason: trip.reason,
    status: trip.status,
    ...(trip.code ? { code: trip.code } : {}),
    at,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(circuitFile(dir), JSON.stringify(circuit), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  const text = `Voix coupée : ${trip.reason}. Plus aucun appel ElevenLabs (lecture auto, speak_desktop, forks) jusqu'à réactivation manuelle : recocher « Autoriser la génération vocale » dans Réglages > Voix, ou \`mind-wake elevenlabs enable\`.`;
  let notified: "owner_message" | "errors_log" = "errors_log";
  try {
    notify(text, `elevenlabs-circuit:${at}`);
    notified = "owner_message";
  } catch {
    // Messagerie indisponible : l'avis reste dans errors.jsonl et dans le statut.
  }
  appendElevenLabsError(dir, {
    event: "circuit_open",
    status: trip.status,
    message: text,
    ...(trip.code ? { code: trip.code } : {}),
  });
  fs.writeFileSync(circuitFile(dir), JSON.stringify({ ...circuit, notified }), { mode: 0o600 });
  return true;
}

function publishNotice(dir: string) {
  return (text: string, key: string) => {
    const messages = new OwnerMessages(dir, NOTICE_AGENT_ID);
    try {
      messages.publish(text, key);
    } finally {
      messages.close();
    }
  };
}

/** Réservé à une action humaine (Réglages ou CLI) ; jamais appelé par un chemin automatique. */
export function closeElevenLabsCircuit(dir: string, by: "settings" | "cli"): boolean {
  const was = readElevenLabsCircuit(dir);
  if (!was) return false;
  fs.rmSync(circuitFile(dir), { force: true });
  appendElevenLabsError(dir, {
    event: "circuit_closed",
    status: null,
    message: `Voix réactivée manuellement (${by}).`,
  });
  return true;
}

const CONFIG_KEYS = ["version", "enabled", "apiKey", "voiceId", "autoplay", "transcriptionEnabled"];

/**
 * `mind-wake elevenlabs enable` : ferme le disjoncteur et remet `enabled:true`, sans
 * aucun appel réseau. Seuls les champs connus de la configuration sont conservés.
 */
export function enableElevenLabs(dir: string): { enabled: true; circuitClosed: boolean } {
  const file = path.join(dir, ELEVENLABS_CONFIG_FILE);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw Error("ElevenLabs : configuration absente ou illisible ; utiliser Réglages > Voix.");
  }
  if (typeof config["apiKey"] !== "string" || !config["apiKey"] || typeof config["voiceId"] !== "string" || !config["voiceId"])
    throw Error("ElevenLabs : clé API et voix requises ; utiliser Réglages > Voix.");
  const next = Object.fromEntries(CONFIG_KEYS.filter((key) => key in config).map((key) => [key, config[key]]));
  next["enabled"] = true;
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  return { enabled: true, circuitClosed: closeElevenLabsCircuit(dir, "cli") };
}

export function elevenLabsCircuitStatus(dir: string): {
  enabled: boolean | null;
  circuit: ElevenLabsCircuit | null;
} {
  let enabled: boolean | null = null;
  try {
    const value = (JSON.parse(fs.readFileSync(path.join(dir, ELEVENLABS_CONFIG_FILE), "utf8")) as { enabled?: unknown }).enabled;
    if (typeof value === "boolean") enabled = value;
  } catch {
    // Absent ou illisible : statut inconnu.
  }
  return { enabled, circuit: readElevenLabsCircuit(dir) };
}
