/**
 * Validation d'un brouillon de policy (SPEC §4). Le brouillon est une donnée non fiable :
 * il peut venir de la skill, donc du modèle. Tout champ de limite obligatoire absent ou
 * invalide interdit la création d'une révision, et tout champ inconnu est refusé.
 */

import { REQUIRED_LIMIT_FIELDS } from "../contracts/policy.js";
import type { PolicyDraft, PolicyGroups } from "../contracts/policy.js";

export type ValidationIssueCode = "missing" | "invalid" | "unknown_field" | "inconsistent";

export interface ValidationIssue {
  /** Chemin `groupe.champ` (ou `groupe` seul) concerné. */
  readonly field: string;
  readonly code: ValidationIssueCode;
  readonly detail: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly groups: PolicyGroups }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Valeurs par défaut sûres des champs facultatifs : aucun accès fichier, aucun outil,
 * aucun réseau, aucune dépense, purge manuelle. Les limites obligatoires n'ont pas de
 * valeur par défaut : un budget ne se déduit pas (SPEC §4), il doit être validé.
 */
export const SAFE_DEFAULTS = {
  readRoots: [] as readonly string[],
  writeRoots: [] as readonly string[],
  allowedExecutables: [] as readonly string[],
  explorationDestinations: [],
  providerTransportDestinations: [],
  paidApi: { authorized: false },
  purge: "manual",
  exportPaths: [] as readonly string[],
} as const;

/** Brouillon initial : aucune dépense ni réseau, limites à renseigner avant activation. */
export function createSafeDraft(identity: NonNullable<PolicyDraft["identity"]>): PolicyDraft {
  return {
    identity,
    filesAndTools: {
      readRoots: SAFE_DEFAULTS.readRoots,
      writeRoots: SAFE_DEFAULTS.writeRoots,
      allowedExecutables: SAFE_DEFAULTS.allowedExecutables,
    },
    network: {
      explorationDestinations: SAFE_DEFAULTS.explorationDestinations,
      providerTransportDestinations: SAFE_DEFAULTS.providerTransportDestinations,
    },
    budget: { paidApi: SAFE_DEFAULTS.paidApi },
    data: { purge: SAFE_DEFAULTS.purge, exportPaths: SAFE_DEFAULTS.exportPaths },
  };
}

const GROUP_FIELDS: { readonly [G in keyof PolicyGroups]: readonly (keyof PolicyGroups[G])[] } = {
  identity: ["profileId", "agentId"],
  runtime: ["adapterId", "provider", "model", "authMode"],
  schedule: ["timeZone", "weeklyWindows", "minIntervalBetweenSessionsMs", "maxSessionDurationMs"],
  humanPriority: [
    "activitySignal",
    "idleThresholdMs",
    "maxSignalAgeMs",
    "maxInterruptLatencyMs",
    "maxTerminationLatencyMs",
  ],
  budget: [
    "period",
    "tokensPerSession",
    "tokensPerPeriod",
    "sessionsPerPeriod",
    "userReserveTokens",
    "checkpointTokens",
    "paidApi",
  ],
  filesAndTools: [
    "readRoots",
    "writeRoots",
    "allowedExecutables",
    "maxProcesses",
    "maxStorageBytes",
  ],
  network: ["explorationDestinations", "providerTransportDestinations"],
  data: ["eventRetentionDays", "localStorageCapBytes", "purge", "exportPaths"],
};

const REQUIRED = new Set<string>(REQUIRED_LIMIT_FIELDS);

