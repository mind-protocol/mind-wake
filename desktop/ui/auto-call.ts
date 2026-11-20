// Interrupteur « Actif — appel toutes les 10 min » de la page Appel (NLR, 20 nov. 2026 12:02Z).
// La page ne fait qu'écrire le réglage (auto-call.json, via la commande `auto_call`) et afficher
// l'état : le minuteur et la sonnerie vivent dans le moteur, pas ici.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AutoCallView {
  enabled: boolean;
  nextAt: string | null;
  lastOutcome: string | null;
  lastAt: string | null;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/**
 * Un refus de la sonnerie est une issue normale, pas une panne. « refusé » fait partie des mots
 * d'erreur du relais (app-error-report.ts) : #auto-call-status (role=status) remontait chaque refus
 * comme incident (20 nov. 2026, 17:37Z). Les vrais échecs (« sauté (échec : …) ») restent signalés.
 */
function outcomeLabel(outcome: string): string {
  return outcome.replace("(refusé)", "(décliné)");
}

/** Texte affiché à côté de l'interrupteur (heure locale). */
export function autoCallSummary(view: AutoCallView): string {
  const parts: string[] = [];
  if (view.enabled && view.nextAt !== null) parts.push(`prochain appel à ${hhmm(view.nextAt)}`);
  else if (!view.enabled) parts.push("désactivé");
  if (view.lastOutcome !== null && view.lastAt !== null) parts.push(`dernier : ${outcomeLabel(view.lastOutcome)} à ${hhmm(view.lastAt)}`);
  return parts.join(" · ");
}

export function initAutoCall(invoke: Invoke): void {
  const toggle = document.getElementById("auto-call-enabled") as HTMLInputElement | null;
  const status = document.getElementById("auto-call-status");
  if (toggle === null || status === null) return;
  let busy = false;
  async function update(action: "status" | "on" | "off"): Promise<void> {
    if (busy) return;
    busy = true;
    toggle!.disabled = true;
    try {
      const run = (await invoke("auto_call", { action })) as { exitCode: number; stdout: string };
      const result = JSON.parse(run.stdout) as { ok?: boolean; data?: AutoCallView; error?: { message: string } };
      if (run.exitCode !== 0 || !result.ok || !result.data) throw Error(result.error?.message ?? "Réglage non confirmé");
      toggle!.checked = result.data.enabled;
      status!.textContent = autoCallSummary(result.data);
    } catch (error) {
      status!.textContent = String(error);
    } finally {
      busy = false;
      toggle!.disabled = false;
    }
  }
  toggle.addEventListener("change", () => void update(toggle.checked ? "on" : "off"));
  document.getElementById("tab-call")?.addEventListener("click", () => void update("status"));
  void update("status");
  // L'issue (lancé, décroché, sans réponse, sauté) change sans clic : relecture toutes les 30 s.
  setInterval(() => void update("status"), 30_000);
}
