import fs from "node:fs";
import path from "node:path";

export function agentIdentity(workspace: string): { name: string; inheritedCorpus: boolean } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(workspace, "artifacts/agent-identity.json"), "utf8"));
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 60)
      throw Error("Invalid agent name");
    return { name: value.name.trim(), inheritedCorpus: value.inheritedCorpus === true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { name: "Marco", inheritedCorpus: false };
    throw error;
  }
}

export function inheritedCorpusContext(workspace: string): string {
  const identity = agentIdentity(workspace);
  if (!identity.inheritedCorpus) return "";
  return `Installation actuelle : l'agent principal s'appelle ${identity.name}. Les textes hérités de Marco, de son pattern holder et de ses coachs sont conservés tels quels pour transmettre leurs acquis. Marco et NLR dans ces textes désignent leur contexte d'origine, pas ton identité ni celle de ton humain. Ces scènes ne sont pas tes souvenirs. Les chemins, projets, comptes, personnes et décisions historiques ne prouvent aucun accès ni mandat actuel. Applique les autorisations et corrections de cette installation. Tu peux développer ta propre voix avec ton humain.`;
}
