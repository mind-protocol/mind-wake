/**
 * Modèle de vue du panneau « Que fait mon agent ? » (SPEC §21.2). Fonction pure :
 * l'enveloppe JSON de `mind-wake status --json` (ou son absence) devient des libellés.
 * Le panneau n'interprète rien de plus que la CLI : aucune mesure n'est inventée, une
 * inconnue reste affichée comme telle, une lecture échouée ou périmée donne « état
 * indisponible » et jamais le dernier état connu (W03).
 */

/** Au-delà, la dernière lecture n'est plus montrée comme l'état courant. */
export const STALE_AFTER_MS = 10_000;

export type Tone = "active" | "idle" | "attention" | "stopped" | "unknown";

/**
 * Voyant et position du sélecteur On / Réveil / Force-off. `awake` : une session tourne ;
 * `on` : Wake peut se réveiller dans ses fenêtres ; `off` : en pause, bloqué ou désactivé ;
 * `forced_off` : arrêt d'urgence ; `unknown` : état indisponible.
 */
export type Light = "awake" | "on" | "off" | "forced_off" | "unknown";

const LIGHTS: Readonly<Record<string, Light>> = {
  running: "awake",
  checkpointing: "awake",
  ready: "on",
  hibernating: "on",
  paused: "off",
  blocked: "off",
  disabled: "off",
  stopped: "forced_off",
};

export const LIGHT_LABELS: Readonly<Record<Light, string>> = {
  awake: "Éveillé",
  on: "Allumé",
  off: "Éteint",
  forced_off: "Arrêt forcé",
  unknown: "Inconnu",
};

export interface Line {
  readonly label: string;
  readonly value: string;
}

export interface PanelView {
  readonly headline: string;
  readonly tone: Tone;
  readonly light: Light;
  /** Réveil au plus tôt possible : profil prêt ou en hibernation. */
  readonly canWake: boolean;
  readonly reason: string;
  readonly simulated: boolean;
  readonly activity: readonly Line[];
  readonly consumption: readonly Line[];
  readonly protection: readonly Line[];
  readonly lastContact: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canStop: boolean;
}

/** Résultat d'une lecture : enveloppe reçue à `fetchedAt`, ou échec. */
export type StatusRead =
  | { readonly ok: true; readonly fetchedAt: number; readonly envelope: unknown }
  | { readonly ok: false; readonly fetchedAt: number; readonly error: string };

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const STATE_LABELS: Readonly<Record<string, { readonly label: string; readonly tone: Tone }>> = {
  disabled: { label: "Désactivé", tone: "idle" },
  ready: { label: "Prêt, en attente d'un créneau", tone: "idle" },
  running: { label: "Travaille", tone: "active" },
  checkpointing: { label: "Prépare sa sauvegarde", tone: "active" },
  hibernating: { label: "Hiberne", tone: "idle" },
  paused: { label: "En pause", tone: "attention" },
  blocked: { label: "Bloqué", tone: "attention" },
  stopped: { label: "Arrêté", tone: "stopped" },
};

const DAEMON_LABELS: Readonly<Record<string, string>> = {
  running: "actif",
  stopped: "arrêté proprement",
  crashed: "interrompu sans arrêt enregistré",
  never: "jamais lancé",
};

function time(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  return `${new Date(at).toLocaleString("fr-FR")} (${relative(at - now)})`;
}

function relative(deltaMs: number): string {
  const s = Math.round(Math.abs(deltaMs) / 1000);
  if (s === 0) return "à l'instant";
  const span =
    s < 60
      ? `${String(s)} s`
      : s < 3600
        ? `${String(Math.round(s / 60))} min`
        : `${String(Math.round(s / 3600))} h`;
  return deltaMs >= 0 ? `dans ${span}` : `il y a ${span}`;
}

function unavailable(reason: string, read: StatusRead, now: number): PanelView {
  return {
    headline: "État indisponible",
    tone: "unknown",
    light: "unknown",
    canWake: false,
    reason,
    simulated: false,
    activity: [],
    consumption: [],
    protection: [],
    lastContact: read.ok ? relative(read.fetchedAt - now) : "aucun contact réussi",
    // La pause et l'arrêt d'urgence passent par la CLI et SQLite, sans le daemon :
    // ils restent proposés même sans lecture d'état.
    canPause: true,
    canResume: false,
    canStop: true,
  };
}

