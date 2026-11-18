/**
 * Salle présente dans un appel (NLR, 18 nov. 2026 15:55 : « l'appel la fait parler en tour
 * unique, mais à chaque message, donc elle devrait pouvoir répondre, là elle est dans le call »).
 *
 * L'appel actif et ses participants sont tenus par le serveur de l'app dans
 * `mobile-call-control.sqlite` (services/mcp/call-control-store.mjs) : un appel est actif tant que
 * `state='active'` et que l'app l'a vu depuis moins de `CALL_IDLE_MS`. Une salle y participe si
 * l'un de ses identifiants y figure (`room<N>`, `room-<N>`, id d'un de ses agents).
 *
 * Pendant l'appel, une salle — même désactivée — reçoit un tour pour chaque message humain de
 * l'appel et pour chaque message qui la mentionne (@room<N>, son nom, le nom ou @id d'un de ses
 * agents). Ces tours n'ont ni plafond ni intervalle : un message ne reçoit qu'une réponse
 * (réservation `oneshot:<id>`, forks.ts).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SecondThreadEntry, SecondThreadStore } from "./second-thread.js";

/** Même fenêtre que le magasin de l'app (`idleMs` de openCallControls). */
export const CALL_IDLE_MS = 120_000;

export interface RoomCallPresence {
  readonly callId: string;
  /** Début de l'appel (ms) : seuls les messages arrivés depuis comptent. */
  readonly since: number;
}

/** Identifiants d'appel d'une salle : handle de room et ids de ses agents. */
export function roomCallKeys(room: number, agentIds: readonly string[] = []): string[] {
  return [`room${String(room)}`, `room-${String(room)}`, ...agentIds.map((a) => a.toLowerCase())];
}

/**
 * Appel actif auquel la salle participe, sinon `null`. Lecture seule ; base absente, verrouillée
 * ou illisible : `null` (la salle garde alors la règle du tour unique ordinaire).
 */
export function roomCallPresence(
  dataDir: string,
  room: number,
  agentIds: readonly string[] = [],
  now = Date.now(),
): RoomCallPresence | null {
  const file = path.join(dataDir, "mobile-call-control.sqlite");
  if (!fs.existsSync(file)) return null;
  const keys = new Set(roomCallKeys(room, agentIds));
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const rows = db
      .prepare("SELECT id, participants, started_at FROM call_control_sessions WHERE state='active' AND last_seen>? ORDER BY started_at")
      .all(now - CALL_IDLE_MS) as { id: string; participants: string; started_at: number }[];
    for (const row of rows) {
      let participants: unknown;
      try { participants = JSON.parse(row.participants); } catch { continue; }
      if (Array.isArray(participants) && participants.some((p) => typeof p === "string" && keys.has(p.toLowerCase())))
        return { callId: row.id, since: Number(row.started_at) };
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Le message mentionne-t-il la salle ? `@room<N>` / `@room-<N>`, son nom affiché (mot entier,
 * sans casse ni accents), le nom ou `@id` d'un de ses agents.
 */
export function mentionsRoom(
  text: string,
  room: number,
  names: readonly string[] = [],
  agentIds: readonly string[] = [],
): boolean {
  const folded = fold(text);
  const tokens = [
    ...roomCallKeys(room, agentIds).map((k) => `@${k}`),
    ...names.map((n) => fold(n).trim()).filter((n) => n.length >= 4 && !/^room \d+$/.test(n)),
  ];
  return tokens.some((t) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escape(t)}($|[^\\p{L}\\p{N}_-])`, "u").test(folded));
}

/**
 * Messages de l'appel qui attendent leur tour : humains (origine NLR) ou qui mentionnent la salle,
 * arrivés depuis le début de l'appel, pas encore servis (`oneshot:<id>`). Jamais un message d'une
 * autre room (`senderFork`) : deux salles ne se réveillent pas en boucle.
 */
export function callTriggers(
  store: Pick<SecondThreadStore, "pendingHuman" | "get" | "isHumanOrigin">,
  presence: RoomCallPresence,
  mentions: (entry: SecondThreadEntry) => boolean,
): SecondThreadEntry[] {
  return store
    .pendingHuman()
    .filter((e) => Date.parse(e.at) >= presence.since && e.senderFork === undefined
      && store.get(`oneshot:${String(e.id)}`) === null
      && (store.isHumanOrigin(e) || mentions(e)));
}

export const CALL_NOTE =
  "(Runtime : tu es dans un appel vocal en cours. Chaque message de l'appel qui t'est adressé ou te mentionne te donne un tour pour répondre, même si ta room est désactivée ; elle reste désactivée ensuite. Réponds brièvement, à l'oral.)";
