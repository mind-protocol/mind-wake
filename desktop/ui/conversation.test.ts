import { describe, expect, it } from "vitest";
import { conversation } from "./conversation.js";

function envelope(data: unknown): unknown {
  return { schema: "mind-wake.cli", schemaVersion: 1, command: "messages", ok: true, data };
}

describe("conversation", () => {
  it("shows a screenshot attachment without exposing image bytes", () => {
    const c = conversation(envelope({ profileId: "default", agentMessages: [], replies: [{
      id: "screen", at: "2026-10-30T12:00:00Z", text: "Regarde", screenshotAt: "2026-10-30T12:00:00Z",
    }] }));
    expect(c?.items[0]?.text).toContain("Capture de l’écran principal jointe");
    expect(c?.items[0]?.text).toContain("Regarde");
  });
  it("interleaves public activity with messages without treating it as a new owner answer",()=>{
    const c=conversation(envelope({profileId:"default",agentMessages:[{id:"answer",createdAt:"2026-10-29T10:02:00Z",updatedAt:"2026-10-29T10:02:00Z",text:"Résultat"}],replies:[{id:"human",at:"2026-10-29T10:00:00Z",text:"Continue"}],publicActivity:[{id:"step",at:"2026-10-29T10:01:00Z",text:"Je vérifie le résultat."},{id:"bad",at:"invalid",text:"Ignore"}]}));
    expect(c?.items.map(i=>i.from)).toEqual(["human","activity","agent"]);
    expect(c?.agentUpdatedAt).toBe("2026-10-29T10:02:00Z");
  });
  it("explains exhausted provider quota rather than ordinary scheduling and rounds the reset boundary up",()=>{
    const now=Date.parse("2026-10-29T20:51:00Z");
    const c=conversation(envelope({profileId:"default",agentMessages:[],replies:[{id:"pending",at:"2026-10-29T20:50:00Z",text:"ok"}],agentStatus:{state:"hibernating",reason:"budget_exhausted: subscription.start_threshold_reached: claude:session used_bp=10000",nextWakeAt:"2026-10-29T20:59:59.846Z"}}),null,now);
    const reason=c?.items[0]?.pendingReason;
    expect(reason).toContain("quota Claude est épuisé");
    expect(reason).toContain(new Date("2026-10-29T21:00:00Z").toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}));
    expect(reason).not.toContain("entre deux réveils");
    expect(c?.items[0]?.delivery).toBe("sent");
  });
  it("shows observed tool, elapsed time and concurrent calls without inventing progress",()=>{
    const now=Date.parse("2026-10-29T10:05:00Z");
    const c=conversation(envelope({profileId:"default",agentMessages:[],replies:[{id:"a",at:"2026-10-29T10:04:00Z",text:"Hello"}],agentStatus:{state:"running"},messageWait:{kind:"tool",tool:"Bash",startedAt:"2026-10-29T10:03:00Z",activeCount:3}}),null,now);
    expect(c?.items[0]?.pendingReason).toContain("Bash");
    expect(c?.items[0]?.pendingReason).toContain("depuis 2 min");
    expect(c?.items[0]?.pendingReason).toContain("3 appels en cours");
  });
  it("explains pause, quota blocking and planned wake, ignoring obsolete tool activity",()=>{
    const now=Date.parse("2026-10-29T10:05:00Z");
    const base={profileId:"default",agentMessages:[],replies:[{id:"a",at:"2026-10-29T10:04:00Z",text:"Hello"}],messageWait:{kind:"subagent"}};
    const reason=(agentStatus:unknown)=>conversation(envelope({...base,agentStatus}),null,now)?.items[0]?.pendingReason;
    expect(reason({state:"paused"})).toContain("en pause");
    expect(reason({state:"paused"})).not.toContain("sous-agent");
    expect(reason({state:"blocked",reason:"budget_unknown: subscription.quota_unknown"})).toContain("quota fournisseur");
    expect(reason({state:"hibernating",nextWakeAt:"2026-10-29T10:10:00Z"})).toContain("Prochain réveil prévu");
    expect(reason({state:"stopped"})).toContain("arrêté");
    const received=conversation(envelope({...base,agentStatus:{state:"paused"},deliveryReceipts:{a:"2026-10-29T10:04:02Z"}}),null,now);
    expect(received?.items[0]?.pendingReason).toBeUndefined();
  });
  it("explains a confirmed subagent wait only on pending messages, updating without a new message",()=>{
    const data={profileId:"default",agentMessages:[],replies:[{id:"a",at:"2026-10-29T10:00:00Z",text:"Hello"}]};
    const waiting=conversation(envelope({...data,messageWait:{kind:"subagent",tool:"Agent"}}));
    expect(waiting?.items[0]?.pendingReason).toContain("sous-agent");
    const received=conversation(envelope({...data,messageWait:{kind:"subagent",tool:"Agent"},deliveryReceipts:{a:"2026-10-29T10:00:05Z"}}));
    expect(received?.items[0]?.delivery).toBe("delivered");
    expect(received?.items[0]?.pendingReason).toBeUndefined();
    expect(conversation(envelope(data))?.items[0]?.pendingReason).toBeUndefined();
  });
  it("marks persisted outgoing messages sent and only hook receipts delivered", () => {
    const c = conversation(envelope({profileId:"default",agentMessages:[],replies:[
      {id:"pending",at:"2026-10-29T10:00:00Z",text:"Pending"},
      {id:"received",at:"2026-10-29T10:00:01Z",text:"Delivered"}
    ],deliveryReceipts:{received:"2026-10-29T10:00:02Z"}}));
    expect(c?.items[0]?.delivery).toBe("sent");
    expect(c?.items[0]?.deliveredAt).toBeUndefined();
    expect(c?.items[1]?.delivery).toBe("delivered");
    expect(c?.items[1]?.deliveredAt).toBe("2026-10-29T10:00:02Z");
  });
  it("ordonne la note de l'agent et les réponses de l'humain dans le temps", () => {
    const c = conversation(
      envelope({
        profileId: "default",
        hint: null,
        agentNote: { text: "1. Sur quoi travailler ?", updatedAt: "2026-10-29T14:13:50Z" },
        replies: [
          { id: "a", at: "2026-10-29T14:20:00Z", text: "Les systèmes émergents." },
          { id: "b", at: "2026-10-29T14:00:00Z", text: "Bonjour." },
        ],
      }),
    );
    expect(c?.items.map((i) => i.from)).toEqual(["human", "agent", "human"]);
    expect(c?.note).toBeNull();
  });

  it("fil vide : invite à écrire ; profil absent : indication", () => {
    expect(
      conversation(envelope({ profileId: "default", agentNote: null, replies: [] }))?.note,
    ).toMatch(/rien écrit/);
    expect(
      conversation(envelope({ profileId: null, hint: "lancer init", agentNote: null, replies: [] }))
        ?.note,
    ).toBe("lancer init");
  });

  it("enveloppe invalide", () => {
    expect(conversation({ schema: "autre" })).toBeNull();
  });
});

