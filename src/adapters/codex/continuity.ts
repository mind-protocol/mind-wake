/**
 * Continuité d'un agent Codex entre réveils : identifiant du fil (`thread.id`) persisté,
 * et empreinte du prompt système pour ne le réinjecter que s'il a changé. Le fil n'est
 * qu'un confort : la reprise de référence reste la mémoire et les checkpoints de Wake ;
 * un fil perdu ou refusé repart d'un fil neuf.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UtcTimestamp } from "../../contracts/index.js";

export interface ThreadRecord {
  readonly threadId: string;
  /** Empreinte SHA-256 du prompt système transmis à ce fil. */
  readonly promptFingerprint: string;
  readonly updatedAt: UtcTimestamp;
}

/** Stockage des fils, hors de l'espace d'exploration (l'agent ne doit pas le réécrire). */
export interface ThreadStore {
  load(key: string): ThreadRecord | null;
  save(key: string, record: ThreadRecord): void;
  forget(key: string): void;
}

export function promptFingerprint(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

export class MemoryThreadStore implements ThreadStore {
  readonly #records = new Map<string, ThreadRecord>();

  load(key: string): ThreadRecord | null {
    return this.#records.get(key) ?? null;
  }

  save(key: string, record: ThreadRecord): void {
    this.#records.set(key, record);
  }

  forget(key: string): void {
    this.#records.delete(key);
  }
}

const THREAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Un fichier JSON par clé, écrit par renommage atomique ; un fichier illisible est ignoré. */
export class FileThreadStore implements ThreadStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #file(key: string): string {
    const name = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
    return path.join(this.#dir, `thread-${name}.json`);
  }

  load(key: string): ThreadRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#file(key), "utf8");
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(raw) as Partial<Record<keyof ThreadRecord, unknown>>;
      const { threadId, promptFingerprint: fingerprint, updatedAt } = value;
      if (
        typeof threadId !== "string" ||
        !THREAD_ID.test(threadId) ||
        typeof fingerprint !== "string" ||
        !FINGERPRINT.test(fingerprint) ||
        typeof updatedAt !== "string"
      ) {
        return null;
      }
      return { threadId, promptFingerprint: fingerprint, updatedAt: updatedAt as UtcTimestamp };
    } catch {
      return null;
    }
  }

  save(key: string, record: ThreadRecord): void {
    if (!THREAD_ID.test(record.threadId)) throw new Error("identifiant de fil Codex invalide");
    fs.mkdirSync(this.#dir, { recursive: true });
    const target = this.#file(key);
    const tmp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
    fs.renameSync(tmp, target);
  }

  forget(key: string): void {
    fs.rmSync(this.#file(key), { force: true });
  }
}
