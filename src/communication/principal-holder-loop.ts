import fs from "node:fs";
import path from "node:path";
import { workspaceDirFor } from "../daemon/paths.js";
import { workspaceCommonPatterns } from "../daemon/common-patterns.js";
import { agentTextCall, fastReplyArgs, fastReplyClaude, type callClaude } from "./fast-reply.js";
import { holderNativeHistory, loadPatternHolders, patternHoldersEnabled, type PatternHolder } from "./pattern-holders.js";
import { principalSeedHistory, PRINCIPAL_CONVERSATIONS_DIR } from "./markdown-conversation.js";
import { NATIVE_HISTORY_NOTICE } from "./native-history.js";
import { preparePrincipalCorpus } from "./fil-continuity.js";
import { createHolderLiveInbox } from "./holder-live-inbox.js";
import { recordHolderPass } from "./wake-gauges.js";

import { PRINCIPAL_FILE_WORK } from "./file-work-prompt.js";

const BETWEEN_TURNS = "Le fil du principal vient d'être modifié entre deux de ses passages (par l'humain ou par le principal).";
export function holderEditingPrompt(holder: PatternHolder, workspace: string, midTurn = false, betweenTurns = false): string {
  return [
    `Tu es ${holder.name} (@${holder.slug}), pattern holder de la room du principal.`,
    workspaceCommonPatterns(workspace),
    PRINCIPAL_FILE_WORK,
    (midTurn ? "Le principal vient d'écrire dans le fil ou de publier un message ; son passage continue en parallèle." : betweenTurns ? BETWEEN_TURNS : "Le principal vient de terminer son passage.") + " Tous les holders de cette room travaillent maintenant en parallèle. Intègre directement tes patterns dans ses conversations Markdown et resserre le contenu pour le garder court et centré sur ce qui compte. Préserve le sens, les décisions et les questions encore ouvertes.",
    `Corpus du principal : ${path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR)}. Tes propres conversations : ${holder.file}.`,
    "Tu peux faire évoluer tes propres fichiers. Attribue tes ajouts à ton nom et ne fabrique pas de paroles historiques du principal ou de l'humain.",
    "Les nouveaux messages de l'humain sont injectés pendant ton passage. Prends ses corrections en compte dans les fichiers dès leur réception.",
    `Tu peux ajouter des prompts de réveil et des réveils dans ${path.join(workspace, "wakeups")}. Lis son schéma et ses exemples avant d'écrire une demande : les contrôles de Pause et Force-off restent applicables.`,
    "Effectue les modifications avec les outils de fichiers. Ne renvoie pas de blocs de remplacement à publier ou à appliquer par un autre agent. Ta sortie finale reste un résultat technique non publié.",
    NATIVE_HISTORY_NOTICE,
  ].join("\n\n");
}

export interface HolderPassOptions {
  dataDir: string;
  allowed: () => boolean;
  call?: typeof callClaude;
  log?: (message: string) => void;
  /** Pass triggered by the principal's writing while its turn continues (holder-pass-trigger.ts). */
  midTurn?: boolean;
  /** Pass triggered by a change of the fil while no principal turn runs (NLR's edit, a script). */
  betweenTurns?: boolean;
}

/** Called after the principal, or during its turn when it writes in the fil (see holder-pass-trigger.ts). No file lock. */
export async function runPrincipalHolders(options: HolderPassOptions): Promise<void> {
  if (!options.allowed() || !patternHoldersEnabled(options.dataDir)) return;
  const { holders, invalid } = loadPatternHolders(options.dataDir);
  for (const error of invalid) options.log?.(`holder : ${JSON.stringify(error)}`);
  const selected = holders.filter(h => h.slug !== "reveilleur" && h.room === 1);
  const workspace = workspaceDirFor(options.dataDir);
  const initialIds = preparePrincipalCorpus(options.dataDir, workspace, "principal");
  // Read the completed principal corpus once, before any holder starts editing it.
  const principal = principalSeedHistory(workspace);
  const outcomes = await Promise.allSettled(selected.map(async holder => {
    if (!options.allowed()) return;
    const dir = path.join(options.dataDir, "pattern-holders", holder.slug);
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, "editing-system.md");
    fs.writeFileSync(promptFile, holderEditingPrompt(holder, workspace, options.midTurn === true, options.betweenTurns === true));
    const claude = fastReplyClaude();
    const args = fastReplyArgs(claude.model, promptFile);
    args[args.indexOf("--tools") + 1] = "Read,Edit,Write,Glob,Grep";
    args.push("--allowedTools", "Read,Edit,Write,Glob,Grep", "--permission-mode", "acceptEdits", "--mcp-config", '{"mcpServers":{}}');
    const history = [...holderNativeHistory(holder, [], []), ...principal.map(turn => ({
      ...turn,
      role: [holder.name.toLowerCase(), holder.slug.toLowerCase()].includes(turn.author.toLowerCase()) ? "assistant" as const : "user" as const,
    }))];
    const liveInbox = createHolderLiveInbox(options.dataDir, dir, initialIds, { id: holder.slug, name: holder.name, icon: holder.emoji });
    const result = await agentTextCall(options.dataDir, options.call, options.allowed, history, true, liveInbox)(
      claude, args, (options.midTurn ? "Le principal vient d'écrire dans le fil, son passage continue." : options.betweenTurns ? BETWEEN_TURNS : "Le passage du principal est terminé.") + " Intègre tes patterns dans ses fichiers et prépare la suite utile.", workspace, 300_000,
    );
    if ("error" in result) throw Error(result.error);
    try {
      recordHolderPass(options.dataDir, holder.slug);
    } catch (error) {
      options.log?.(`holder ${holder.slug} : horodatage du passage non enregistré — ${String(error)}`);
    }
    options.log?.(`holder ${holder.slug} : passage sur fichiers terminé`);
  }));
  outcomes.forEach((result, index) => {
    if (result.status === "rejected") options.log?.(`holder ${selected[index]?.slug ?? "inconnu"} : échec — ${String(result.reason)}`);
  });
}
