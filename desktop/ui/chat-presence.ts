import { tr } from "./i18n.js";
import { panelView, STALE_AFTER_MS, type StatusRead } from "./view.js";

const LEGACY_BUMP_SOURCE = "BUMP: Ton user souhaite que tu prennes l’initiative dans la discussion. Deux modes possibles, avec priorité au travail avec des agents : 1. Lance un agent chargé d’enrichir trois propositions dans artifacts/participation-discussion.json. Pour chaque proposition, indique la phrase proposée et ses raisons concrètes de pertinence, puis mène une passe itérative sous plusieurs angles : hypothèses de réponses, recherche si elle est utile, utilité pour la relation et les activités, hypothèse sourcée et révisable du point de vue de NLR, et questions liées. Demande aux agents de comparer les propositions, de les réviser et de recommander la meilleure en expliquant pourquoi. Relis toi-même le résultat, adapte-le et partage une contribution avec ton user. Les agents proposent, explorent et recommandent ; c’est toi, l’agent principal, qui fais le choix final de la contribution, de sa formulation et du moment de l’envoyer à ton user. N’attribue jamais à NLR une réponse simulée ou une hypothèse. 2. Si tu as déjà une idée pertinente en tête, tu peux aussi lui écrire directement ce que tu prévois de faire, une nouvelle idée, une question issue de tes curiosités, ou toute autre contribution qui ferait avancer la relation et les activités. Si cela aide la discussion, tu peux aussi ouvrir une page ou un document dans le panneau droit de l’app pour accompagner ta contribution. Forme ta contribution comme une relance de la conversation : apporte le contexte nécessaire et fais comprendre la valeur de la question ou de la piste proposée. Adresse-toi naturellement à ton humain, comme dans une vraie conversation, par exemple “Dis, j’ai une idée…”. Porte la contribution toi-même : ne commence pas par raconter les pistes ou le travail des agents. Garde ce fonctionnement interne sauf demande explicite. N’inclus pas le préfixe BUMP: dans ta réponse à ton humain.";

export const BUMP_TEXT = "BUMP: Your human wants you to take initiative in the conversation. Two modes are available, prioritizing work with agents: 1. Launch an agent to develop three proposals in artifacts/participation-discussion.json. For each, provide the proposed wording and concrete reasons for its relevance, then iterate from several angles: possible responses, research when useful, value for the relationship and activities, a sourced and revisable hypothesis of NLR’s perspective, and related questions. Ask agents to compare and revise the proposals and recommend the best with reasons. Read the result yourself, adapt it and share a contribution with your human. Agents propose, explore and recommend; you, the main agent, make the final choice of contribution, wording and when to send it. Never attribute a simulated response or hypothesis to NLR. 2. If you already have a relevant idea, you may directly share what you plan to do, a new idea, a question from your curiosities or another contribution that advances the relationship and activities. If useful, open a page or document in the app’s right panel to accompany it. Frame your contribution as a continuation of the conversation: provide enough context and explain the value of the question or direction. Speak naturally to your human, as in a real conversation, for example “Hey, I have an idea…”. Own the contribution: do not begin by describing the agents’ ideas or work. Keep that internal unless explicitly asked. Do not include the BUMP: prefix in your response to your human.";

export const BUMP_PROMPT_PATH = "artifacts/prompts/bump.md";
export type BumpKind = "bump" | "bumpe";
// Compatibility for the exact invitation sent before automatic IDs were marked.
export const LEGACY_BUMP_TEXT = LEGACY_BUMP_SOURCE.slice("BUMP: ".length, LEGACY_BUMP_SOURCE.indexOf(" Si cela aide la discussion,"));
export function automaticBumpKind(item: {from:string;id?:string;text:string}): BumpKind | null {
  if (item.from !== "human" || !item.id) return null;
  if (item.id.startsWith("ui-bumpe-")) return "bumpe";
  if (item.id.startsWith("ui-bump-")) return "bump";
  return /^ui-[0-9a-f-]{36}$/i.test(item.id) && item.text === LEGACY_BUMP_TEXT ? "bump" : null;
}

/** Read once for a new invitation; retries retain their original resolved text. */
export async function resolveBumpText(read: () => Promise<unknown>): Promise<string> {
  try {
    const value = await read() as {format?: unknown; text?: unknown} | null;
    const text = typeof value?.text === "string" ? value.text.trim() : "";
    return value?.format === "markdown" && text.startsWith("BUMP:") && text.length <= 4000 ? text : BUMP_TEXT;
  } catch { return BUMP_TEXT; }
}

export function agentIsWorking(read: StatusRead | null, now: number): boolean {
  if (!read?.ok || panelView(read, now).light !== "awake") return false;
  const envelope = read.envelope as { ok?: unknown; data?: { daemon?: { state?: unknown; mode?: unknown } } };
  return envelope.ok === true && envelope.data?.daemon?.state === "running" && envelope.data.daemon.mode !== "simulated";
}

export function progressReminderLabel(read: StatusRead | null, now: number): string | null {
  if (!read?.ok || now < read.fetchedAt || now - read.fetchedAt > STALE_AFTER_MS) return null;
  const envelope = read.envelope as {ok?: boolean; data?: {ownerProgressReminder?: {state?: string}; daemon?: {state?: string}; profile?: {state?: string}}};
  if (envelope.ok !== true || envelope.data?.daemon?.state !== "running" ||
    !["ready", "running", "hibernating"].includes(envelope.data.profile?.state ?? "")) return null;
  const state = envelope.data.ownerProgressReminder?.state;
  return state === "pending" ? tr("Rappel en attente") : state === "delivered" ? tr("Rappel transmis") : null;
}
