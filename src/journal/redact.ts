/**
 * Expurgation des secrets avant écriture ou affichage (AGENTS §3.10 et §5).
 *
 * Deux mécanismes complémentaires :
 * - par clé : la valeur d'une clé sensible (`apiKey`, `password`, `Authorization`…) est
 *   remplacée entièrement, quel que soit son type ;
 * - par motif : dans toute chaîne, les formats de jetons connus, en-têtes
 *   d'autorisation, identifiants dans une URL et affectations `CLE=valeur` sensibles
 *   sont masqués.
 *
 * Les motifs n'ont pas de quantificateurs imbriqués (pas de retour arrière
 * exponentiel) et une chaîne trop longue est omise entièrement plutôt que coupée, pour
 * ne jamais conserver un fragment de secret à une frontière de découpe.
 */

export const REDACTED = "[EXPURGÉ]";

/** Au-delà de cette longueur, une chaîne est omise sans être analysée. */
export const MAX_SCANNED_STRING_LENGTH = 65_536;

/**
 * Suffixes (clé normalisée : minuscules, sans `_`, `-`, `.`, espace) qui désignent un
 * secret. Un suffixe et non une sous-chaîne : `tokensPerSession` ou `checkpointTokens`
 * restent lisibles, `accessToken` ou `OPENAI_API_KEY` sont masqués.
 */
const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "accountkey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "connectionstring",
  "dsn",
] as const;

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const PAIR_NAME_KEYS = ["name", "key", "header", "field"] as const;
const PAIR_VALUE_KEYS = ["value", "values", "val"] as const;

/**
 * Paires nom/valeur où le nom désigne un secret : `{ name: "Set-Cookie", value }` ou
 * `["Authorization", valeur]`. Renvoie les clés (ou index) dont la valeur est à masquer.
 */
export function sensitivePairSlots(value: object): readonly (string | number)[] {
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return value.length === 2 && typeof first === "string" && isSensitiveKey(first) ? [1] : [];
  }
  const record = value as Record<string, unknown>;
  const named = PAIR_NAME_KEYS.some((k) => {
    const name = record[k];
    return typeof name === "string" && isSensitiveKey(name);
  });
  return named ? PAIR_VALUE_KEYS.filter((k) => k in record) : [];
}

type Replacement = string | ((match: string, ...groups: string[]) => string);

interface Rule {
  readonly pattern: RegExp;
  readonly replace: Replacement;
}

const KV_KEYWORDS =
  "password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|credentials?|connection[_-]?string|dsn|sig|signature";

const RULES: readonly Rule[] = [
  // Blocs PEM de clé privée, y compris tronqués.
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
    replace: REDACTED,
  },
  // En-têtes Cookie / Set-Cookie : toute la ligne.
  {
    pattern: /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi,
    replace: (_m, head = "") => `${head}${REDACTED}`,
  },
  // En-têtes d'autorisation, schéma compris.
  {
    pattern:
      /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|digest|token|negotiate|ntlm|aws4-hmac-sha256)\s+)?[^\s"',;]+/gi,
    replace: (_m, head = "") => `${head}${REDACTED}`,
  },
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme = "") => `${scheme} ${REDACTED}`,
  },
  // Identifiants dans une URL ou une chaîne de connexion : scheme://user:pass@host.
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:@/]{0,256}):([^\s@/]{1,512})@/gi,
    replace: (_m, scheme = "", user = "") => `${scheme}${user}:${REDACTED}@`,
  },
  // Formats de jetons connus.
  { pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, replace: REDACTED },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: REDACTED },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Options de ligne de commande : --password x, --api-key=x.
  {
    pattern: /(--?(?:password|passwd|token|api-key|apikey|secret|client-secret)(?:=|\s+))(\S+)/gi,
    replace: (_m, head = "") => `${head}${REDACTED}`,
  },
  // Affectations sensibles : OPENAI_API_KEY=…, "password": "…", Pwd=…; ?access_token=…
  {
    pattern: new RegExp(
      `\\b([A-Za-z0-9_.-]{0,40}?(?:${KV_KEYWORDS}))\\b(["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s"',;&]+)`,
      "gi",
    ),
    replace: (_m, key = "", sep = "") => `${key}${sep}${REDACTED}`,
  },
];

export const PRIVATE_USER = "[utilisateur]";

const PRIVATE_PATH_RULES: readonly Rule[] = [
  // C:\Users\nom, C:/Users/nom, C:\\Users\\nom (JSON échappé), Documents and Settings.
  {
    pattern:
      /\b([A-Za-z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/))([^\\/\s"':;*?<>|]{1,128})/gi,
    replace: (_m, head = "") => `${head}${PRIVATE_USER}`,
  },
  // /home/nom, /Users/nom
  {
    pattern: /(^|[\s"'=(:])(\/(?:home|Users)\/)([^/\s"':;]{1,128})/g,
    replace: (_m, lead = "", head = "") => `${lead}${head}${PRIVATE_USER}`,
  },
];

function applyRules(input: string, rules: readonly Rule[]): string {
  let output = input;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    output =
      typeof rule.replace === "string"
        ? output.replace(rule.pattern, rule.replace)
        : output.replace(rule.pattern, rule.replace);
  }
  return output;
}

/**
 * Masque le nom d'utilisateur dans les chemins de profil (Windows, Linux, macOS). Pour
 * le journal et les erreurs, susceptibles d'être exportés : un chemin ne doit pas
 * divulguer l'identité locale.
 */
export function redactPrivatePaths(input: string): string {
  if (input.length > MAX_SCANNED_STRING_LENGTH) return redactString(input);
  return applyRules(input, PRIVATE_PATH_RULES);
}

/** Masque les secrets reconnaissables dans une chaîne libre. */
export function redactString(input: string): string {
  if (input.length > MAX_SCANNED_STRING_LENGTH) {
    return `[valeur omise : ${String(input.length)} caractères]`;
  }
  return applyRules(input, RULES);
}

/**
 * Expurge récursivement une valeur quelconque. Les clés sensibles voient leur valeur
 * remplacée ; les chaînes passent par `redactString`. Ne borne pas la taille : voir
 * `sanitizeMetadata`.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[profondeur excessive]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const slots = sensitivePairSlots(value);
    return value.map((item: unknown, i) =>
      slots.includes(i) ? REDACTED : redactValue(item, depth + 1),
    );
  }
  if (value !== null && typeof value === "object") {
    const slots = sensitivePairSlots(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[redactString(key)] =
        isSensitiveKey(key) || slots.includes(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}
