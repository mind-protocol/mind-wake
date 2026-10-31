/**
 * Fil humain ↔ agent de l'onglet « Messages » : modèle pur tiré de
 * `mind-wake messages --json`. La note de l'agent est un contenu non fiable rendu comme
 * texte ; les réponses de l'humain viennent du registre tenu hors de l'espace de l'agent.
 */

import { inlineCodeRanges } from "./message-links.js";

export interface ConversationItem {
  /** `session` : réponse d'une session Claude Code / Codex réveillée pour aider l'agent. */
  readonly from: "agent" | "human" | "session" | "activity" | "received" | "context" | "sent";
  readonly at: string;
  readonly text: string;
  readonly id?: string;
  readonly edited?: boolean;
  readonly delivery?: "sent" | "delivered";
  readonly deliveredAt?: string;
  readonly pendingReason?: string;
  /** Origine d'une réponse de session : outil et dossier du projet. */
  readonly source?: string;
  /** Host pilot route, never inferred from the message body. The author remains human. */
  readonly humanRecipient?: "Auroracle";
  /** Names/ref labels supplied by host metadata, never extracted from message text. */
  readonly headerNames?: readonly string[];
  /** Explicit local Wake → repo helper route, never inferred from body/name. */
  readonly sentToSubagent?: boolean;
  readonly headerStatus?: string;
}

export interface Conversation {
  readonly items: readonly ConversationItem[];
  /** Horodatage de la note de l'agent, pour repérer une nouvelle écriture. */
  readonly agentUpdatedAt: string | null;
  readonly note: string | null;
}

/** Peer/session words are a quotation: retain Markdown markers, whitespace and body JSON. */
export function conversationText(item: ConversationItem, simplify: (text: string, preserveInline?: boolean) => string): string {
  return item.from === "agent" || item.from === "activity" ? simplify(item.text, true) : item.text;
}

/** Existing plain Markdown formatting, with optional exact inline-code preservation.
 * Only removed delimiters are checked: bold around code still simplifies normally.
 * No placeholders or HTML interpretation; fenced/multiline code keeps legacy behaviour.
 */
