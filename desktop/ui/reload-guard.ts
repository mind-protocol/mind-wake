// Rechargement demandé par `npm run desktop:ui` (.reload-stamp) : différé tant qu'un appel
// sonne ou est en cours, sinon l'iframe d'appel est détruite en plein appel.
// Le watcher Rust appelle `window.__mindWakeUiUpdated()` quand la page l'expose.

export type CallStage = "ringing" | "active" | null;

export interface ReloadGuardDeps {
  reload: () => void;
  /** Indicateur discret « mise à jour prête » ; `false` le retire. */
  showPending: (pending: boolean) => void;
  now?: () => number;
}

export interface ReloadGuard {
  /** Le stamp a changé : recharge tout de suite, ou attend la fin de l'appel. */
  requested(): void;
  /** Suivi de l'état d'appel (même source que le toast téléphone). */
  callStage(stage: CallStage, until?: number): void;
  /** Revérifie (sonnerie expirée sans message de fin). */
  check(): void;
  pending(): boolean;
}

export function reloadGuard(deps: ReloadGuardDeps): ReloadGuard {
  const now = deps.now ?? Date.now;
  let stage: CallStage = null;
  let ringUntil = 0;
  let waiting = false;
  const busy = () => stage === "active" || (stage === "ringing" && (!ringUntil || now() < ringUntil));
  const check = () => {
    if (!waiting || busy()) return;
    waiting = false;
    deps.showPending(false);
    deps.reload();
  };
  return {
    requested() {
      if (!busy()) { if (waiting) { waiting = false; deps.showPending(false); } deps.reload(); return; }
      if (!waiting) deps.showPending(true);
      waiting = true;
    },
    callStage(next, until) {
      stage = next;
      ringUntil = next === "ringing" && typeof until === "number" ? until : 0;
      check();
    },
    check,
    pending: () => waiting,
  };
}

/** Pastille discrète en bas à droite ; cliquable pour recharger quand même. */
export function pendingBadge(doc: Document, reloadNow: () => void): (pending: boolean) => void {
  let badge: HTMLButtonElement | null = null;
  return (pending) => {
    if (!pending) { badge?.remove(); badge = null; return; }
    if (badge) return;
    badge = doc.createElement("button");
    badge.type = "button";
    badge.id = "ui-update-pending";
    badge.textContent = "mise à jour prête";
    badge.title = "Interface recompilée : rechargement après l’appel. Cliquer pour recharger maintenant (coupe l’appel).";
    Object.assign(badge.style, {
      position: "fixed", right: "8px", bottom: "8px", zIndex: "9999", padding: "2px 8px",
      font: "11px system-ui, sans-serif", opacity: "0.6", border: "1px solid currentColor",
      borderRadius: "10px", background: "transparent", color: "inherit", cursor: "pointer",
    });
    badge.addEventListener("click", reloadNow);
    doc.body.append(badge);
  };
}
