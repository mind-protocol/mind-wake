/**
 * Outil MCP invite_to_call (NLR, 18 nov. 2026 : « l'accès d'abord ; un outil pour tout le monde »).
 * Flux complet sans réseau : handler de l'outil → demande dans mobile-call-control.sqlite →
 * exécution par le serveur de l'app (processCallInvites) → participant ajouté + annonce d'une ligne.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentCallControl } from "../services/mcp/agent-hangup.js";
import { openCallControls } from "../services/mcp/call-control-store.mjs";
// @ts-expect-error module JavaScript du serveur de l'app, sans déclarations
import { createCallService, MIRROR_TAG } from "../lumina-prime/app/server/chat-call.mjs";
// @ts-expect-error module JavaScript du serveur de l'app, sans déclarations
import { processCallInvites } from "../lumina-prime/app/server/chat-call-invites.mjs";

const CALL = "382582c4-90f8-4dfb-910d-6c976ad77247";
const RIFF = Buffer.from("RIFF0000WAVEfmt ", "latin1");
type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mind-invite-")); dirs.push(dir);
  const notices: { channel: string; key: string; text: string }[] = [];
  const routed: { handle: string; text: string }[] = []; const sent: string[] = [];
  const vox = { room: 7, agent: null, label: "VOX (Room 7)" };
  const table = new Map<string, unknown>([["room7", vox], ["vox", vox],
    ["room3", { room: 3, agent: null, label: "Médicis (Room 3)" }],
    ["viz", { room: 0, agent: null, holder: "viz", label: "🌳 Viz (fil principal)" }]]);
  const holders = [{ slug: "viz", name: "Viz", emoji: "🌳", thread: "principal" }];
  const call = createCallService({ mainLabel: "Marco", mainAgentId: "marco", handleTable: () => table, holders: () => holders,
    routeHandle: async (handle: string, text: string) => { routed.push({ handle, text }); return { status: "routed", label: "x" }; },
    sendMain: async (_id: string, text: string) => { sent.push(text); return { status: "recorded", at: new Date().toISOString() }; },
    mainReplies: async () => [], roomEntries: async () => [], mirrorIntervalMs: 0,
    noticeMain: async (key: string, text: string) => { notices.push({ channel: "main", key, text }); },
    noticeRoom: async (room: number, key: string, text: string) => { notices.push({ channel: `room:${room}`, key, text }); },
    speak: async () => ({ bytes: RIFF, mime: "audio/wav", provider: "local" }) });
  const tools = (caller: string, label: string) => {
    const handlers = new Map<string, Handler>();
    registerAgentCallControl({ registerTool: (name: string, _c: unknown, h: Handler) => { handlers.set(name, h); } } as never, { dir, caller, label });
    return handlers;
  };
  const open = (handles: string) => {
    call.openSession("owner-session", CALL, 1, handles);
    const book = openCallControls(dir);
    try { book.registerCall({ id: CALL, epoch: 1, participants: call.identityKeys(handles) }); } finally { book.close(); }
  };
  /** Le serveur de l'app tourne pendant que l'outil attend sa réponse. */
  const invoke = async (handler: Handler, args: Record<string, unknown>) => {
    const controls = openCallControls(dir);
    const timer = setInterval(() => { void processCallInvites({ controls, call }); }, 50);
    try {
      const result = await handler(args);
      return { isError: Boolean(result.isError), ...JSON.parse(result.content[0]!.text) };
    } finally { clearInterval(timer); controls.close(); }
  };
  return { dir, call, notices, routed, sent, tools, open, invoke };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe("invite_to_call", () => {
  it("lets the principal add a holder; the server adds it and announces who invited whom and why", async () => {
    const f = setup(); f.open("mind,vox");
    const result = await f.invoke(f.tools("marco", "Marco").get("invite_to_call")!, { target: "viz", reason: "carte des agents" });
    expect(result).toMatchObject({ schema: "mind.call.invite.v1", call_id: CALL, target: "viz", status: "added", isError: false });
    expect(f.call.stateSession("owner-session", CALL, 1)).toMatchObject({ revision: 2, handles: ["mind", "vox", "viz"] });
    await settle();
    const lines = f.notices.filter(n => n.key.startsWith("call-invite:"));
    // Une ligne par fil des participants (fil principal et Room 7), jamais copiée par le miroir.
    expect(lines.map(n => n.channel).sort()).toEqual(["main", "room:7"]);
    expect(lines[0]!.text).toBe(`${MIRROR_TAG} ➕ Marco a invité 🌳 Viz dans l'appel — carte des agents.`);
    const book = openCallControls(f.dir);
    try { expect(book.listForCaller("viz").map(c => c.id)).toEqual([CALL]); } finally { book.close(); }
  });

  it("is open to a room agent that is not in the call, and the invitee then hears the human", async () => {
    const f = setup(); f.open("mind");
    const result = await f.invoke(f.tools("room3", "Médicis (Room 3)").get("invite_to_call")!, { target: "vox", call_id: CALL, reason: "question VOX" });
    expect(result).toMatchObject({ status: "added", isError: false });
    await settle();
    expect(f.notices.some(n => n.text.includes("Médicis (Room 3) a invité VOX (Room 7) dans l'appel — question VOX."))).toBe(true);
    // L'app ne connaît que « mind » : la phrase de l'humain atteint quand même l'invité.
    await f.call.deliver("mind", "chat-11111111-2222-4333-8444-555555555555", "Bonjour à tous", { owner: "owner-session", id: CALL, epoch: 1 });
    expect(f.routed.map(r => r.handle)).toEqual(["vox"]);
  });

  it("does not add a target that is already a participant", async () => {
    const f = setup(); f.open("mind,vox");
    const handler = f.tools("marco", "Marco").get("invite_to_call")!;
    expect(await f.invoke(handler, { target: "vox", reason: "encore" })).toMatchObject({ status: "already_joined", isError: false });
    expect(f.call.stateSession("owner-session", CALL, 1)).toMatchObject({ revision: 1 });
    expect(f.notices.filter(n => n.key.startsWith("call-invite:"))).toEqual([]);
  });

  it("refuses an unknown target without touching the call", async () => {
    const f = setup(); f.open("mind");
    const result = await f.invoke(f.tools("marco", "Marco").get("invite_to_call")!, { target: "personne", reason: "test" });
    expect(result).toMatchObject({ status: "target_unknown", isError: true });
    expect(f.call.stateSession("owner-session", CALL, 1)).toMatchObject({ revision: 1, handles: ["mind"] });
  });

  it("answers no_active_call when no call is in progress", async () => {
    const f = setup();
    const result = await f.invoke(f.tools("marco", "Marco").get("invite_to_call")!, { target: "viz", reason: "test" });
    expect(result).toMatchObject({ status: "no_active_call", isError: false });
    const book = openCallControls(f.dir);
    try { expect(book.pendingInvites()).toEqual([]); } finally { book.close(); }
  });
});
