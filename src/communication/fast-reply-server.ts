/**
 * Réponse rapide hébergée par le moteur (`daemon run`) : un Claude Code préchauffé
 * (déjà lancé, en attente de son prompt) répond à chaque nouveau message humain dès son
 * arrivée dans human-messages.jsonl, puis un autre est préchauffé. Pas de processus ni de
 * supervision propres : le service vit et s'arrête avec le moteur. Utilise seulement l'API
 * publique de `fast-reply.ts` (`runFastReply` et son point d'injection `call`).
 */
import fs from "node:fs";
import path from "node:path";
import {
  callClaude,
  fastReplyApplies,
  fastReplyClaude,
  fastReplyEnabled,
  fastReplyLaunch,
  readFastReplies,
  runFastReply,
  startClaude,
  waitingThreadMessages,
  type FastReplyClaude,
  type WarmClaude,
  type speakFastReply,
} from "./fast-reply.js";

/** Un Claude préchauffé est renouvelé après ce délai (prompt système, personnalité). */
export const FAST_REPLY_WARM_MAX_AGE_MS = 10 * 60_000;
/**
 * Battement du service, lu par la retenue des messages humains (`fastReplyHolds`) : tant
 * qu'il est récent, le fil d'origine attend le ⚡ au lieu de répondre en double.
 */
export const FAST_REPLY_HEARTBEAT = "fast-reply-server.json";
const HEARTBEAT_MS = 2_000;
/** Un message humain plus ancien n'appelle plus de réponse rapide. */
export const FAST_REPLY_PICKUP_MS = 90_000;

/** Messages humains récents sans réponse rapide, du plus ancien au plus récent. */
export function waitingHumanMessages(dataDir: string, now = Date.now()): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, "human-messages.jsonl"), "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of raw.split("\n").slice(-50)) {
    try {
      const h = JSON.parse(line) as { id?: unknown; at?: unknown };
      if (
        typeof h.id === "string" &&
        typeof h.at === "string" &&
        now - Date.parse(h.at) <= FAST_REPLY_PICKUP_MS &&
        fastReplyApplies(h.id) &&
        !ids.includes(h.id)
      )
        ids.push(h.id);
    } catch {
      // Ligne partielle : ignorée.
    }
  }
  if (ids.length === 0) return [];
  const known = new Set(readFastReplies(dataDir, 200).map((r) => r.messageId));
  return ids.filter((id) => !known.has(id));
}

export interface FastReplyServiceOptions {
  readonly dataDir: string;
  /** Arrêt d'urgence ou moteur en fin de vie : aucune nouvelle réponse. */
  readonly allowed?: () => boolean;
  readonly claude?: FastReplyClaude;
  readonly start?: typeof startClaude;
  readonly speak?: typeof speakFastReply;
  readonly log?: (message: string) => void;
  readonly pollMs?: number;
}

export class FastReplyService {
  #warm: WarmClaude | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #beatAt = 0;

  constructor(private readonly options: FastReplyServiceOptions) {}

  start(): void {
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#running;
    this.#warm?.dispose();
    this.#warm = undefined;
    this.#stopBeat();
  }

  /** Un passage : préchauffe si besoin, puis répond aux messages en attente. Exposé aux tests. */
  async tick(): Promise<void> {
    const { dataDir } = this.options;
    if (this.#closed) return;
    if (!fastReplyEnabled(dataDir) || this.options.allowed?.() === false) {
      // Désactivée : aucun Claude ne reste lancé pour rien.
      this.#warm?.dispose();
      this.#warm = undefined;
      this.#stopBeat();
      return;
    }
    this.#beat();
    const warm = this.#ready();
    for (const messageId of [...waitingHumanMessages(dataDir), ...waitingThreadMessages(dataDir)]) {
      // `close()` peut survenir pendant l'appel précédent.
      if (this.#isClosed()) return;
      const ready = this.#warm ?? warm;
      this.#warm = undefined;
      const state = await runFastReply({
        dataDir,
        messageId,
        ...(this.options.claude === undefined ? {} : { claude: this.options.claude }),
        ...(this.options.speak === undefined ? {} : { speak: this.options.speak }),
        ...(this.options.log === undefined ? {} : { log: this.options.log }),
        // Le prompt système vient d'être réécrit à l'identique : le Claude préchauffé convient.
        call: (claude, args, prompt, cwd) =>
          ready.alive() && ready.args.join("\0") === args.join("\0")
            ? ready.answer(prompt)
            : callClaude(claude, args, prompt, cwd),
      });
      ready.dispose();
      this.options.log?.(`réponse rapide ${messageId} : ${state}`);
      if (!this.#isClosed()) {
        this.#beat(true);
        this.#ready();
      }
    }
  }

  #beat(force = false): void {
    if (!force && Date.now() - this.#beatAt < HEARTBEAT_MS) return;
    const file = path.join(this.options.dataDir, FAST_REPLY_HEARTBEAT);
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }),
    );
    fs.renameSync(tmp, file);
    this.#beatAt = Date.now();
  }

  #stopBeat(): void {
    if (this.#beatAt === 0) return;
    this.#beatAt = 0;
    fs.rmSync(path.join(this.options.dataDir, FAST_REPLY_HEARTBEAT), { force: true });
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #ready(): WarmClaude {
    const warm = this.#warm;
    if (warm?.alive() === true && Date.now() - warm.startedAt <= FAST_REPLY_WARM_MAX_AGE_MS)
      return warm;
    warm?.dispose();
    const claude = this.options.claude ?? fastReplyClaude();
    const launch = fastReplyLaunch(this.options.dataDir, claude);
    this.#warm = (this.options.start ?? startClaude)(claude, launch.args, launch.cwd);
    return this.#warm;
  }

  #schedule(delay: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#running = this.tick()
        .catch((error: unknown) => {
          this.options.log?.(`réponse rapide : ${String(error)}`);
        })
        .finally(() => {
          this.#running = undefined;
          this.#schedule(this.options.pollMs ?? 250);
        });
    }, delay);
    this.#timer.unref();
  }
}
