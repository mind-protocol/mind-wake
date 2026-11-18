/**
 * Routage `@handle` des messages Telegram de NLR (mandat du 16 nov. 2026, 14:53–14:57, point 4) :
 * un message qui commence par `@vox` (ou le handle d'une autre room ou d'un agent de room) part
 * dans le fil de cette room, ou à cet agent seul, au lieu du fil principal.
 *
 * Pas de liste codée en dur : la table est relue à chaque message dans le registre du runtime,
 * l'affectation de chaque room (`forks/<n>/assignment.json`), si bien qu'une room ou un agent
 * nouveau est routable dès sa création. Handles d'une room : `room<n>`, son `name` (« Médicis » →
 * `medicis`), le nom de sa signature propriétaire (« VOX (Room 7) » → `vox`) et son pattern holder ; d'un agent : son id.
 *
 * Remise : même chemin que l'envoi d'un message humain à une room (`sendToFork`, clé
 * d'idempotence) ; pour un agent, la notice ciblée « … → Nom » que `room-agents.ts` ne remet
 * qu'à lui (même chemin que le réveil par @handle et `post_to_fork_thread`).
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { FORK_IDS, forkDir, sendNoticeToFork, sendToFork } from "../daemon/forks.js";
import { holderThread, loadPatternHolders } from "./pattern-holders.js";
import {
  forkOwnerChannel,
  readForkAssignment,
  resolveRoomAgents,
  readRoomDisplayName,
  roomLabel,
  type ForkAssignment,
  type RoomAgent,
} from "../daemon/fork-assignment.js";

export interface HandleTarget {
  readonly handle: string;
  /** 0 : pattern holder du fil principal (`holder`), le message reste au fil principal. */
  readonly room: number;
  readonly agent: RoomAgent | null;
  /** Slug d'un pattern holder du fil principal : le message y part en le mentionnant. */
  readonly holder?: string;
  /** Ce qui est dit à NLR après remise (« Room 7 (VOX) », « Coach Colony (Room 2) »). */
  readonly label: string;
}

export type HandleRoute =
  | { readonly status: "routed"; readonly label: string; readonly room: number; readonly agent: string | null; readonly entries: readonly number[] }
  | { readonly status: "unknown"; readonly handle: string; readonly known: readonly string[] }
  /** Pattern holder du fil principal : le bridge y laisse le message, qui doit contenir `mention`. */
  | { readonly status: "main"; readonly label: string; readonly holder: string; readonly mention: string };

/** Message de Marco (principal) écrit à NLR sur Telegram et qui commence par un @handle. */
export const MARCO_TELEGRAM_LABEL = "Marco (Telegram, devant NLR)";

/** Étiquette de la notice qui adresse un message de NLR à un agent seul. */
export function telegramAgentLabel(agent: RoomAgent): string {
  return `NLR (Telegram) → ${agent.name}`;
}

/** « VOX (Room 7) » → `vox` ; « Fixeur (Room 2) » → `fixeur`. */
export function signatureHandle(signature: string): string | null {
  const head = signature.replace(/\(.*\)/g, " ").trim().toLowerCase();
  const slug = head
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? null : slug;
}

/** Handle du nom d'une room : « Médicis » → `medicis`, « Rose des Vents » → `rosedesvents`. */
export function roomNameHandle(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return slug === "" ? null : slug;
}

/**
 * Table des handles, relue dans les affectations. Les handles des rooms passent avant ceux des
 * agents ; à handle égal, la première room l'emporte.
 */
