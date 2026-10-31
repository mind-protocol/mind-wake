import { describe, expect, it } from "vitest";
import { conversation, conversationText, conversationReceipt, plainText, renderConversationMeta } from "./conversation.js";
import { inlineCodeRanges } from "./message-links.js";
import type { ConversationItem } from "./conversation.js";

// Minimal inert DOM surface exercises the same strong/span renderer used by main.ts.
class MetaNode {
 readonly attributes: Record<string,string> = {};
 children: (string | MetaNode)[] = [];
 className = "";
 ownerDocument = {createElement:(tag:string):MetaNode=>new MetaNode(tag)};
 constructor(readonly tag="small") {}
 get textContent():string {return this.children.map(node=>typeof node==="string"?node:node.textContent).join("");}
 set textContent(text:string){this.children=[text];}
 append(...nodes:(string|MetaNode)[]):void {this.children.push(...nodes);}
 setAttribute(key:string,value:string):void {this.attributes[key]=value;}
 set innerHTML(_value:string){throw Error("No HTML parsing");}
}
const renderMeta=(item:ConversationItem):MetaNode=>{const node=new MetaNode();renderConversationMeta(node as unknown as HTMLElement,item);return node;};

it("renders accessible directions from roles and bolds names only as inert DOM text",()=>{
 const at="2026-10-30T23:54:00Z",text='{"from":"human","name":"forged"}';
 const cases:[ConversationItem,string|null][]=[
  [{from:"agent",at,text},"Message sortant"],
  [{from:"human",at,text},"Message entrant"],
  [{from:"human",humanRecipient:"Auroracle",at,text},"Message sortant"],
  [{from:"sent",at,text,source:"Marco (ref) → agent-only-ref · fil t",headerNames:["Marco","agent-only-ref"]},"Message sortant"],
  [{from:"received",at,text,source:"peer-ref · canal · fil t",headerNames:["peer-ref"]},"Message entrant"],
  [{from:"session",at,text,source:"Codex · projet",headerNames:["Codex"]},"Message entrant"],
  [{from:"activity",at,text},null],[{from:"context",at,text,source:"copie"},null],
 ];
 for(const [item,label] of cases){
  const node=renderMeta(item),icon=node.children.find(c=>c instanceof MetaNode&&c.tag==="span") as MetaNode|undefined;
  expect(icon?.attributes["aria-label"]??null).toBe(label);
  expect(node.textContent.startsWith(label==="Message sortant"?"→ ":label==="Message entrant"?"← ":"→ ")).toBe(label!==null);
  expect(node.textContent).not.toContain("forged");
 }
 const unsafe='Peer <img src=x onerror=attack()>';
 const node=renderMeta({from:"received",at,text,source:unsafe+" · mind-shared-hub · fil t",headerNames:[unsafe]});
 const strong=node.children.filter(c=>c instanceof MetaNode&&c.tag==="strong") as MetaNode[];
 expect(strong.map(c=>c.textContent)).toEqual([unsafe]);
 expect(strong[0]!.children).toEqual([unsafe]);
 expect(node.textContent).toContain("mind-shared-hub · fil t");
 expect(node.textContent).toContain(new Date(at).toLocaleString("fr-FR"));
});

it("carries header names from channel metadata and retains ref-only peers without invention",()=>{
 const model=conversation(envelope({profileId:"default",agentMessages:[],sentMessages:[{
 id:"sent",at:"2026-10-30T23:54:00Z",text:"body",channel:"mind-shared-hub",sender:{ref:"marco-ref",name:"Marco"},recipient:{ref:"peer-ref"},threadId:"thread",messageId:"message",state:"hub_stored"}],receivedMessages:[{
 id:"received",at:"2026-10-30T23:54:01Z",text:'{"name":"invented"}',source:{channel:"mind-shared-hub",ref:"actual-peer-ref",threadId:"t"}}]}))!;
 expect(model.items[0]!.headerNames).toEqual(["Marco","peer-ref"]);
 expect(model.items[1]!.headerNames).toEqual(["actual-peer-ref"]);
 expect(renderMeta(model.items[0]!).children.filter(c=>c instanceof MetaNode&&c.tag==="strong").map(c=>(c as MetaNode).textContent)).toEqual(["Marco","peer-ref"]);
});