it("managed edits keep a single message and deletion does not resurrect the legacy note", () => {
  const old = { text: "Ancien questionnaire", updatedAt: "2026-10-29T10:00:00Z" };
  const managed = {
    id: "own_test",
    text: "Corrigé",
    createdAt: "2026-10-29T11:00:00Z",
    updatedAt: "2026-10-29T11:10:00Z",
    version: 2,
  };
  expect(
    conversation(
      envelope({ profileId: "default", agentNote: old, agentMessages: [managed], replies: [] }),
    )?.items,
  ).toEqual([
    { from: "agent", id: "own_test", text: "Corrigé", at: managed.createdAt, edited: true },
  ]);
  const deleted = conversation(
    envelope({
      profileId: "default",
      agentNote: old,
      agentMessages: [],
      replies: [{ text: "Réponse", at: "2026-10-29T12:00:00Z" }],
    }),
  );
  expect(deleted?.items).toEqual([{ from: "human", text: "Réponse", at: "2026-10-29T12:00:00Z" }]);
});

it("les réponses des sessions s'insèrent dans le fil avec leur origine", () => {
  const helpers = {
    schema: "mind.helpers.cli",
    schemaVersion: 1,
    command: "answers",
    ok: true,
    data: {
      answers: [
        {
          id: "help-1",
          at: "2026-10-29T11:30:00Z",
          runtime: "claude",
          cwd: "C:/Users/reyno/le-conseil2",
          text: "Essaie la règle du vent.",
        },
      ],
    },
  };
  const c = conversation(
    envelope({
      profileId: "default",
      agentMessages: [
        {
          id: "m1",
          text: "Question",
          createdAt: "2026-10-29T11:00:00Z",
          updatedAt: "2026-10-29T11:00:00Z",
          version: 1,
        },
      ],
      replies: [],
    }),
    helpers,
  );
  expect(c?.items.map((i) => [i.from, i.source ?? null])).toEqual([
    ["agent", null],
    ["session", "Claude Code · le-conseil2"],
  ]);
  expect(
    conversation(envelope({ profileId: "default", agentMessages: [], replies: [] }), {
      schema: "autre",
    })?.items,
  ).toEqual([]);
});
