import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConversationRole } from "./contracts.js";

function commonPrompt(): string {
  return fs
    .readFileSync(new URL("../../prompts/conversation/common.md", import.meta.url), "utf8")
    .trim();
}

export function rolePrompt(role: ConversationRole, pass: 1 | 2): string {
  const relative = pass === 1 ? `${role}.md` : `rewrite/${role}.md`;
  const file = fileURLToPath(new URL(`../../prompts/conversation/${relative}`, import.meta.url));
  const base = `${commonPrompt()}\n\n${fs.readFileSync(file, "utf8").trim()}`;
  return pass === 1
    ? base
    : `${base}\n\n${fs.readFileSync(new URL("../../prompts/conversation/rewrite.md", import.meta.url), "utf8").trim()}`;
}

export function leadDraftPrompt(): string {
  return `${commonPrompt()}\n\nTu es le Lead. Commence une réponse utile au message humain pendant que Pattern et Contexte travaillent. Exprime simplement le cadrage et les éléments déjà solides ; garde ouvertes les questions qui dépendent de leurs informations. N'exécute aucune tâche technique. Ce début peut être modifié par l'humain. Réponds en texte naturel, sans JSON ni annonce d'un résultat encore absent.`;
}