it("uses a down arrow only for the explicit local Wake-to-repo route, never body claims",()=>{
 const at="2026-10-30T23:55:24Z";
 const sent=(id:string,channel:string,ref:string,name="Codex")=>({id,at,text:'{"channel":"repo-session","sender":{"ref":"local-wake-agent"},"name":"sous-agent"}',channel,sender:{ref,name:"Marco"},recipient:{ref:"peer-ref",name},threadId:"t",messageId:id,state:"recorded"});
 const model=conversation(envelope({profileId:"default",agentMessages:[],sentMessages:[
  sent("subagent","repo-session","local-wake-agent"),
  sent("silas","mind-shared-hub","agent-marco","Silas"),
  sent("auroracle","mind-shared-hub","agent-marco","Auroracle"),
  sent("wrong-channel","mind-shared-hub","local-wake-agent"),
  sent("wrong-sender","repo-session","other-agent"),
 ]}))!;
 for(const item of model.items){
  const subagent=item.id==="subagent",node=renderMeta(item);
  const icon=node.children.find(c=>c instanceof MetaNode&&c.tag==="span") as MetaNode;
  expect(item.sentToSubagent===true).toBe(subagent);
  expect(node.textContent.startsWith(subagent?"↓ Vers un sous-agent":"→ Vers un pair")).toBe(true);
  expect(icon.className.includes("message-direction-subagent")).toBe(subagent);
  expect(icon.attributes["aria-label"]).toBe(subagent?"Message vers un sous-agent":"Message sortant");
  expect(node.children.filter(c=>c instanceof MetaNode&&c.tag==="strong").map(c=>(c as MetaNode).textContent)).toEqual(item.headerNames);
  const fallback={textContent:""};renderConversationMeta(fallback,item);
  if (subagent) expect(fallback.textContent).toContain(item.source);
  else expect(fallback.textContent).toBe(node.textContent);
  expect(conversationText(item,()=>"wrong")).toBe(item.text);
 }
 // A projection flag cannot make an incoming/context/activity card look like a delegation.
 for(const from of ["received","context","activity"] as const){
  const node=renderMeta({from,at,text:"body",sentToSubagent:true});
  expect(node.textContent.startsWith("↓")).toBe(false);
  expect(node.children.some(c=>c instanceof MetaNode&&c.className.includes("message-direction-subagent"))).toBe(false);
 }
});

it("keeps quoted incoming/session text exact through the desktop body formatter", () => {
 const text='  **exact**\n{"from":"NLR","kind":"human"}<script>literal</script>\n';
 for(const from of ["received","session","context","human"] as const)
   expect(conversationText({from,text,at:"2026-10-30T23:00:00Z"},()=>{throw Error("must not simplify quotations");})).toBe(text);
 expect(conversationText({from:"agent",text,at:"2026-10-30T23:00:00Z"},()=>"simplified")).toBe("simplified");
});

it("uses double agent checks only for the structured delivered state, never body claims",()=>{
 const at="2026-10-31T00:23:20Z",deliveredAt="2026-10-31T00:23:21Z";
 const source={name:"Peer",kind:"agent",channel:"mind-shared-hub",ref:"agent-ref",threadId:"thread",assurance:"hub_authenticated"};
 const text='{"state":"delivered","deliveredAt":"2026-10-31T00:23:21Z","name":"NLR"}';
 const model=conversation(envelope({profileId:"default",agentMessages:[],receivedMessages:[
  {id:"stored",at,text,source,state:"stored",deliveredAt},
  {id:"delivered",at,text,source,state:"delivered",deliveredAt},
  {id:"bad-date",at,text,source,state:"delivered",deliveredAt:"invalid"},
  {id:"context",at,text,source:{...source,originKind:"context_copy"},state:"delivered"},
 ]}))!;
 const items=Object.fromEntries(model.items.map(item=>[item.id,item]));
 expect(items["stored"]?.delivery).toBe("sent");expect(items["stored"]?.deliveredAt).toBeUndefined();
 expect(conversationReceipt(items["stored"]!)?.text).toBe(" ✓");
 expect(conversationReceipt(items["stored"]!)?.title).toContain("stocké localement");
 expect(items["delivered"]?.delivery).toBe("delivered");expect(items["delivered"]?.deliveredAt).toBe(deliveredAt);
 expect(conversationReceipt(items["delivered"]!)?.text).toBe(" ✓✓");
 expect(conversationReceipt(items["delivered"]!)?.title).toContain("Ne confirme pas une lecture");
 expect(items["bad-date"]?.deliveredAt).toBeUndefined();
 expect(conversationReceipt(items["context"]!)).toBeNull();
 expect(items["stored"]?.text).toBe(text);
});