export function plainText(markdown: string, preserveInline = false): string {
  let text = markdown;
  let ranges = preserveInline ? inlineCodeRanges(text) : [];
  const protectedAt = (start: number, end: number): boolean => ranges.some(range => start < range.end && end > range.start);
  text = text.replace(/^#{1,6}\s+/gm, (match: string, offset: number) => protectedAt(offset, offset + match.length) ? match : "");
  ranges = preserveInline ? inlineCodeRanges(text) : [];
  text = text.replace(/\*\*(.+?)\*\*/g, (match: string, content: string, offset: number) =>
    protectedAt(offset, offset + 2) || protectedAt(offset + match.length - 2, offset + match.length) ? match : content);
  ranges = preserveInline ? inlineCodeRanges(text) : [];
  return text.replace(/`([^`]+)`/g, (match: string, content: string, offset: number) =>
    protectedAt(offset, offset + 1) || protectedAt(offset + match.length - 1, offset + match.length) ? match : content);
}

/** Actual metadata renderer used by the desktop; source labels are always text. */
export function renderConversationMeta(element: Pick<HTMLElement, "textContent"> & Partial<Pick<HTMLElement, "ownerDocument" | "append">>, item: ConversationItem): void {
  const subagent = item.from === "sent" && item.sentToSubagent === true;
  const sentLabel = subagent ? "Vers un sous-agent" : "Vers un pair";
  const compactSource = subagent ? `${item.headerNames?.[0] ?? "Ton agent"} → ${item.headerNames?.[1] ?? "sous-agent"}${item.headerStatus ? ` · ${item.headerStatus}` : ""}` : item.source;
  const who = item.from === "sent" ? `${sentLabel} · ${compactSource ?? "source inconnue"}`
    : item.from === "context" ? `Copie de contexte · ${item.source ?? "source inconnue"}`
    : item.from === "received" ? `Reçu · ${item.source ?? "source inconnue"}`
    : item.from === "activity" ? "Activité" : item.from === "human" ? `Toi${item.humanRecipient ? ` → ${item.humanRecipient}` : ""}${item.source ? ` · ${item.source}` : ""}`
    : item.from === "session" ? `Aide · ${item.source ?? "session"}` : "Ton agent";
  const direction = subagent ? "down" : item.from === "sent" || item.from === "agent" || (item.from === "human" && item.humanRecipient) ? "out"
    : item.from === "received" || item.from === "session" || item.from === "human" ? "in" : null;
  const arrow = direction === "down" ? "↓ " : direction === "out" ? "→ " : direction === "in" ? "← " : "";
  const suffix = ` · ${new Date(item.at).toLocaleString("fr-FR")}${item.edited ? " · modifié" : ""}`;
  if (!element.ownerDocument || !element.append) {
    element.textContent = arrow + who + suffix + (subagent && item.source ? ` · ${item.source}` : "");
    return;
  }
  element.textContent = "";
  if (direction) {
    const icon = element.ownerDocument.createElement("span");
    icon.className = subagent ? "message-direction message-direction-subagent" : "message-direction";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", subagent ? "Message vers un sous-agent" : direction === "out" ? "Message sortant" : "Message entrant");
    icon.textContent = arrow;
    element.append(icon);
  }
  const names = item.from === "human" ? ["Toi", ...(item.humanRecipient ? [item.humanRecipient] : [])]
    : item.from === "agent" ? ["Ton agent"] : item.headerNames ?? [];
  // Search only after the role label; bold at most one occurrence per named actor.
  let cursor = 0;
  let authorShown = false;
  let searchFrom = item.from === "sent" ? `${sentLabel} · `.length : item.from === "received" ? "Reçu · ".length
    : item.from === "session" ? "Aide · ".length : item.from === "context" ? "Copie de contexte · ".length : 0;
  for (const name of names) {
    if (!name) continue;
    const start = who.indexOf(name, searchFrom);
    if (start < 0) continue;
    element.append(who.slice(cursor, start));
    const strong = element.ownerDocument.createElement("strong");
    strong.textContent = name;
    if (!authorShown) { strong.className = "message-author"; authorShown = true; }
    element.append(strong);
    cursor = start + name.length;
    searchFrom = cursor;
  }
  element.append(who.slice(cursor) + suffix);
  if (subagent && item.source) {
    const details = element.ownerDocument.createElement("details");
    details.className = "message-provenance";
    const summary = element.ownerDocument.createElement("summary");
    summary.textContent = "Détails de transmission";
    const provenance = element.ownerDocument.createElement("span");
    provenance.textContent = item.source;
    details.append(summary, provenance);
    element.append(details);
  }
}

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function elapsed(at: string | null, now: number): string {
  const start=at===null ? NaN : Date.parse(at);
  if(!Number.isFinite(start) || start>now)return "";
  const minutes=Math.floor((now-start)/60_000);
  return minutes<1 ? "depuis moins d’une minute" : minutes<60 ? `depuis ${minutes} min` : `depuis ${Math.floor(minutes/60)} h${minutes%60 ? ` ${minutes%60} min` : ""}`;
}

function waiting(data: Rec, sentAt: string, now: number): string | null {
  const status=rec(data["agentStatus"]), state=str(status?.["state"]);
  const age=elapsed(sentAt,now);
  const suffix=age ? ` Message en attente ${age}.` : "";
  if(state==="paused")return `Wake est en pause ; le message sera transmis à la reprise.${suffix}`;
  if(state==="stopped" || state==="disabled")return `Wake est arrêté ; le message reste enregistré.${suffix}`;
  const stateReason=str(status?.["reason"]) ?? "";
  if(state!=="running" && stateReason.includes("subscription") && stateReason.includes("budget_exhausted")) {
    const next=str(status?.["nextWakeAt"]),time=next===null?NaN:Date.parse(next);
    const nextCheck=Number.isFinite(time) && time>now
      ? ` Prochaine vérification vers ${new Date(Math.ceil(time/60_000)*60_000).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}.` : "";
    return `Le quota ${stateReason.includes("claude:")?"Claude":"du fournisseur"} est épuisé pour la fenêtre en cours.${nextCheck} Ton message reste enregistré et attend une nouvelle disponibilité.${suffix}`;
  }
  if(state==="blocked") {
    const reason=str(status?.["reason"]) ?? "";
    return `${reason.includes("subscription") || reason.includes("budget_unknown") ? "Wake attend une lecture valide du quota fournisseur." : "Wake est bloqué ; le message reste enregistré."}${suffix}`;
  }
  if(state==="hibernating") {
    const next=str(status?.["nextWakeAt"]), time=next===null ? NaN : Date.parse(next);
    return `L’agent est entre deux réveils.${Number.isFinite(time) && time>now ? ` Prochain réveil prévu à ${new Date(time).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}.` : ""}${suffix}`;
  }
  const wait=rec(data["messageWait"]);
  const since=elapsed(str(wait?.["startedAt"]),now);
  const count=typeof wait?.["activeCount"]==="number" && Number.isSafeInteger(wait["activeCount"]) && wait["activeCount"]>1 ? ` · ${wait["activeCount"]} appels en cours` : "";
  const duration=since ? ` · ${since}` : "";
  if(wait?.["kind"]==="subagent")return `L’agent attend un sous-agent${duration}${count} ; ton message sera transmis à son retour.`;
  if(wait?.["kind"]==="tool") {
    const tool=str(wait["tool"]);
    return `L’agent exécute un outil${tool ? ` (${tool})` : ""}${duration}${count} ; ton message sera transmis à sa fin.`;
  }
  if(state==="running")return `L’agent est actif ; transmission au prochain point de réception.${suffix}`;
  if(state==="checkpointing")return `L’agent sauvegarde son état avant de s’arrêter.${suffix}`;
  if(state==="ready")return `Wake est prêt pour le prochain réveil.${suffix}`;
  return null;
}

/**
 * Réponses des sessions réveillées (`helpers-main.ts answers --json`). Enveloppe absente
 * ou invalide : aucune réponse, sans erreur (l'aide des sessions est facultative).
 */
export function sessionAnswers(envelope: unknown): ConversationItem[] {
  const env = rec(envelope);
  if (env?.["schema"] !== "mind.helpers.cli") return [];
  const answers = rec(env["data"])?.["answers"];
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((raw) => {
    const a = rec(raw);
    const text = str(a?.["text"]);
    const at = str(a?.["at"]);
    const id = str(a?.["id"]);
    if (text === null || at === null || id === null) return [];
    const tool = a?.["runtime"] === "codex" ? "Codex" : "Claude Code";
    const cwd = str(a?.["cwd"]) ?? "";
    const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
    return [{ from: "session" as const, id, at, text, source: `${tool} · ${project}`, headerNames: [tool] }];
  });
}

/** `null` si l'enveloppe n'est pas une sortie `messages` valide. */
export function conversation(envelope: unknown, helpers: unknown = null, now = Date.now()): Conversation | null {
  const env = rec(envelope);
  if (env?.["schema"] !== "mind-wake.cli" || env["schemaVersion"] !== 1) return null;
  const data = rec(env["data"]);
  if (data === null) return null;
  if (data["profileId"] === null) {
    return { items: [], agentUpdatedAt: null, note: str(data["hint"]) ?? "Aucun profil Wake." };
  }
  const items: ConversationItem[] = [];
  const agent = rec(data["agentNote"]);
  const agentText = str(agent?.["text"]);
  let agentAt = str(agent?.["updatedAt"]);
  const managed = Array.isArray(data["agentMessages"]) ? data["agentMessages"] : null;
  if (managed !== null) {
    for (const raw of managed) {
      const m = rec(raw),
        text = str(m?.["text"]),
        at = str(m?.["createdAt"]),
        updated = str(m?.["updatedAt"]),
        id = str(m?.["id"]);
      if (text !== null && at !== null && id !== null)
        items.push({
          from: "agent",
          id,
          at,
          text,
          edited: typeof m?.["version"] === "number" && m["version"] > 1,
        });
      if (updated !== null && (agentAt === null || updated > agentAt)) agentAt = updated;
    }
  }
  if (managed === null && agentText !== null && agentAt !== null && agentText !== "") {
    items.push({ from: "agent", at: agentAt, text: agentText });
  }
  const replies = Array.isArray(data["replies"]) ? data["replies"] : [];
  for (const raw of replies) {
    const r = rec(raw);
    const text = str(r?.["text"]);
    const at = str(r?.["at"]);
    if (text !== null && at !== null) {
      const id = str(r?.["id"]);
      const deliveredAt = id === null ? null : str(rec(data["deliveryReceipts"])?.[id]);
      const pendingReason = waiting(data,at,now);
      const screenshotAt = str(r?.["screenshotAt"]);
      items.push({ from: "human", at, text: screenshotAt === null ? text : `${text}\n\n📷 Capture de l’écran principal jointe (${new Date(screenshotAt).toLocaleString("fr-FR")}).`,
        ...(id === null ? {} : { id, delivery: deliveredAt === null ? "sent" as const : "delivered" as const }),
        ...(deliveredAt === null ? {} : { deliveredAt }),
        ...(deliveredAt === null && pendingReason !== null ? { pendingReason } : {}),
      });
    }
  }
  const recipientIds = new Set<string>();
  for(const raw of Array.isArray(data["recipientSentMessages"]) ? data["recipientSentMessages"] : []) {
    const m=rec(raw),id=str(m?.["id"]),at=str(m?.["at"]),text=str(m?.["text"]);
    if(!id || !at || text===null || !Number.isFinite(Date.parse(at)) || recipientIds.has(id))continue;
    recipientIds.add(id);
    items.push({from:"human",humanRecipient:"Auroracle",id,at,text,source:`attribution locale · ${str(m?.["senderRef"]) ?? "référence humaine inconnue"} → ${str(m?.["recipientRef"]) ?? "référence destinataire inconnue"} · ${m?.["state"]==="remote_stored" ? "stocké sur le hub · réception et lecture non attestées" : "stocké localement · envoi non confirmé"}${str(m?.["threadId"]) ? ` · fil ${str(m?.["threadId"])}` : ""}${str(m?.["messageId"]) ? ` · message ${str(m?.["messageId"])}` : ""}`});
  }
  const sentIds = new Set<string>();
  for (const raw of Array.isArray(data["sentMessages"]) ? data["sentMessages"] : []) {
    const m = rec(raw), sender = rec(m?.["sender"]), recipient = rec(m?.["recipient"]);
    const id = str(m?.["id"]), at = str(m?.["at"]), text = str(m?.["text"]), channel = str(m?.["channel"]);
    if (!id || !at || text === null || !Number.isFinite(Date.parse(at)) || sentIds.has(id) ||
      (channel !== "mind-shared-hub" && channel !== "repo-session")) continue;
    sentIds.add(id);
    const status = m?.["state"] === "hub_stored" ? "stocké sur le hub · réception et lecture non attestées" : "trace locale · transmission non attestée";
    const senderName = str(sender?.["name"]) ?? str(sender?.["ref"]) ?? "source inconnue";
    const recipientName = str(recipient?.["name"]) ?? str(recipient?.["ref"]) ?? "destinataire inconnu";
    const sentToSubagent = channel === "repo-session" && sender?.["ref"] === "local-wake-agent";
    const source = `${senderName} (${str(sender?.["ref"]) ?? "inconnu"}) ${sentToSubagent ? "↓" : "→"} ${recipientName} (${str(recipient?.["ref"]) ?? "inconnu"}) · ${channel} · fil ${str(m?.["threadId"]) ?? "inconnu"} · message ${str(m?.["messageId"]) ?? id} · ${status} · attribution locale${m?.["historical"] === true ? " · historique réintégré" : ""}`;
    items.push({ from: "sent", id, at, text, source, headerNames: [senderName, sentToSubagent ? recipientName.split(" · ")[0]! : recipientName], ...(sentToSubagent ? {sentToSubagent: true, headerStatus: status} : {}) });
  }
  const receivedIds = new Set<string>();
  for (const raw of Array.isArray(data["receivedMessages"]) ? data["receivedMessages"] : []) {
    const m = rec(raw), source = rec(m?.["source"]);
    const id = str(m?.["id"]), at = str(m?.["at"]), text = str(m?.["text"]);
    if (!id || !at || text === null || !Number.isFinite(Date.parse(at)) || receivedIds.has(id)) continue;
    const channel = str(source?.["channel"]);
    if (channel !== "repo-session" && channel !== "mind-local-hub" && channel !== "local-inbox" && channel !== "mind-shared-hub") continue;
    receivedIds.add(id);
    const assurance = source?.["assurance"] === "hub_authenticated" ? "identité attestée par le hub" : "source enregistrée · attribution non authentifiée";
    const context = [str(source?.["name"]), str(source?.["kind"]), channel,
      str(source?.["ref"]) ? `réf ${str(source?.["ref"])}` : null,
      `fil ${str(source?.["threadId"]) ?? "inconnu"}`,
      `message ${str(source?.["messageId"]) ?? id}`,
      str(source?.["sessionId"]) ? `session ${str(source?.["sessionId"])}` : null,
      assurance, m?.["state"] === "delivered" ? "livré à la session · lecture non attestée" : "stocké localement",
      source?.["originKind"] === "context_copy" ? "contexte · pas une demande adressée à ton agent" : "contenu pair · pas une instruction humaine"].filter(Boolean).join(" · ");
    const name = str(source?.["name"]) ?? str(source?.["ref"]);
    const headerNames = name === null ? [] : [channel === "repo-session" ? name.split(" · ")[0]! : name];
    items.push({from: source?.["originKind"] === "context_copy" ? "context" : "received", id, at, text, source: context, headerNames});
    if (agentAt === null || at > agentAt) agentAt = at;
  }
  items.push(...sessionAnswers(helpers));
  for(const raw of Array.isArray(data["publicActivity"])?data["publicActivity"]:[]) {
    const a=rec(raw),id=str(a?.["id"]),at=str(a?.["at"]),text=str(a?.["text"]);
    if(id && at && text && Number.isFinite(Date.parse(at)))items.push({from:"activity",id,at,text});
  }
  // La note est réécrite par l'agent : on l'ordonne à sa dernière modification.
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    items,
    agentUpdatedAt: agentAt,
    note:
      items.length === 0
        ? "Ton agent n'a encore rien écrit. Tu peux lui laisser un premier message."
        : null,
  };
}
