import { panelView, type StatusRead } from "./view.js";

export const BUMP_TEXT = "BUMP: Ton user souhaite que tu prennes l’initiative dans la discussion. Deux modes possibles, avec priorité au travail avec des agents : 1. Lance un agent chargé d’enrichir trois propositions dans artifacts/participation-discussion.json. Pour chaque proposition, indique la phrase proposée et ses raisons concrètes de pertinence, puis mène une passe itérative sous plusieurs angles : hypothèses de réponses, recherche si elle est utile, utilité pour la relation et les activités, hypothèse sourcée et révisable du point de vue de NLR, et questions liées. Demande aux agents de comparer les propositions, de les réviser et de recommander la meilleure en expliquant pourquoi. Relis toi-même le résultat, adapte-le et partage une contribution avec ton user. Les agents proposent, explorent et recommandent ; c’est toi, l’agent principal, qui fais le choix final de la contribution, de sa formulation et du moment de l’envoyer à ton user. N’attribue jamais à NLR une réponse simulée ou une hypothèse. 2. Si tu as déjà une idée pertinente en tête, tu peux aussi lui écrire directement ce que tu prévois de faire, une nouvelle idée, une question issue de tes curiosités, ou toute autre contribution qui ferait avancer la relation et les activités. Si cela aide la discussion, tu peux aussi ouvrir une page ou un document dans le panneau droit de l’app pour accompagner ta contribution. Forme ta contribution comme une relance de la conversation : apporte le contexte nécessaire et fais comprendre la valeur de la question ou de la piste proposée. Adresse-toi naturellement à ton humain, comme dans une vraie conversation, par exemple “Dis, j’ai une idée…”. Porte la contribution toi-même : ne commence pas par raconter les pistes ou le travail des agents. Garde ce fonctionnement interne sauf demande explicite. N’inclus pas le préfixe BUMP: dans ta réponse à ton humain.";

export const BUMP_PROMPT_PATH = "artifacts/prompts/bump.md";
export type BumpKind = "bump" | "bumpe";
// Compatibility for the exact invitation sent before automatic IDs were marked.
export const LEGACY_BUMP_TEXT = BUMP_TEXT.slice("BUMP: ".length, BUMP_TEXT.indexOf(" Si cela aide la discussion,"));
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