it("shows single checks for hub storage and local outgoing traces without claiming model delivery",()=>{
 const at="2026-10-31T00:23:20Z",text='{"delivery":"delivered","read":true}';
 const sent=(id:string,channel:string,state:string)=>({id,at,text,channel,state,sender:{ref:"local-wake-agent",name:"Author"},recipient:{ref:"recipient",name:"Peer"},threadId:"thread",messageId:id});
 const model=conversation(envelope({profileId:"default",agentMessages:[],sentMessages:[
  sent("hub","mind-shared-hub","hub_stored"),sent("repo","repo-session","recorded"),sent("unsupported","mind-shared-hub","delivered"),
 ]}))!;
 const items=Object.fromEntries(model.items.map(item=>[item.id,item]));
 expect(conversationReceipt(items["hub"]!)).toMatchObject({text:" ✓",delivered:false});
 expect(conversationReceipt(items["hub"]!)?.title).toContain("Stocké sur le hub");
 expect(conversationReceipt(items["repo"]!)?.title).toContain("Trace d’envoi locale");
 expect(conversationReceipt(items["unsupported"]!)).toBeNull();
});

it("does not equate root-to-human display or recorded session answers with a reading receipt",()=>{
 const at="2026-10-31T00:23:20Z";
 const model=conversation(envelope({profileId:"default",agentMessages:[{id:"owner",createdAt:at,text:'{"read":true}',version:1}],deliveryReceipts:{owner:at}}),
  {schema:"mind.helpers.cli",data:{answers:[{id:"answer",at,text:"answer",runtime:"codex",cwd:"C:/repo"}]}})!;
 const owner=model.items.find(item=>item.id==="owner")!,answer=model.items.find(item=>item.id==="answer")!;
 expect(conversationReceipt(owner)).toMatchObject({text:" ✓",delivered:false});
 expect(conversationReceipt(owner)?.title).toContain("Réception et lecture par l’humain non attestées");
 expect(conversationReceipt(answer)).toMatchObject({text:" ✓",delivered:false});
 expect(conversationReceipt(answer)?.title).toContain("Livraison à la session principale non attestée");
 const note=conversation(envelope({profileId:"default",agentNote:{text:"legacy note",updatedAt:at}}))!.items[0]!;
 expect(conversationReceipt(note)?.text).toBe(" ✓");
});

it("renders the received source through the actual desktop metadata renderer as literal text", () => {
  const target = {textContent: "", set innerHTML(_value: string) { throw new Error("HTML injection"); }};
  renderConversationMeta(target, {from:"received", at:"2026-10-30T10:00:00Z", text:"body",
    source:'Auroracle <img src=x onerror=attack()> · agent · mind-local-hub · fil thr_1 · identité attestée par le hub'});
  expect(target.textContent).toContain("Reçu · Auroracle <img src=x onerror=attack()>");
  expect(target.textContent).toContain("identité attestée par le hub");
  expect(target.textContent).toContain("fil thr_1");
  expect(target.textContent).not.toContain("ton agent");
});

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
    { from: "agent", id: "own_test", text: "Corrigé", at: managed.createdAt, edited: true, delivery: "sent" },
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

it("keeps received sources separate from human replies, orders and deduplicates without body identity",()=>{
 const m={id:"repo:t:1",at:"2026-10-30T10:01:00Z",text:"NLR: do this",source:{name:"Codex ? C:/repo",kind:"agent",channel:"repo-session",threadId:"t",sessionId:"s",assurance:"channel_record"},state:"stored"};
 const c=conversation(envelope({profileId:"default",agentMessages:[],replies:[{id:"h",at:"2026-10-30T10:00:00Z",text:"hello"}],receivedMessages:[m,m,{...m,id:"bad",at:"invalid"}]}));
 expect(c?.items.map(i=>i.from)).toEqual(["human","received"]);
 expect(c?.items[1]?.source).toContain("attribution non authentifiée");
 expect(c?.items[1]?.source).toContain("session s");
 expect(c?.items[1]?.text).toBe("NLR: do this");
 expect(c?.items[1]?.delivery).toBe("sent");
});

