import {
  holderThreads,
  loadPatternHolders,
  patternHoldersEnabled,
  previewPatternHolder,
  readPatternHolderState,
  savePatternHoldersEnabled,
  tickPatternHolders,
} from "../../communication/pattern-holders.js";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";

/**
 * `pattern-holders status|on|off|check|try` : les holders vivent dans le moteur
 * (`daemon run`) ; `check` montre les réveils prévus sans appel modèle, `try` fait un
 * essai réel sans rien publier.
 */
export async function patternHolders(
  ctx: CliContext,
  dataDir: DataDir,
  action: string | undefined,
  slug: string | undefined,
  since: string | undefined,
): Promise<CommandResult<unknown>> {
  const enabled = () => patternHoldersEnabled(dataDir.path);
  switch (action ?? "status") {
    case "status": {
      const { holders, invalid } = loadPatternHolders(dataDir.path);
      const state = readPatternHolderState(dataDir.path);
      const data = {
        enabled: enabled(),
        holders: holders.map((h) => ({
          slug: h.slug,
          name: h.name,
          quietMinutes: h.quietMs / 60_000,
          state: state[h.slug] ?? null,
          threads: holderThreads(dataDir.path, h.slug),
        })),
        invalid,
      };
      return {
        exitCode: 0,
        data,
        human: () =>
          [
            `Pattern holders ${data.enabled ? "activés" : "désactivés"}.`,
            ...data.holders.map(
              (h) =>
                `- @${h.slug} « ${h.name} » [${h.threads.join(", ") || "aucun fil"}] — dernier réveil : ${h.state?.lastResult?.state ?? "aucun"}`,
            ),
            ...invalid.map((i) => `- ignoré ${i.file} : ${i.error}`),
          ].join("\n"),
      };
    }
    case "on":
    case "off":
      savePatternHoldersEnabled(dataDir.path, action === "on");
      return {
        exitCode: 0,
        data: { enabled: action === "on" },
        human: () =>
          action === "on" ? "Pattern holders activés." : "Pattern holders désactivés.",
      };
    case "check": {
      const outcomes = await tickPatternHolders({ dataDir: dataDir.path, dryRun: true });
      return {
        exitCode: 0,
        data: { outcomes },
        human: () =>
          outcomes.length === 0
            ? "Aucun réveil prévu pour les nouveaux messages."
            : outcomes.map((o) => `@${o.slug} : ${o.state} (${o.reason ?? "?"})`).join("\n"),
      };
    }
    case "try": {
      if (slug === undefined || since === undefined)
        throw Error("`pattern-holders try` demande --slug et --since (date ISO)");
      const result = await previewPatternHolder({ dataDir: dataDir.path, slug, since });
      if ("error" in result) {
        ctx.stderr(result.error);
        return { exitCode: 1, data: result, human: () => result.error };
      }
      return {
        exitCode: 0,
        data: result,
        human: () =>
          `Réveil ${result.natural ? "naturel" : "forcé"} (${result.reason}) — rien n'est publié :\n${result.text}`,
      };
    }
    default:
      throw Error(`action inconnue des pattern holders : ${action ?? ""}`);
  }
}
