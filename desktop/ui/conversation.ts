/**
 * Fil humain ↔ agent de l'onglet « Messages » : modèle pur tiré de
 * `mind-wake messages --json`. La note de l'agent est un contenu non fiable rendu comme
 * texte ; les réponses de l'humain viennent du registre tenu hors de l'espace de l'agent.
 */

export interface ConversationItem {
  /** `session` : réponse d'une session Claude Code / Codex réveillée pour aider l'agent. */
  readonly from: "agent" | "human" | "session" | "activity" | "received";
  readonly at: string;
  readonly text: string;
  readonly id?: string;
  readonly edited?: boolean;
  readonly delivery?: "sent" | "delivered";
  readonly deliveredAt?: string;
  readonly pendingReason?: string;
  /** Origine d'une réponse de session : outil et dossier du projet. */
  readonly source?: string;
}

export interface Conversation {
  readonly items: readonly ConversationItem[];
  /** Horodatage de la note de l'agent, pour repérer une nouvelle écriture. */
  readonly agentUpdatedAt: string | null;
  readonly note: string | null;
}

/** Actual metadata renderer used by the desktop; source labels are always text. */
export function renderConversationMeta(element: Pick<HTMLElement, "textContent">, item: ConversationItem): void {
  const who = item.from === "received" ? `Reçu · ${item.source ?? "source inconnue"}`
    : item.from === "activity" ? "Activité" : item.from === "human" ? `Toi${item.source ? ` · ${item.source}` : ""}`
    : item.from === "session" ? `Aide · ${item.source ?? "session"}` : "Ton agent";
  element.textContent = `${who} · ${new Date(item.at).toLocaleString("fr-FR")}${item.edited ? " · modifié" : ""}`;
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
    return [{ from: "session" as const, id, at, text, source: `${tool} · ${project}` }];
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
  for(const raw of Array.isArray(data["recipientSentMessages"]) ? data["recipientSentMessages"] : []) {
    const m=rec(raw),id=str(m?.["id"]),at=str(m?.["at"]),text=str(m?.["text"]);
    if(!id || !at || text===null || !Number.isFinite(Date.parse(at)))continue;
    items.push({from:"human",id,at,text:`NLR à Auroracle: ${text}`,source:`Auroracle · ${m?.["state"]==="remote_stored" ? "stocké sur le hub · réception non attestée" : "stocké localement · envoi non confirmé"}${str(m?.["threadId"]) ? ` · fil ${str(m?.["threadId"])}` : ""}`});
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
      str(source?.["sessionId"]) ? `session ${str(source?.["sessionId"])}` : null,
      assurance, m?.["state"] === "delivered" ? "livré à la session · lecture non attestée" : "stocké localement"].filter(Boolean).join(" · ");
    items.push({from: "received", id, at, text, source: context});
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