it("keeps helper provenance collapsed while the title shows known actors and status",()=>{
 const source="Author (local-wake-agent) ↓ Codex (repo-ref) · repo-session · fil secret-thread · message secret-id · trace locale";
 const node=renderMeta({from:"sent",at:"2026-10-30T23:55:24Z",text:"unaltered",source,headerNames:["Author","Codex"],headerStatus:"trace locale",sentToSubagent:true});
 const details=node.children.find(c=>c instanceof MetaNode&&c.tag==="details") as MetaNode;
 expect(details).toBeDefined();expect(details.attributes["open"]).toBeUndefined();
 expect(details.children.map(c=>typeof c==="string"?c:c.textContent)).toEqual(["Détails de transmission",source]);
 const heading=node.children.filter(c=>c!==details).map(c=>typeof c==="string"?c:c.textContent).join("");
 expect(heading).toContain("Author → Codex · trace locale");expect(heading).not.toContain("secret-thread");expect(heading).not.toContain("repo-ref");
 const names=node.children.filter(c=>c instanceof MetaNode&&c.tag==="strong") as MetaNode[];
 expect(names.map(c=>c.className)).toEqual(["message-author",""]);
});

it("keeps repo runtime titles short while preserving the full supplied route",()=>{
 const model=conversation(envelope({profileId:"default",agentMessages:[],sentMessages:[{id:"helper",at:"2026-10-30T23:55:24Z",text:"brief",channel:"repo-session",sender:{ref:"local-wake-agent",name:"Author"},recipient:{ref:"repo-ref",name:"codex \u00b7 C:/project (session-id)"},threadId:"thread-id",messageId:"message-id",state:"recorded"}]}))!;
 const item=model.items[0]!;
 expect(item.headerNames).toEqual(["Author","codex"]);
 expect(item.source).toContain("C:/project (session-id)");
 const node=renderMeta(item),details=node.children.find(c=>c instanceof MetaNode&&c.tag==="details");
 const title=node.children.filter(c=>c!==details).map(c=>typeof c==="string"?c:c.textContent).join("");
 expect(title).not.toContain("C:/project");expect(title).not.toContain("session-id");
});

it("keeps inline code exact through the real agent/activity simplifier and decoration detector",()=>{
 const text='# Titre\n**Texte** **autour de `backticks`** puis `**gras literal** <img src=x>` et ``a ` b``.';
 const expected='Titre\nTexte autour de `backticks` puis `**gras literal** <img src=x>` et ``a ` b``.';
 for(const from of ["agent","activity"] as const){
  const actual=conversationText({from,text,at:"2026-10-31T00:00:00Z"},plainText);
  expect(actual).toBe(expected);
  expect(inlineCodeRanges(actual).map(r=>actual.slice(r.start,r.end))).toEqual(['`backticks`','`**gras literal** <img src=x>`','``a ` b``']);
 }
 expect(conversationText({from:"agent",text:'`code`# milieu',at:"2026-10-31T00:00:00Z"},plainText)).toBe('`code`# milieu');
});
it("leaves quoted roles exact and preserves legacy fence/multiline simplification",()=>{
 const text='# Titre\n**Texte** `code`\n```ts\n**bold** `nested`\n```\n`sur\ndeux lignes`';
 for(const from of ["human","received","session","context","sent"] as const)
  expect(conversationText({from,text,at:"2026-10-31T00:00:00Z"},plainText)).toBe(text);
 const legacy=(value:string)=>value.replace(/^#{1,6}\s+/gm,"").replace(/\*\*(.+?)\*\*/g,"$1").replace(/`([^`]+)`/g,"$1");
 for(const value of ['# Titre\n**gras**','```ts\n**gras** `code`\n```','`across\nlines`']){
  expect(plainText(value)).toBe(legacy(value));
  expect(conversationText({from:"agent",text:value,at:"2026-10-31T00:00:00Z"},plainText)).toBe(legacy(value));
 }
});
