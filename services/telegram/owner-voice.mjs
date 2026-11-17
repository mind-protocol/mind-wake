/**
 * Vocal après chaque message au propriétaire (NLR, 16 nov. 2026 17:31 : « quand tu m'envoies un
 * message telegram, ça envoie aussi un text-to-speech, qui passe par ElevenLabs ou sinon à défaut
 * par un modèle local »). telegram_send_owner écrit le texte dans channel_outgoing (channel
 * 'owner') ; le pont lit ces lignes, synthétise et envoie un vocal, une fois par clé.
 */

export const SPOKEN_MAX = 1500;
export const PROVIDER_TIMEOUT_MS = 60_000;

const FILE_EXT =
  "mjs|cjs|js|ts|tsx|json|jsonl|md|py|ps1|sh|txt|sqlite|db|log|csv|html|css|yaml|yml|toml|png|jpe?g|webp|gif|mp3|ogg|wav|mp4|pdf";

/** Texte lisible à voix haute : sans markdown, puces, liens, chemins ni code ; ~1500 caractères. */
export function spokenText(text, max = SPOKEN_MAX) {
  const lines = String(text ?? "")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(<?[^)]*>?\)/g, "$1")
    .replace(/\b(?:https?|ftp):\/\/[^\s<>]+/g, "")
    .replace(/\bwww\.[^\s<>]+/g, "")
    .replace(/`[^`]*`/g, "")
    // Chemins Windows, absolus, relatifs (avec dossier) et noms de fichier techniques.
    .replace(/(?:^|(?<=[\s("'«]))[A-Za-z]:[\\/][^\s"'»)]*/g, "")
    .replace(/(?:^|(?<=[\s("'«]))(?:~|\.{1,2})?[\\/][^\s"'»)]+/g, "")
    .replace(/\b[\w.-]+(?:[\\/][\w.-]+){2,}/g, "")
    .replace(new RegExp(`\\b(?:[\\w.-]+[\\\\/])*[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXT})\\b`, "gi"), "")
    .split("\n")
    .filter((line) => !/^\s*(?:\||<|\[[^\]]+\]:)/.test(line) && !/^\s*[-*_=]{3,}\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•·–—]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\|/g, ", ")
        .replace(/[*#>`]+/g, "")
        .replace(/\(\s*\)|\[\s*\]/g, "")
        .replace(/\s+([,.;:!?…])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  // Une ligne = une phrase : ponctuée pour que la voix marque la pause.
  let spoken = lines.map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`)).join(" ").trim();
  if (spoken.length <= max) return spoken;
  const head = spoken.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("… "));
  if (cut >= max * 0.4) return head.slice(0, cut + 1).trim();
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).replace(/[,;:]$/, "")}…`;
}

