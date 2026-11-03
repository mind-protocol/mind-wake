import { tr } from "./i18n.js";

export interface WelcomeProgress {
  stage:
    | "unprepared"
    | "consent"
    | "existing"
    | "held"
    | "starting"
    | "working"
    | "awaiting_human"
    | "reply_pending"
    | "complete"
    | "error";
  settings: { model: string; timeZone: string; sources: string[] };
  reason?: string;
  error?: string;
  nativeApproved?: boolean;
  evidence?: { deliveredAt?: string | null };
}
export function welcomeMessage(progress: WelcomeProgress): string {
  switch (progress.stage) {
    case "consent":
      return tr("Tout est prêt. Relis les accès ci-dessous, puis démarre ton agent.");
    case "starting":
      return tr("Le premier réveil est demandé. Connexion au runtime en cours…");
    case "working":
      return tr("Ton agent prend ses marques. Son premier message apparaîtra ici.");
    case "awaiting_human":
      return tr(
        "Ton agent t’a écrit. Réponds-lui dans le champ ci-dessous pour faire connaissance.",
      );
    case "reply_pending":
      return progress.evidence?.deliveredAt
        ? tr(
            "Ta réponse a été transmise à la session. En attente du prochain message de ton agent…",
          )
        : tr("Ta réponse est enregistrée. Elle attend sa transmission à ton agent…");
    case "complete":
      return tr(
        "Votre premier échange est dans la conversation. Ton agent peut continuer ses explorations.",
      );
    case "held":
      return tr(
        "Wake est en pause, arrêté ou bloqué. Tes choix sont conservés ; utilise les contrôles habituels pour reprendre.",
      );
    case "error":
      return tr(
        "Le premier réveil n’a pas abouti. Tu peux réessayer ; la préparation est conservée.",
      );
    case "unprepared":
      return tr(
        "Ton agent installateur doit terminer la connexion locale avant le premier réveil.",
      );
    case "existing":
      return "";
  }
}

export function mountOnboarding(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  focusConversation: () => void,
): { refresh: () => Promise<void> } {
  const container = document.getElementById("general-conversation");
  if (!container) throw Error("Conversation introuvable.");
  const card = document.createElement("section");
  card.className = "onboarding-card";
  card.hidden = true;
  card.setAttribute("aria-label", tr("Premier accueil"));
  const title = document.createElement("h2");
  title.textContent = tr("Bienvenue dans Wake");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const scope = document.createElement("p");
  scope.className = "hint";
  const consent = document.createElement("label");
  consent.className = "onboarding-consent";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const description = document.createElement("span");
  description.textContent = tr(
    "J’autorise mon agent à travailler en mode natif avec mon compte Codex et mon abonnement. Il agit avec les accès Windows de mon compte ; son dossier n’est pas une sandbox. Il peut créer dans son espace et lire les sources indiquées. Pause et arrêt restent disponibles. Aucun achat, publication, contact avec un tiers, capture d’écran ou collecte de texte n’est activé ici.",
  );
  consent.append(checkbox, description);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = tr("Démarrer mon agent");
  button.disabled = true;
  const error = document.createElement("p");
  error.className = "hint";
  error.setAttribute("role", "alert");
  card.append(title, status, scope, consent, button, error);
  container.prepend(card);
  let busy = false,
    loading = false,
    focused = false,
    complete = false;
  let progress: WelcomeProgress | null = null;
  const request = async (
    command: string,
    args?: Record<string, unknown>,
  ): Promise<WelcomeProgress> => {
    const result = (await invoke(command, args)) as { exitCode: number; stdout: string };
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: WelcomeProgress;
      error?: { message?: string };
    };
    if (result.exitCode !== 0 || !envelope.ok)
      throw Error(envelope.error?.message ?? tr("Premier accueil indisponible."));
    return envelope.data;
  };
  const render = (value: WelcomeProgress): void => {
    progress = value;
    card.hidden = value.stage === "existing";
    if (card.hidden) {
      complete = true;
      return;
    }
    if (!focused) {
      focused = true;
      focusConversation();
    }
    status.textContent = welcomeMessage(value);
    const canStart = value.stage === "consent" || value.stage === "error";
    consent.hidden = !canStart || value.nativeApproved === true;
    button.hidden = !canStart;
    scope.hidden = !canStart;
    scope.textContent = tr(
      "Codex · {0} · {1}. Sources en lecture : {2}. Écriture dans l’espace personnel Wake.",
      [
        value.settings.model,
        value.settings.timeZone,
        value.settings.sources.join(" · ") || tr("l’espace Wake uniquement"),
      ],
    );
    button.textContent =
      value.stage === "error" ? tr("Réessayer le démarrage") : tr("Démarrer mon agent");
    button.disabled = busy || (!value.nativeApproved && !checkbox.checked);
    error.textContent = value.error ?? "";
    complete = value.stage === "complete";
  };
  checkbox.onchange = () => {
    button.disabled = busy || (!progress?.nativeApproved && !checkbox.checked);
  };
  button.onclick = async () => {
    if (busy || (!progress?.nativeApproved && !checkbox.checked)) return;
    busy = true;
    button.disabled = true;
    checkbox.disabled = true;
    error.textContent = "";
    status.textContent = tr("Préparation du premier réveil…");
    try {
      render(await request("onboarding_start", { acceptNative: true }));
    } catch (failure) {
      if (progress) render({ ...progress, stage: "error", error: String(failure) });
    } finally {
      busy = false;
      checkbox.disabled = false;
      if (progress) render(progress);
    }
  };
  return {
    refresh: async () => {
      if (loading || busy || complete) return;
      loading = true;
      try {
        render(await request("onboarding_status"));
      } catch (failure) {
        if (!card.hidden) error.textContent = String(failure);
      } finally {
        loading = false;
      }
    },
  };
}
