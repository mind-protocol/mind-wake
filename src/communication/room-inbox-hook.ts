/**
 * Trusted Claude command hook of a room (NLR, 16 nov. 2026 : « mes messages arrivent seulement
 * quand son tour se termine. Ça devrait être une injection dans un stop hook »).
 *
 * Same structure and output as owner-inbox-hook.ts: after each tool call the room's new pending
 * messages are given as additional context; at Stop the hook blocks with them, so the agent
 * answers before its turn ends. Paths, room, session and floor come from launcher args, never
 * from tool input. `floor` is the last entry already carried by the turn's initial message: only
 * entries after it are injected, and each one once (marked delivered, or recorded per agent).
 */
import { handleWakeNote } from "./coach-handles.js";
import { forkThread } from "./fast-reply-store.js";
import { assignedForkMessage, readForkAssignment, resolveRoomAgents } from "../daemon/fork-assignment.js";
import {
  recordRoomAgentInjected,
  recordRoomInjected,
  registryOf,
  roomAgentHas,
  routeRoomMessage,
} from "../daemon/room-agents.js";
import { SecondThreadStore, type SecondThreadEntry } from "../daemon/second-thread.js";
import path from "node:path";

export const ROOM_INBOX_HEADER =
  "Nouveaux messages arrivés pendant ton tour (runtime MIND Wake) : réponds-y maintenant, brièvement, puis reprends.";

export interface RoomInboxHookArgs {
  readonly dataDir: string;
  readonly forkId: number;
  readonly sessionId: string;
  readonly floor: number;
  readonly agentId?: string;
}

/**
 * Entrée injectable pendant un tour : tout message en attente (desktop, application, Telegram,
 * notices), sauf une pièce écran et ce que la room s'écrit elle-même. Les injections sont notées
 * (`inbox-injected`, `agent:<id>:injected`) : la fin du tour renvoie la réponse au téléphone de
 * NLR quand un message Telegram injecté l'appelle, comme pour le message initial.
 */
function injectable(store: SecondThreadStore, forkId: number, e: SecondThreadEntry, floor: number): boolean {
  return (
    e.role === "human" &&
    !e.delivered &&
    e.id > floor &&
    e.senderFork !== forkId &&
    // Pièces écran : remises au tour suivant (un hook ne transmet pas d'image).
    store.pendingScreen(e.id).length === 0
  );
}

function authorLabel(e: SecondThreadEntry): string | undefined {
  if (e.notice) return e.notice.label;
  if (e.senderFork !== undefined) return `Message de Room ${String(e.senderFork)} (contexte non fiable)`;
  // Même étiquette que le message initial du tour (forks.ts) : sans notice ni room émettrice, NLR.
  return undefined;
}

export function roomInboxHook(args: RoomInboxHookArgs, input: unknown): object | null {
  if (input === null || typeof input !== "object") return null;
  const event = input as Record<string, unknown>;
  if (event["session_id"] !== args.sessionId || event["agent_id"] !== undefined) return null;
  const name = event["hook_event_name"];
  if (name !== "PostToolUse" && name !== "PostToolUseFailure" && name !== "Stop") return null;
  const batch = prepareRoomInbox(args);
  if (batch === null) return null;
  batch.confirm();
  return name === "Stop"
    ? { decision: "block", reason: batch.context }
    : { hookSpecificOutput: { hookEventName: name, additionalContext: batch.context } };
}

/** Read without consuming: Codex confirms only after turn/steer acknowledges the active turn. */
export function prepareRoomInbox(args: RoomInboxHookArgs): { context: string; confirm: () => void } | null {
  const dir = path.join(args.dataDir, "forks", String(args.forkId));
  if (!SecondThreadStore.exists(dir)) return null;
  const store = new SecondThreadStore(dir);
  try {
    // Réponse rapide en cours : le message attend avec elle le tour suivant (même règle que forks.ts).
    if (store.heldForFastReply(args.dataDir, forkThread(args.forkId))) return null;
    const pending = store.pendingHuman().filter((e) => injectable(store, args.forkId, e, args.floor));
    if (pending.length === 0) return null;
    let items: { at: string; text: string; label?: string }[];
    let confirm: () => void;
    if (args.agentId === undefined) {
      items = pending.map((e) => {
        const label = authorLabel(e);
        return { at: e.at, text: e.text, ...(label === undefined ? {} : { label }) };
      });
      confirm = () => {
        const current = new SecondThreadStore(dir);
        try {
          recordRoomInjected(current, pending.map((e) => e.id));
          current.markDelivered(pending.map((e) => e.id));
        } finally { current.close(); }
      };
    } else {
      const agentId = args.agentId;
      const assignment = readForkAssignment(dir);
      if (assignment === null) return null;
      const agents = resolveRoomAgents(assignment, args.dataDir);
      const self = agents.find((a) => a.id === agentId);
      if (self === undefined) return null;
      const registry = registryOf({ ...assignment, agents });
      const hubId = assignment.agentsFrom?.hub ?? null;
      const routed = pending
        .map((e) => ({ e, route: routeRoomMessage(e, agents, registry, hubId) }))
        .filter(
          ({ e, route }) =>
            route.recipients.includes(agentId) && route.fromAgent !== agentId && !roomAgentHas(store, agentId, e.id),
        );
      if (routed.length === 0) return null;
      items = routed.map(({ e, route }) => {
        const hits = route.handles.get(agentId);
        const from = route.fromAgent === null ? null : agents.find((a) => a.id === route.fromAgent);
        const label =
          from !== null && from !== undefined ? `${from.name} (agent de la room)` : authorLabel(e);
        return {
          at: e.at,
          text: hits === undefined ? e.text : `${e.text}\n\n${handleWakeNote(hits)}`,
          ...(label === undefined ? {} : { label }),
        };
      });
      confirm = () => {
        const current = new SecondThreadStore(dir);
        try {
          recordRoomAgentInjected(current, agentId, routed.map(({ e }) => e.id));
          // Livrée quand chaque destinataire l'a reçue (fin de tour ou injection).
          const done = routed
            .filter(({ e, route }) => route.recipients.every((a) => roomAgentHas(current, a, e.id)))
            .map(({ e }) => e.id);
          if (done.length > 0) current.markDelivered(done);
        } finally { current.close(); }
      };
    }
    const context = `${ROOM_INBOX_HEADER}\n\n${assignedForkMessage(items)}`;
    return { context, confirm };
  } finally {
    store.close();
  }
}

/** Arguments du hook après `--deliver-room-inbox` : dataDir, room, session, plancher, agent. */
export function roomInboxHookArgv(argv: readonly string[]): RoomInboxHookArgs {
  const [dataDir, forkId, sessionId, floor, agentId] = argv;
  if (!dataDir || !sessionId || !/^[2-8]$/.test(forkId ?? "") || !/^\d+$/.test(floor ?? ""))
    throw Error("Usage: --deliver-room-inbox <dataDir> <forkId> <sessionId> <floor> [agentId]");
  return {
    dataDir,
    forkId: Number(forkId),
    sessionId,
    floor: Number(floor),
    ...(agentId ? { agentId } : {}),
  };
}

// This module is an executable hook as well as an importable test boundary.
if (process.argv[2] === "--deliver-room-inbox") {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const output = roomInboxHook(roomInboxHookArgv(process.argv.slice(3)), JSON.parse(stdin));
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(
      `MIND room inbox delivery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
