/**
 * Graphe réveils / consommation : modèle pur tiré de `mind-wake journal --json`. Un réveil
 * est un `session_started` ; la consommation vient du `session_ended` correspondant
 * (tokens et provenance tels que journalisés). Une session sans tokens reste « inconnue »,
 * jamais comptée à zéro ; une session simulée est marquée comme telle.
 */

export interface SessionPoint {
  readonly sessionId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly tokens: number | null;
  readonly outcome: string | null;
  readonly simulated: boolean;
  readonly provenance: string | null;
}

export interface ActivityModel {
  readonly sessions: readonly SessionPoint[];
  readonly from: number;
  readonly to: number;
  readonly maxTokens: number;
  readonly totalKnownTokens: number;
  readonly unknownCount: number;
  readonly simulated: boolean;
}

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function time(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** Sessions de la fenêtre `[now - spanMs, now]`, triées par réveil. `null` si l'enveloppe est invalide. */
export function activityModel(
  envelope: unknown,
  now: number,
  spanMs: number,
): ActivityModel | null {
  const env = rec(envelope);
  if (env?.["schema"] !== "mind-wake.cli" || env["schemaVersion"] !== 1) return null;
  const events = rec(env["data"])?.["events"];
  if (!Array.isArray(events)) return null;

  const byId = new Map<string, { -readonly [K in keyof SessionPoint]: SessionPoint[K] }>();
  for (const raw of events) {
    const event = rec(raw);
    const id = event?.["sessionId"];
    if (event === null || typeof id !== "string") continue;
    const point = byId.get(id) ?? {
      sessionId: id,
      startedAt: null,
      endedAt: null,
      tokens: null,
      outcome: null,
      simulated: false,
      provenance: null,
    };
    if (event["type"] === "session_started") point.startedAt = time(event["at"]);
    if (event["type"] === "session_ended") {
      const meta = rec(event["metadata"]);
      point.endedAt = time(event["at"]);
      const tokens = meta?.["tokens"];
      point.tokens = typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
      point.outcome = typeof meta?.["outcome"] === "string" ? meta["outcome"] : null;
      point.simulated = meta?.["simulated"] === true;
      point.provenance = typeof meta?.["provenance"] === "string" ? meta["provenance"] : null;
    }
    byId.set(id, point);
  }

  const from = now - spanMs;
  const sessions = [...byId.values()]
    .filter((s) => (s.startedAt ?? s.endedAt ?? 0) >= from)
    .sort((a, b) => (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0));
  const known = sessions.flatMap((s) => (s.tokens === null ? [] : [s.tokens]));
  return {
    sessions,
    from,
    to: now,
    maxTokens: Math.max(0, ...known),
    totalKnownTokens: known.reduce((a, b) => a + b, 0),
    unknownCount: sessions.length - known.length,
    simulated: sessions.some((s) => s.simulated),
  };
}
