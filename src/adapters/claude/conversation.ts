/**
 * Continuité de conversation Claude Code entre deux réveils : identifiant fixé par le
 * daemon (`--session-id`, UUID exigé par le CLI), puis `--resume` du même identifiant.
 * Le prompt système n'est pas rangé dans la session Claude : il accompagne chaque appel
 * (`--system-prompt-file`) ; son empreinte dit quand il a changé et quel fichier écrire.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** État d'une conversation, conservé côté daemon ; aucun contenu de la conversation. */
export interface ClaudeConversationRecord {
  /** Clé stable choisie par le daemon (expérience, agent) ; défaut : la session Wake. */
  readonly key: string;
  /** Incrémentée quand une reprise est impossible : nouvelle conversation, même clé. */
  readonly generation: number;
  /** `true` dès que le CLI a confirmé la session (`system/init`) : la suite est `--resume`. */
  readonly started: boolean;
  /** Empreinte du dernier prompt système transmis. */
  readonly promptDigest: string | null;
}

/** Stockage des conversations ; le daemon fournit une implémentation persistante. */
export interface ClaudeConversationStore {
  get(key: string): ClaudeConversationRecord | null;
  put(record: ClaudeConversationRecord): void;
}

export class MemoryConversationStore implements ClaudeConversationStore {
  readonly #records = new Map<string, ClaudeConversationRecord>();

  get(key: string): ClaudeConversationRecord | null {
    return this.#records.get(key) ?? null;
  }

  put(record: ClaudeConversationRecord): void {
    this.#records.set(record.key, record);
  }
}

export function freshConversation(key: string, generation = 0): ClaudeConversationRecord {
  return { key, generation, started: false, promptDigest: null };
}

/**
 * UUID déterministe (format version 4, variante RFC) dérivé de la clé et de la génération :
 * le même réveil retrouve toujours la même session sans dépendre d'un état du CLI.
 */
export function claudeSessionUuid(key: string, generation: number): string {
  const bytes = createHash("sha256")
    .update(`mind-wake/claude/${key}#${String(generation)}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Écrit le prompt système dans `dir` sous un nom dérivé de son empreinte, seulement s'il
 * est absent (écriture puis renommage) : un prompt inchangé n'est jamais réécrit, deux
 * réveils concurrents publient le même fichier.
 */
export function writePromptFile(dir: string, prompt: string, digest: string): string {
  const target = path.join(dir, `system-prompt-${digest.slice(0, 16)}.md`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  fs.writeFileSync(temp, prompt, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temp, target);
  return target;
}