export function panelView(read: StatusRead | null, now: number): PanelView {
  if (read === null) {
    return unavailable("Première lecture en cours.", { ok: false, fetchedAt: now, error: "" }, now);
  }
  if (!read.ok) return unavailable(`Lecture impossible : ${read.error}`, read, now);
  if (now - read.fetchedAt > STALE_AFTER_MS) {
    return unavailable(
      "Dernière lecture trop ancienne pour être affichée comme l'état courant.",
      read,
      now,
    );
  }
  const envelope = rec(read.envelope);
  if (envelope?.["schema"] !== "mind-wake.cli" || envelope["schemaVersion"] !== 1) {
    return unavailable("Format de statut inattendu (schéma mind-wake.cli v1 requis).", read, now);
  }
  const data = rec(envelope["data"]);
  if (data === null) {
    const error = str(rec(envelope["error"])?.["message"]);
    return unavailable(error ?? "Statut sans données.", read, now);
  }
  const profile = rec(data["profile"]);
  if (profile === null) {
    return {
      ...unavailable(str(data["hint"]) ?? "Aucun profil Wake initialisé.", read, now),
      headline: "Wake n'est pas configuré",
      lastContact: "à l'instant",
      canPause: false,
      canStop: false,
    };
  }

  const state = str(profile["state"]) ?? "inconnu";
  const known = STATE_LABELS[state];
  const daemon = rec(data["daemon"]);
  const daemonState = str(daemon?.["state"]) ?? "never";
  const lastSession = rec(data["lastSession"]);
  const lastEvent = rec(data["lastEvent"]);
  const experiment = rec(data["activeExperiment"]);
  const budget = rec(data["budget"]);
  const caps = rec(budget?.["caps"]);
  const period = rec(caps?.["period"]);
  const simulated = str(daemon?.["mode"]) === "simulated" || lastSession?.["simulated"] === true;
  const locked = profile["emergencyStopLocked"] === true;

  const tokens = num(lastSession?.["tokens"]);
  const provenance = str(lastSession?.["provenance"]);
  const consumption: Line[] = [
    {
      label: "Dernière session",
      value:
        tokens === null
          ? "tokens inconnus"
          : `${tokens.toLocaleString("fr-FR")} tokens (${provenance ?? "provenance inconnue"})`,
    },
    {
      label: "Budget disponible",
      value: `inconnu — ${str(budget?.["detail"]) ?? "non consultable"}`,
    },
  ];
  if (caps !== null) {
    const perSession = num(caps["tokensPerSession"]);
    const perPeriod = num(caps["tokensPerPeriod"]);
    const sessions = num(caps["sessionsPerPeriod"]);
    consumption.push({
      label: "Plafonds",
      value: [
        perSession === null ? null : `${perSession.toLocaleString("fr-FR")} tokens/session`,
        perPeriod === null ? null : `${perPeriod.toLocaleString("fr-FR")} tokens/période`,
        sessions === null ? null : `${String(sessions)} sessions/période`,
        str(period?.["kind"]),
      ]
        .filter((part) => part !== null)
        .join(" · "),
    });
  }

  const reserve = num(caps?.["userReserveTokens"]);
  const quota = rec(budget?.["subscriptionQuota"]);
  const protection: Line[] = [
    {
      label: "Réserve humaine",
      value: reserve === null ? "non définie" : `${reserve.toLocaleString("fr-FR")} tokens`,
    },
    {
      label: "Garde de quota fournisseur",
      value:
        quota === null
          ? "aucune"
          : quota["enabled"] === true
            ? `départ sous ${str(quota["startBelow"]) ?? "?"}, arrêt à ${str(quota["stopAt"]) ?? "?"} — jauge du fournisseur, pas une borne de tokens`
            : "désactivée",
    },
    { label: "Prochain réveil", value: time(str(profile["nextWakeAt"]), now) },
  ];

  return {
    headline: known?.label ?? `État ${state}`,
    tone: known?.tone ?? "unknown",
    light: LIGHTS[state] ?? "unknown",
    canWake: !locked && (state === "ready" || state === "hibernating"),
    reason: str(profile["stateReason"]) ?? "motif non communiqué",
    simulated,
    activity: [
      { label: "Exploration", value: str(experiment?.["title"]) ?? "aucune exploration active" },
      {
        label: "Dernier événement",
        value:
          lastEvent === null
            ? "—"
            : `${str(lastEvent["type"]) ?? "?"} — ${str(lastEvent["reason"]) ?? ""} · ${time(str(lastEvent["at"]), now)}`,
      },
      {
        label: "Dernière session",
        value:
          lastSession === null
            ? "aucune"
            : `${str(lastSession["outcome"]) ?? "?"} — ${str(lastSession["reason"]) ?? ""}`,
      },
      {
        label: "Daemon",
        value: `${DAEMON_LABELS[daemonState] ?? daemonState}${simulated ? " (SIMULÉ)" : ""}`,
      },
    ],
    consumption,
    protection,
    lastContact: relative(read.fetchedAt - now),
    canPause: !locked && state !== "paused" && state !== "stopped" && state !== "disabled",
    canResume: !locked && state === "paused",
    canStop: !locked,
  };
}
