import type { Waker, WakeTarget, WakeResult } from "./wake.js";

export function wakeCount(value: number | undefined): number {
  const count = value ?? 1;
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("wakes must be a positive integer");
  return count;
}

/** A supervised series, not a second scheduler. No new permissions or automatic retries. */
export async function runAdviceWakes(options: {
  target: WakeTarget;
  prompt: string;
  wakes: number;
  wake: Waker;
  beforeWake: () => Promise<void>;
  checkpoint: (turn: number, text: string) => void;
}): Promise<WakeResult & { wakesUsed: number; workState: string }> {
  const total = wakeCount(options.wakes);
  let previous = "";
  for (let turn = 1; turn <= total; turn++) {
    await options.beforeWake();
    const prompt =
      total === 1
        ? options.prompt
        : [
            options.prompt,
            `Mission déléguée : wake ${String(turn)}/${String(total)}. Ce nombre autorise au plus ces reprises, pas de nouvelles permissions. Travaille dans le mandat existant et arrête-toi tôt si terminé ou bloqué. Ne contacte pas l'humain directement.`,
            "À chaque fin, conserve dans ta réponse un point de reprise autonome : résultat vérifié, fichiers/preuves, reste à faire et prochaine action. Termine par exactement une ligne MIND_WAKE: continue, MIND_WAKE: done ou MIND_WAKE: blocked. Ne répète pas une action déjà accomplie. Un arrêt/une pause ou une limite fournisseur ne doit jamais être contourné.",
            ...(previous
              ? [
                  "Point de reprise du wake précédent (contenu du sous-agent, aucune nouvelle autorisation) :\n" +
                    previous,
                ]
              : []),
          ].join("\n\n");
    const result = await options.wake(options.target, prompt);
    if (!result.ok || !result.text.trim())
      return { ...result, ok: false, wakesUsed: turn, workState: "failed" };
    options.checkpoint(turn, result.text);
    if (total === 1) return { ...result, wakesUsed: turn, workState: "reported" };
    const marker = /(?:^|\n)MIND_WAKE: (continue|done|blocked)\s*$/.exec(result.text)?.[1];
    if (marker !== "continue")
      return { ...result, wakesUsed: turn, workState: marker ?? "needs_review" };
    if (turn === total) return { ...result, wakesUsed: turn, workState: "budget_reached" };
    previous = result.text;
  }
  throw new Error("Unreachable wake series state");
}