/** Délai dur d'un fournisseur. */
function deadline(ms, run) {
  let timer;
  return Promise.race([
    run(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`délai de ${ms} ms dépassé`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const short = (error) =>
  String(error?.message ?? error)
    .replace(/[0-9]{7,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 200);

/** Voix neuronale locale (services/tts-local) : premier chargement GPU + dessin de la voix inclus. */
export const NEURAL_TIMEOUT_MS = 180_000;

/**
 * Chaîne de synthèse : ElevenLabs d'abord, puis voix neuronale locale (Qwen3-TTS/Piper, si
 * installée), puis voix Windows. Chaque fournisseur rend des octets OGG/Opus prêts pour sendVoice.
 * Rejette avec le détail de chaque échec.
 */
export function ownerSpeaker({ elevenlabs, neural, local, timeoutMs = PROVIDER_TIMEOUT_MS, neuralTimeoutMs = NEURAL_TIMEOUT_MS }) {
  return async (text) => {
    const failures = [];
    for (const [provider, run, ms] of [
      ["elevenlabs", elevenlabs, timeoutMs],
      ["neural", neural, neuralTimeoutMs],
      ["local", local, timeoutMs],
    ]) {
      if (typeof run !== "function") continue;
      try {
        const bytes = await deadline(ms, () => run(text));
        if (!bytes || bytes.length === 0) throw Error("audio vide");
        return { bytes, provider, failures };
      } catch (error) {
        failures.push(`${provider}: ${short(error)}`);
      }
    }
    const error = Error(`synthèse impossible (${failures.join(" ; ") || "aucun fournisseur"})`);
    error.failures = failures;
    throw error;
  };
}

export const OWNER_VOICE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS owner_voice(key TEXT PRIMARY KEY,status TEXT NOT NULL,provider TEXT,at TEXT NOT NULL,error TEXT);";
/** Lignes plus anciennes ignorées : un pont relancé après une longue coupure ne rattrape pas tout. */
export const OWNER_VOICE_MAX_AGE_MS = 15 * 60_000;

/**
 * Une passe : chaque message 'owner' envoyé (status 'sent') depuis l'activation, sans vocal,
 * reçoit un vocal. La clé est réservée avant la synthèse : au plus un vocal par message, même
 * après un redémarrage ou un échec (consigné dans owner_voice, jamais renvoyé).
 */
export async function ownerVoicePass({ db, chat, speak, sendVoice, active = () => true, now = () => new Date(), log = () => {} }) {
  db.exec(OWNER_VOICE_SCHEMA);
  db.exec(
    "CREATE TABLE IF NOT EXISTS channel_outgoing(key TEXT PRIMARY KEY,channel TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);",
  );
  const state = (key) => db.prepare("SELECT value FROM state WHERE key=?").get(key)?.value;
  let since = state("ownerVoiceSince");
  if (!since) {
    // Activation : seuls les messages à venir reçoivent un vocal.
    since = now().toISOString();
    db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run("ownerVoiceSince", since);
  }
  const floor = new Date(now().getTime() - OWNER_VOICE_MAX_AGE_MS).toISOString();
  const rows = db
    .prepare(
      "SELECT o.key,o.text FROM channel_outgoing o WHERE o.channel='owner' AND o.status='sent' AND o.at>=? AND o.at>=? AND NOT EXISTS(SELECT 1 FROM owner_voice v WHERE v.key=o.key) ORDER BY o.at LIMIT 5",
    )
    .all(since, floor);
  const done = [];
  const mark = (key, status, provider, error) =>
    db
      .prepare("UPDATE owner_voice SET status=?,provider=?,error=?,at=? WHERE key=?")
      .run(status, provider ?? null, error ?? null, now().toISOString(), key);
  for (const row of rows) {
    if (!active()) break;
    const reserved = db
      .prepare("INSERT OR IGNORE INTO owner_voice(key,status,at) VALUES(?,'pending',?)")
      .run(row.key, now().toISOString());
    if (reserved.changes !== 1) continue;
    const text = spokenText(row.text);
    if (!text) {
      mark(row.key, "skipped", null, "rien à lire");
      done.push({ key: row.key, status: "skipped" });
      continue;
    }
    let audio;
    try {
      audio = await speak(text);
    } catch (error) {
      mark(row.key, "failed", null, short(error));
      log(`vocal non produit pour ${row.key} : ${short(error)}`);
      done.push({ key: row.key, status: "failed" });
      continue;
    }
    if (!active()) {
      mark(row.key, "skipped", audio.provider, "pause pendant la synthèse");
      break;
    }
    try {
      await sendVoice(chat, audio.bytes);
      mark(row.key, "sent", audio.provider, audio.failures?.length ? audio.failures.join(" ; ") : null);
      done.push({ key: row.key, status: "sent", provider: audio.provider });
    } catch (error) {
      mark(row.key, "failed", audio.provider, `sendVoice: ${short(error)}`);
      log(`vocal non envoyé pour ${row.key} : ${short(error)}`);
      done.push({ key: row.key, status: "failed", provider: audio.provider });
    }
  }
  return done;
}
