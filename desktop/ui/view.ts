import { tr, formatLocale } from "./i18n.js";
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
  awake: tr("Éveillé"),
  on: tr("Allumé"),
  off: tr("Éteint"),
  forced_off: tr("Arrêt forcé"),
  unknown: tr("Inconnu"),
};

export interface Line {
  readonly label: string;
  readonly value: string;
}

export interface PanelView {
  readonly activeProject: string | null;
  readonly headline: string;
  readonly tone: Tone;
  readonly light: Light;
  /** Réveil au plus tôt possible : profil prêt ou en hibernation. */
  readonly canWake: boolean;
  readonly alwaysOn: boolean;
  readonly canAlwaysOn: boolean;
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
  disabled: { label: tr("Désactivé"), tone: "idle" },
  ready: { label: tr("Prêt, en attente d'un créneau"), tone: "idle" },
  running: { label: tr("Travaille"), tone: "active" },
  checkpointing: { label: tr("Prépare sa sauvegarde"), tone: "active" },
  hibernating: { label: tr("Hiberne"), tone: "idle" },
  paused: { label: tr("En pause"), tone: "attention" },
  blocked: { label: tr("Bloqué"), tone: "attention" },
  stopped: { label: tr("Arrêté"), tone: "stopped" },
};

const DAEMON_LABELS: Readonly<Record<string, string>> = {
  running: tr("actif"),
  stopped: tr("arrêté proprement"),
  crashed: tr("interrompu sans arrêt enregistré"),
  never: tr("jamais lancé"),
};

function time(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  return `${new Date(at).toLocaleString(formatLocale())} (${relative(at - now)})`;
}

function relative(deltaMs: number): string {
  const s = Math.round(Math.abs(deltaMs) / 1000);
  if (s === 0) return tr("à l'instant");
  const span =
    s < 60
      ? `${String(s)} s`
      : s < 3600
        ? `${String(Math.round(s / 60))} min`
        : `${String(Math.round(s / 3600))} h`;
  return deltaMs >= 0 ? tr("dans {0}", [span]) : tr("il y a {0}", [span]);
}

function unavailable(reason: string, read: StatusRead, now: number): PanelView {
  return {
    activeProject: null,
    headline: tr("État indisponible"),
    tone: "unknown",
    light: "unknown",
    canWake: false,
    alwaysOn: false,
    canAlwaysOn: false,
    reason,
    simulated: false,
    activity: [],
    consumption: [],
    protection: [],
    lastContact: read.ok ? relative(read.fetchedAt - now) : tr("aucun contact réussi"),
    // La pause et l'arrêt d'urgence passent par la CLI et SQLite, sans le daemon :
    // ils restent proposés même sans lecture d'état.
    canPause: true,
    canResume: false,
    canStop: true,
  };
}

export function panelView(read: StatusRead | null, now: number): PanelView {
  if (read === null) {
    return unavailable(tr("Première lecture en cours."), { ok: false, fetchedAt: now, error: "" }, now);
  }
  if (!read.ok) return unavailable(tr("Lecture impossible : {0}", [read.error]), read, now);
  if (now - read.fetchedAt > STALE_AFTER_MS) {
    return unavailable(
      tr("Dernière lecture trop ancienne pour être affichée comme l'état courant."),
      read,
      now,
    );
  }
  const envelope = rec(read.envelope);
  if (envelope?.["schema"] !== "mind-wake.cli" || envelope["schemaVersion"] !== 1) {
    return unavailable(tr("Format de statut inattendu (schéma mind-wake.cli v1 requis)."), read, now);
  }
  const data = rec(envelope["data"]);
  if (data === null) {
    const error = str(rec(envelope["error"])?.["message"]);
    return unavailable(error ?? tr("Statut sans données."), read, now);
  }
  const profile = rec(data["profile"]);
  if (profile === null) {
    return {
      ...unavailable(str(data["hint"]) ?? tr("Aucun profil Wake initialisé."), read, now),
      headline: tr("Wake n'est pas configuré"),
      lastContact: tr("à l'instant"),
      canPause: false,
      canStop: false,
    };
  }

  const state = str(profile["state"]) ?? tr("inconnu");
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
      label: tr("Dernière session"),
      value:
        tokens === null
          ? tr("tokens inconnus")
          : `${tokens.toLocaleString(formatLocale())} tokens (${provenance ?? tr("provenance inconnue")})`,
    },
    {
      label: tr("Budget disponible"),
      value: tr("inconnu — {0}", [str(budget?.["detail"]) ?? tr("non consultable")]),
    },
  ];
  if (caps !== null) {
    const perSession = num(caps["tokensPerSession"]);
    const perPeriod = num(caps["tokensPerPeriod"]);
    const sessions = num(caps["sessionsPerPeriod"]);
    consumption.push({
      label: tr("Plafonds"),
      value: [
        perSession === null ? null : `${perSession.toLocaleString(formatLocale())} tokens/session`,
        perPeriod === null ? null : tr("{0} tokens/période", [perPeriod.toLocaleString(formatLocale())]),
        sessions === null ? null : tr("{0} sessions/période", [String(sessions)]),
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
      label: tr("Réserve humaine"),
      value: reserve === null ? tr("non définie") : `${reserve.toLocaleString(formatLocale())} tokens`,
    },
    {
      label: tr("Garde de quota fournisseur"),
      value:
        quota === null
          ? tr("aucune")
          : quota["enabled"] === true
            ? tr("départ sous {0}, arrêt à {1} — jauge du fournisseur, pas une borne de tokens", [str(quota["startBelow"]) ?? "?", str(quota["stopAt"]) ?? "?"])
            : tr("désactivée"),
    },
    { label: tr("Prochain réveil"), value: time(str(profile["nextWakeAt"]), now) },
  ];

  return {
    headline: known?.label ?? tr("État {0}", [state]),
    activeProject: str(data["activeProject"]),
    tone: known?.tone ?? "unknown",
    light: LIGHTS[state] ?? "unknown",
    canWake: !locked && (state === "ready" || state === "hibernating"),
    alwaysOn:
      data["executionMode"] === "always-on" &&
      ["ready", "hibernating", "running", "checkpointing"].includes(state),
    canAlwaysOn:
      state === "stopped" || (!locked && ["ready", "hibernating", "running", "checkpointing", "paused"].includes(state)),
    reason: profile["stateReason"] === "launch.allowed" ? tr("L’agent travaille sur une session autorisée.") : str(profile["stateReason"]) ?? tr("motif non communiqué"),
    simulated,
    activity: [
      { label: tr("Exploration"), value: str(experiment?.["title"]) ?? tr("aucune exploration active") },
      {
        label: tr("Dernier événement"),
        value:
          lastEvent === null
            ? "—"
            : `${str(lastEvent["reason"]) ?? str(lastEvent["type"]) ?? "?"} · ${time(str(lastEvent["at"]), now)}`,
      },
      {
        label: tr("Dernière session"),
        value:
          lastSession === null
            ? tr("aucune")
            : `${str(lastSession["outcome"]) ?? "?"} — ${str(lastSession["reason"]) ?? ""}`,
      },
      {
        label: "Daemon",
        value: `${DAEMON_LABELS[daemonState] ?? daemonState}${simulated ? tr(" (SIMULÉ)") : ""}`,
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