export function telegramHandleTable(
  dataDir: string,
  read: (room: number) => ForkAssignment | null = (room) => readForkAssignment(forkDir(dataDir, room)),
  holders: () => readonly { slug: string; name: string; emoji: string }[] = () => mainThreadHolders(dataDir),
): Map<string, HandleTarget> {
  const table = new Map<string, HandleTarget>();
  const add = (handle: string | null | undefined, target: Omit<HandleTarget, "handle">) => {
    if (!handle) return;
    const h = handle.toLowerCase();
    if (!table.has(h)) table.set(h, { handle: h, ...target });
  };
  const rooms: { room: number; assignment: ForkAssignment | null }[] = [];
  for (const room of FORK_IDS) {
    if (!fs.existsSync(forkDir(dataDir, room))) continue;
    let assignment: ForkAssignment | null = null;
    try {
      assignment = read(room);
    } catch {
      // Affectation invalide : la room reste joignable par `room<n>`.
    }
    rooms.push({ room, assignment });
  }
  for (const { room, assignment } of rooms) {
    const signature = forkOwnerChannel(room, assignment)?.signature ?? null;
    const name = signature === null ? null : signatureHandle(signature);
    const displayName = readRoomDisplayName(forkDir(dataDir, room));
    const shown = roomLabel(room, assignment, displayName);
    const label = shown === `Room ${String(room)}` ? shown : `${shown} (Room ${String(room)})`;
    add(`room${String(room)}`, { room, agent: null, label });
    add(assignment?.name === undefined ? null : roomNameHandle(assignment.name), { room, agent: null, label });
    // Nom affiché (renommage depuis l'app) : mention en plus ; @roomN et l'ancien nom restent valables.
    add(displayName === undefined ? null : roomNameHandle(displayName), { room, agent: null, label });
    add(name, { room, agent: null, label });
    add(assignment?.holder, { room, agent: null, label });
  }
  for (const { room, assignment } of rooms) {
    if (assignment === null) continue;
    let agents: RoomAgent[] = [];
    try {
      agents = [...resolveRoomAgents(assignment, dataDir)];
    } catch {
      agents = [];
    }
    for (const agent of agents) add(agent.id, { room, agent, label: `${agent.name} (Room ${String(room)})` });
  }
  // Pattern holders du fil principal, après les rooms et leurs agents : par slug, puis par nom.
  let list: readonly { slug: string; name: string; emoji: string }[] = [];
  try {
    list = holders();
  } catch {
    list = [];
  }
  for (const h of list) add(h.slug, { room: 0, agent: null, holder: h.slug, label: `${h.emoji} ${h.name} (fil principal)` });
  // Un holder qui est aussi agent d'une room (coachs de la Room 2) se joint dans sa room : son nom
  // n'ouvre pas de seconde porte vers le fil principal.
  for (const h of list)
    if (table.get(h.slug)?.holder === h.slug)
      add(signatureHandle(h.name), { room: 0, agent: null, holder: h.slug, label: `${h.emoji} ${h.name} (fil principal)` });
  return table;
}

/** Holders qui parlent dans le fil principal (pas ceux affectés à une room). */
export function mainThreadHolders(dataDir: string): { slug: string; name: string; emoji: string }[] {
  return loadPatternHolders(dataDir)
    .holders.filter((h) => holderThread(dataDir, h.slug) === "principal")
    .map((h) => ({ slug: h.slug, name: h.name, emoji: h.emoji }));
}

/**
 * Remet `text` au fil désigné par `handle`, ou rend les handles connus. `key` : id stable du
 * message Telegram, pour qu'un nouvel essai ne crée pas de doublon.
 */
export function routeTelegramHandle(
  dataDir: string,
  handle: string,
  text: string,
  key: string,
  table: Map<string, HandleTarget> = telegramHandleTable(dataDir),
  /** `marco` : message de Marco posté sur Telegram devant NLR (notice étiquetée à son nom). */
  via: "nlr" | "marco" = "nlr",
): HandleRoute {
  const target = table.get(handle.replace(/^@/, "").toLowerCase());
  if (target === undefined) return { status: "unknown", handle, known: [...table.keys()].sort() };
  // Holder du fil principal : rien n'est écrit ici, le bridge remet le message au fil principal
  // (avec `@slug` en tête si NLR a écrit son nom), où le holder se réveille sur la mention.
  if (target.holder !== undefined)
    return { status: "main", label: target.label, holder: target.holder, mention: `@${target.holder}` };
  const safe = /^[A-Za-z0-9_.:-]{8,90}$/.test(key) ? key : createHash("sha256").update(key).digest("hex").slice(0, 40);
  const parts: string[] = [];
  for (let rest = text.trim(); rest !== ""; rest = rest.slice(4000)) parts.push(rest.slice(0, 4000));
  const entries: number[] = [];
  parts.forEach((part, i) => {
    const k = `telegram-route:${via === "marco" ? "marco-" : ""}${safe}${parts.length === 1 ? "" : `:${String(i)}`}`;
    const r =
      via === "marco"
        ? sendNoticeToFork(dataDir, target.room, part, k, target.agent === null ? MARCO_TELEGRAM_LABEL : `${MARCO_TELEGRAM_LABEL} → ${target.agent.name}`, true)
        : target.agent === null
          ? sendToFork(dataDir, target.room, part, k, "telegram", undefined, [], true)
          : sendNoticeToFork(dataDir, target.room, part, k, telegramAgentLabel(target.agent), true);
    entries.push(r.entryId);
  });
  return { status: "routed", label: target.label, room: target.room, agent: target.agent?.id ?? null, entries };
}