type Obj = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(obj: Obj, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isText(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

function isInt(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

export function isValidTimeZone(value: unknown): value is string {
  if (!isText(value, 64)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes depuis minuit ; `24:00` n'est accepté qu'en fin de fenêtre. */
export function parseHhMm(value: string, allowEndOfDay: boolean): number | null {
  if (allowEndOfDay && value === "24:00") return 1440;
  if (!HHMM.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/**
 * Racine ou chemin confiné : relatif, séparateurs `/`, aucun segment vide, `.` ou `..`,
 * aucun `\`, `:` (lecteur ou flux alternatif NTFS), caractère de contrôle, ni segment
 * terminé par un point ou une espace (normalisés par Windows). La racine `.` désigne tout
 * l'espace d'exploration.
 */
export function isConfinedPath(value: unknown, allowWholeSpace: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (allowWholeSpace && value === ".") return true;
  if (CONTROL_CHARS.test(value) || /[\\:*?"<>|]/.test(value) || value.startsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !segment.endsWith(" "),
    );
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Hôte exact en minuscules, sans joker ni port ; aucune destination « tout le réseau ». */
export function isValidHost(value: unknown): value is string {
  return typeof value === "string" && HOSTNAME.test(value);
}

class Collector {
  readonly issues: ValidationIssue[] = [];
  add(field: string, code: ValidationIssueCode, detail: string): void {
    this.issues.push({ field, code, detail });
  }
}

/** Lit un champ ; signale l'absence si le champ est une limite obligatoire. */
function field(c: Collector, group: Obj, groupName: string, name: string): unknown {
  const value = own(group, name);
  if (value === undefined && REQUIRED.has(`${groupName}.${name}`)) {
    c.add(`${groupName}.${name}`, "missing", "champ de limite obligatoire absent");
  }
  return value;
}

function textField(c: Collector, group: Obj, g: string, name: string): string | undefined {
  const value = field(c, group, g, name);
  if (value === undefined) return undefined;
  if (!isText(value)) {
    c.add(`${g}.${name}`, "invalid", "texte non vide attendu, sans caractère de contrôle");
    return undefined;
  }
  return value;
}

function intField(
  c: Collector,
  group: Obj,
  g: string,
  name: string,
  min: number,
): number | undefined {
  const value = field(c, group, g, name);
  if (value === undefined) return undefined;
  if (!isInt(value, min)) {
    c.add(`${g}.${name}`, "invalid", `entier sûr ≥ ${String(min)} attendu`);
    return undefined;
  }
  return value;
}

function listField<T>(
  c: Collector,
  group: Obj,
  g: string,
  name: string,
  fallback: readonly T[] | undefined,
  item: (value: unknown, index: number) => T | undefined,
): readonly T[] | undefined {
  const value = field(c, group, g, name);
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    c.add(`${g}.${name}`, "invalid", "liste attendue");
    return undefined;
  }
  const out: T[] = [];
  let ok = true;
  for (const [index, entry] of (value as readonly unknown[]).entries()) {
    const parsed = item(entry, index);
    if (parsed === undefined) ok = false;
    else out.push(parsed);
  }
  return ok ? out : undefined;
}

function uniqueStrings(c: Collector, path: string, values: readonly string[] | undefined): void {
  if (values !== undefined && new Set(values).size !== values.length) {
    c.add(path, "invalid", "doublon dans la liste");
  }
}

function groupObject(c: Collector, draft: Obj, name: keyof PolicyGroups): Obj {
  const value = own(draft, name);
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    c.add(name, "invalid", "objet attendu");
    return {};
  }
  const allowed = new Set<string>(GROUP_FIELDS[name] as readonly string[]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) c.add(`${name}.${key}`, "unknown_field", "champ inconnu refusé");
  }
  return value;
}

/**
 * Valide un brouillon et produit des groupes complets. `expectedProfileId` empêche de
 * créer une révision pour un autre profil que celui du canal appelant.
 */
export function validateDraft(draft: unknown, expectedProfileId?: string): ValidationResult {
  const c = new Collector();
  if (!isPlainObject(draft)) {
    return { ok: false, issues: [{ field: "", code: "invalid", detail: "objet attendu" }] };
  }
  const groupNames = Object.keys(GROUP_FIELDS);
  for (const key of Object.keys(draft)) {
    if (!groupNames.includes(key)) c.add(key, "unknown_field", "groupe inconnu refusé");
  }

  const identity = groupObject(c, draft, "identity");
  const profileId = textField(c, identity, "identity", "profileId");
  const agentId = textField(c, identity, "identity", "agentId");
  if (profileId === undefined) c.add("identity.profileId", "missing", "profil requis");
  if (agentId === undefined) c.add("identity.agentId", "missing", "agent requis");
  if (
    profileId !== undefined &&
    expectedProfileId !== undefined &&
    profileId !== expectedProfileId
  ) {
    c.add("identity.profileId", "inconsistent", "profil différent du profil courant");
  }

  const runtime = groupObject(c, draft, "runtime");
  const adapterId = textField(c, runtime, "runtime", "adapterId");
  const provider = textField(c, runtime, "runtime", "provider");
  const model = textField(c, runtime, "runtime", "model");
  const authMode = textField(c, runtime, "runtime", "authMode");

  const schedule = groupObject(c, draft, "schedule");
  const scheduleTz = field(c, schedule, "schedule", "timeZone");
  if (scheduleTz !== undefined && !isValidTimeZone(scheduleTz)) {
    c.add("schedule.timeZone", "invalid", "fuseau IANA inconnu");
  }
  const weeklyWindows = listField(
    c,
    schedule,
    "schedule",
    "weeklyWindows",
    undefined,
    (entry, index) => {
      const path = `schedule.weeklyWindows[${String(index)}]`;
      if (
        !isPlainObject(entry) ||
        Object.keys(entry).some((k) => !["day", "start", "end"].includes(k))
      ) {
        c.add(path, "invalid", "fenêtre { day, start, end } attendue");
        return undefined;
      }
      const day = own(entry, "day");
      const start = own(entry, "start");
      const end = own(entry, "end");
      if (!isInt(day, 0) || day > 6 || typeof start !== "string" || typeof end !== "string") {
        c.add(path, "invalid", "jour 0..6 et heures HH:MM attendus");
        return undefined;
      }
      const s = parseHhMm(start, false);
      const e = parseHhMm(end, true);
      if (s === null || e === null || s >= e) {
        c.add(path, "invalid", "début < fin attendu, au format HH:MM, sans franchir minuit");
        return undefined;
      }
      return { day: day as 0 | 1 | 2 | 3 | 4 | 5 | 6, start, end };
    },
  );
  const minInterval = intField(c, schedule, "schedule", "minIntervalBetweenSessionsMs", 0);
  const maxSession = intField(c, schedule, "schedule", "maxSessionDurationMs", 1);

  const priority = groupObject(c, draft, "humanPriority");
  const activitySignal = textField(c, priority, "humanPriority", "activitySignal");
  const idleThreshold = intField(c, priority, "humanPriority", "idleThresholdMs", 0);
  const maxSignalAge = intField(c, priority, "humanPriority", "maxSignalAgeMs", 1);
  const interruptLatency = intField(c, priority, "humanPriority", "maxInterruptLatencyMs", 1);
  const terminationLatency = intField(c, priority, "humanPriority", "maxTerminationLatencyMs", 1);

  const budget = groupObject(c, draft, "budget");
  const period = validatePeriod(c, field(c, budget, "budget", "period"));
  const tokensPerSession = intField(c, budget, "budget", "tokensPerSession", 1);
  const tokensPerPeriod = intField(c, budget, "budget", "tokensPerPeriod", 1);
  const sessionsPerPeriod = intField(c, budget, "budget", "sessionsPerPeriod", 1);
  const userReserve = intField(c, budget, "budget", "userReserveTokens", 0);
  const checkpointTokens = intField(c, budget, "budget", "checkpointTokens", 1);
  const paidApi = validatePaidApi(c, field(c, budget, "budget", "paidApi"));
  if (
    tokensPerSession !== undefined &&
    tokensPerPeriod !== undefined &&
    userReserve !== undefined
  ) {
    if (userReserve >= tokensPerPeriod) {
      c.add("budget.userReserveTokens", "inconsistent", "la réserve doit être < tokensPerPeriod");
    } else if (tokensPerSession > tokensPerPeriod - userReserve) {
      c.add(
        "budget.tokensPerSession",
        "inconsistent",
        "une session doit tenir dans tokensPerPeriod − userReserveTokens",
      );
    }
  }
  if (
    tokensPerSession !== undefined &&
    checkpointTokens !== undefined &&
    checkpointTokens >= tokensPerSession
  ) {
    c.add("budget.checkpointTokens", "inconsistent", "doit être < tokensPerSession");
  }

  const files = groupObject(c, draft, "filesAndTools");
  const rootItem = (path: string) => (entry: unknown, index: number) => {
    if (!isConfinedPath(entry, true)) {
      c.add(`${path}[${String(index)}]`, "invalid", "racine relative confinée attendue");
      return undefined;
    }
    return entry;
  };
  const readRoots = listField(
    c,
    files,
    "filesAndTools",
    "readRoots",
    SAFE_DEFAULTS.readRoots,
    rootItem("filesAndTools.readRoots"),
  );
  const writeRoots = listField(
    c,
    files,
    "filesAndTools",
    "writeRoots",
    SAFE_DEFAULTS.writeRoots,
    rootItem("filesAndTools.writeRoots"),
  );
  const executables = listField(
    c,
    files,
    "filesAndTools",
    "allowedExecutables",
    SAFE_DEFAULTS.allowedExecutables,
    (entry, index) => {
      if (!isText(entry, 260) || /[*?]/.test(entry)) {
        c.add(`filesAndTools.allowedExecutables[${String(index)}]`, "invalid", "nom exact attendu");
        return undefined;
      }
      return entry;
    },
  );
  uniqueStrings(c, "filesAndTools.readRoots", readRoots);
  uniqueStrings(c, "filesAndTools.writeRoots", writeRoots);
  uniqueStrings(c, "filesAndTools.allowedExecutables", executables);
  const maxProcesses = intField(c, files, "filesAndTools", "maxProcesses", 1);
  const maxStorage = intField(c, files, "filesAndTools", "maxStorageBytes", 1);

  const network = groupObject(c, draft, "network");
  const exploration = listField(
    c,
    network,
    "network",
    "explorationDestinations",
    [],
    destinationItem(c, "network.explorationDestinations"),
  );
  const transport = listField(
    c,
    network,
    "network",
    "providerTransportDestinations",
    [],
    destinationItem(c, "network.providerTransportDestinations"),
  );

  const data = groupObject(c, draft, "data");
  const retention = intField(c, data, "data", "eventRetentionDays", 1);
  const storageCap = intField(c, data, "data", "localStorageCapBytes", 1);
  const purgeValue = field(c, data, "data", "purge") ?? SAFE_DEFAULTS.purge;
  if (purgeValue !== "manual" && purgeValue !== "retention_only") {
    c.add("data.purge", "invalid", "manual ou retention_only attendu");
  }
  const exportPaths = listField(
    c,
    data,
    "data",
    "exportPaths",
    SAFE_DEFAULTS.exportPaths,
    (entry, index) => {
      if (!isText(entry, 1024)) {
        c.add(`data.exportPaths[${String(index)}]`, "invalid", "chemin non vide attendu");
        return undefined;
      }
      return entry;
    },
  );

  if (c.issues.length > 0) return { ok: false, issues: c.issues };

  // Toutes les valeurs ont été vérifiées ci-dessus ; une absence aurait produit un motif.
  const groups: PolicyGroups = {
    identity: { profileId, agentId } as PolicyGroups["identity"],
    runtime: { adapterId, provider, model, authMode } as PolicyGroups["runtime"],
    schedule: {
      timeZone: scheduleTz,
      weeklyWindows,
      minIntervalBetweenSessionsMs: minInterval,
      maxSessionDurationMs: maxSession,
    } as PolicyGroups["schedule"],
    humanPriority: {
      activitySignal,
      idleThresholdMs: idleThreshold,
      maxSignalAgeMs: maxSignalAge,
      maxInterruptLatencyMs: interruptLatency,
      maxTerminationLatencyMs: terminationLatency,
    } as PolicyGroups["humanPriority"],
    budget: {
      period,
      tokensPerSession,
      tokensPerPeriod,
      sessionsPerPeriod,
      userReserveTokens: userReserve,
      checkpointTokens,
      paidApi,
    } as PolicyGroups["budget"],
    filesAndTools: {
      readRoots,
      writeRoots,
      allowedExecutables: executables,
      maxProcesses,
      maxStorageBytes: maxStorage,
    } as PolicyGroups["filesAndTools"],
    network: {
      explorationDestinations: exploration,
      providerTransportDestinations: transport,
    } as PolicyGroups["network"],
    data: {
      eventRetentionDays: retention,
      localStorageCapBytes: storageCap,
      purge: purgeValue,
      exportPaths,
    } as PolicyGroups["data"],
  };
  return { ok: true, groups: deepFreeze(structuredClone(groups)) };
}

function destinationItem(c: Collector, path: string) {
  return (entry: unknown, index: number) => {
    const at = `${path}[${String(index)}]`;
    if (
      !isPlainObject(entry) ||
      Object.keys(entry).some((k) => !["host", "ports", "purpose"].includes(k))
    ) {
      c.add(at, "invalid", "destination { host, ports, purpose } attendue");
      return undefined;
    }
    const host = own(entry, "host");
    const ports = own(entry, "ports");
    const purpose = own(entry, "purpose");
    if (!isValidHost(host)) {
      c.add(at, "invalid", "hôte exact en minuscules attendu, sans joker");
      return undefined;
    }
    if (
      !Array.isArray(ports) ||
      ports.length === 0 ||
      !(ports as readonly unknown[]).every((p) => isInt(p, 1) && p <= 65535)
    ) {
      c.add(at, "invalid", "ports explicites 1..65535 attendus");
      return undefined;
    }
    if (!isText(purpose, 500)) {
      c.add(at, "invalid", "usage déclaré attendu");
      return undefined;
    }
    return { host, ports: [...(ports as readonly number[])], purpose };
  };
}

function validatePeriod(c: Collector, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.add("budget.period", "invalid", "définition de période attendue");
    return undefined;
  }
  const kind = own(value, "kind");
  const tz = own(value, "timeZone");
  const weekStartsOn = own(value, "weekStartsOn");
  if (Object.keys(value).some((k) => !["kind", "timeZone", "weekStartsOn"].includes(k))) {
    c.add("budget.period", "unknown_field", "champ inconnu dans la période");
    return undefined;
  }
  if (kind !== "day" && kind !== "week" && kind !== "month") {
    c.add("budget.period", "invalid", "kind day, week ou month attendu");
    return undefined;
  }
  if (!isValidTimeZone(tz)) {
    c.add("budget.period", "invalid", "fuseau IANA inconnu");
    return undefined;
  }
  if (kind === "week") {
    if (!isInt(weekStartsOn, 0) || weekStartsOn > 6) {
      c.add("budget.period", "invalid", "weekStartsOn 0..6 requis pour une période week");
      return undefined;
    }
    return { kind, timeZone: tz, weekStartsOn };
  }
  if (weekStartsOn !== undefined) {
    c.add("budget.period", "invalid", "weekStartsOn réservé aux périodes week");
    return undefined;
  }
  return { kind, timeZone: tz };
}

function validatePaidApi(c: Collector, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.add("budget.paidApi", "invalid", "autorisation explicite attendue");
    return undefined;
  }
  const authorized = own(value, "authorized");
  if (authorized === false) {
    if (Object.keys(value).length !== 1) {
      c.add("budget.paidApi", "invalid", "aucun plafond attendu sans autorisation");
      return undefined;
    }
    return { authorized: false };
  }
  if (authorized !== true) {
    c.add("budget.paidApi", "invalid", "authorized doit être true ou false");
    return undefined;
  }
  const keys = ["authorized", "provider", "currency", "perSessionCapMinor", "perPeriodCapMinor"];
  if (Object.keys(value).some((k) => !keys.includes(k))) {
    c.add("budget.paidApi", "unknown_field", "champ inconnu dans paidApi");
    return undefined;
  }
  const provider = own(value, "provider");
  const currency = own(value, "currency");
  const perSession = own(value, "perSessionCapMinor");
  const perPeriod = own(value, "perPeriodCapMinor");
  if (!isText(provider)) {
    c.add("budget.paidApi", "invalid", "fournisseur explicite requis");
    return undefined;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    c.add("budget.paidApi", "invalid", "devise ISO 4217 requise");
    return undefined;
  }
  if (!isInt(perSession, 1) || !isInt(perPeriod, 1) || perSession > perPeriod) {
    c.add("budget.paidApi", "invalid", "plafonds entiers > 0 avec session ≤ période requis");
    return undefined;
  }
  return {
    authorized: true,
    provider,
    currency,
    perSessionCapMinor: perSession,
    perPeriodCapMinor: perPeriod,
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
