/**
 * Réveil par @handle vers la room (mandat « une room, plusieurs agents », 16 nov. 2026, point 4) :
 * quand un message humain du fil principal mentionne le @handle d'une personne du registre des
 * coachs, et que son coach est agent d'une room (`assignment.agents`), le réveil part dans cette
 * room, adressé à cet agent seul, avec le texte de réveil existant (`handleWakeNote`). Un coach
 * qui n'est agent d'aucune room garde le réveil en holder (`pattern-holders.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FORK_IDS, forkDir, sendNoticeToFork } from "../daemon/forks.js";
import { readForkAssignment, resolveRoomAgents, type RoomAgent } from "../daemon/fork-assignment.js";
import { handleHits, handleWakeNote, type CoachRegistry, type HandleHit } from "./coach-handles.js";
import type { FilMessage } from "./pattern-holders.js";

export const ROOM_HANDLE_WAKES_STATE = "room-handle-wakes.json";
const MESSAGE_CHARS = 2500;

/** Agents des rooms, par id : la room où chacun vit. */
export function roomAgentIndex(dataDir: string): Map<string, { room: number; agent: RoomAgent }> {
  const index = new Map<string, { room: number; agent: RoomAgent }>();
  for (const room of FORK_IDS) {
    try {
      const assignment = readForkAssignment(forkDir(dataDir, room));
      // Agents explicites et agents détectés (`agentsFrom`), relus à chaque passage.
      for (const agent of assignment === null ? [] : resolveRoomAgents(assignment))
        if (!index.has(agent.id)) index.set(agent.id, { room, agent });
    } catch {
      // Affectation invalide : signalée par `forks status`.
    }
  }
  return index;
}

/** Étiquette d'une notice ciblée : `room-agents.ts` la remet à cet agent seul. */
export function handleWakeLabel(agent: RoomAgent): string {
  return `@handle → ${agent.name}`;
}

function readCursor(dataDir: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dataDir, ROOM_HANDLE_WAKES_STATE), "utf8")) as { cursor?: unknown }).cursor;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeCursor(dataDir: string, cursor: string): void {
  const file = path.join(dataDir, ROOM_HANDLE_WAKES_STATE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, cursor }) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Remet aux rooms les réveils par @handle des messages humains frais du fil principal. Rend les
 * coachs qui sont agents d'une room : ceux-là ne sont plus réveillés en holder par @handle.
 * Premier passage : le curseur se place au présent, l'historique ne réveille personne.
 */
export function routeHandleWakesToRooms(options: {
  dataDir: string;
  fil: () => readonly FilMessage[];
  registry: () => CoachRegistry | null;
  holderSlugs: ReadonlySet<string>;
  now: number;
  settleMs: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Set<string> {
  const index = roomAgentIndex(options.dataDir);
  const coaches = new Set(index.keys());
  if (index.size === 0) return coaches;
  const fil = options.fil();
  const latest = fil.at(-1);
  // Une série de dictées se lit d'un bloc, comme pour les holders.
  if (latest !== undefined && options.now - Date.parse(latest.at) < options.settleMs) return coaches;
  const cursor = readCursor(options.dataDir);
  if (cursor === null) {
    if (!options.dryRun) writeCursor(options.dataDir, latest?.at ?? "");
    return coaches;
  }
  const fresh = fil.filter((m) => m.at > cursor);
  if (fresh.length === 0) return coaches;
  const known = new Set([...options.holderSlugs, ...coaches]);
  for (const m of fresh) {
    // Un message d'agent, de holder ou de coach ne réveille personne : garde de boucle.
    if (m.author !== "humain" || m.holder !== undefined || !m.text.includes("@")) continue;
    const registry = options.registry();
    if (registry === null) break;
    const byCoach = new Map<string, HandleHit[]>();
    for (const hit of handleHits(m.text, registry, known))
      if (index.has(hit.coach)) byCoach.set(hit.coach, [...(byCoach.get(hit.coach) ?? []), hit]);
    for (const [coach, hits] of byCoach) {
      const home = index.get(coach);
      if (home === undefined) continue;
      const { room, agent } = home;
      const quoted = m.text.length > MESSAGE_CHARS ? `${m.text.slice(0, MESSAGE_CHARS)}…` : m.text;
      const text = `@${agent.id} — ${handleWakeNote(hits)}\n\nMessage du fil principal [${m.at}] : ${quoted}`;
      const key = `handle-wake:${createHash("sha256").update(m.id).digest("hex").slice(0, 24)}:${agent.id}`;
      if (options.dryRun) continue;
      try {
        // Message humain du fil principal (garde de boucle ci-dessus) : il vaut un tour unique.
        sendNoticeToFork(options.dataDir, room, text, key, handleWakeLabel(agent), true);
        options.log?.(`réveil par @handle : ${agent.name} dans la Room ${String(room)}`);
      } catch (error) {
        options.log?.(`réveil par @handle vers la Room ${String(room)} : échec — ${String(error)}`);
      }
    }
  }
  const last = fresh.at(-1);
  if (!options.dryRun && last !== undefined) writeCursor(options.dataDir, last.at);
  return coaches;
}
