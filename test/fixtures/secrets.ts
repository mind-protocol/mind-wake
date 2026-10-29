/**
 * Secrets pièges pour les tests. Valeurs factices au format réaliste, construites par
 * concaténation pour ne pas ressembler à des secrets réels dans le dépôt. Chaque entrée
 * donne le texte injecté et le fragment qui ne doit jamais survivre.
 */

const fake = (...parts: string[]): string => parts.join("");

export interface SecretTrap {
  readonly name: string;
  readonly text: string;
  readonly secret: string;
}

const OPENAI = fake("sk-proj-", "Zx9QwErTy7UiOp3AsDfGh", "JkL0");
const ANTHROPIC = fake("sk-ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUv");
const GITHUB = fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const AWS_ID = fake("AKIA", "IOSFODNN7EXAMPLE");
const AWS_SECRET = fake("wJalrXUtnFEMI", "/K7MDENG/bPxRfiCY", "EXAMPLEKEY");
const GOOGLE = fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q");
const SLACK = fake("xoxb-", "123456789012-", "AbCdEfGhIjKl");
const JWT = fake(
  "eyJhbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiJ1c2VyLTEyMyJ9",
  ".",
  "c2lnbmF0dXJlLXRyZXMtc2VjcmV0ZQ",
);
const BEARER = fake("opaque", "BearerValue", "9876543210");
const BASIC = fake("dXNlcjpw", "YXNzd29yZA==");
const DB_PASS = fake("Pg", "Pa55", "-hunter2");
const PLAIN_PASS = fake("correct-", "horse-", "battery");
const PEM_BODY = fake("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7");
const COOKIE_VALUE = fake("sid=", "s%3Acookie", "SecretValue42");
const STRIPE = fake("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc");
const CLI_TOKEN = fake("cli", "TokenValue", "55555");
const ODBC_PWD = fake("Odbc", "Secret", "Pwd!");
const QUERY_TOKEN = fake("qs", "AccessToken", "777");

export const SECRET_TRAPS: readonly SecretTrap[] = [
  {
    name: "clé OpenAI dans un texte",
    text: `réponse du runtime : clé ${OPENAI} refusée`,
    secret: OPENAI,
  },
  { name: "clé Anthropic", text: `utilise ${ANTHROPIC}`, secret: ANTHROPIC },
  { name: "jeton GitHub", text: `git push avec ${GITHUB}`, secret: GITHUB },
  { name: "identifiant AWS", text: `id=${AWS_ID}`, secret: AWS_ID },
  {
    name: "variable d'environnement AWS",
    text: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
    secret: AWS_SECRET,
  },
  { name: "clé Google", text: `key ${GOOGLE}`, secret: GOOGLE },
  { name: "jeton Slack", text: `slack ${SLACK}`, secret: SLACK },
  { name: "JWT", text: `jeton de session ${JWT}`, secret: JWT },
  {
    name: "en-tête Authorization Bearer",
    text: `Authorization: Bearer ${BEARER}`,
    secret: BEARER,
  },
  { name: "en-tête Authorization Basic", text: `authorization=Basic ${BASIC}`, secret: BASIC },
  {
    name: "chaîne de connexion PostgreSQL",
    text: `connexion à postgres://wake:${DB_PASS}@localhost:5432/db échouée`,
    secret: DB_PASS,
  },
  {
    name: "chaîne de connexion ODBC",
    text: `Server=db;User Id=sa;Pwd=${ODBC_PWD};`,
    secret: ODBC_PWD,
  },
  { name: "affectation password JSON", text: `{"password": "${PLAIN_PASS}"}`, secret: PLAIN_PASS },
  {
    name: "variable d'environnement OPENAI_API_KEY",
    text: `OPENAI_API_KEY=${fake("not-sk-", "but-still-secret-", "value")}`,
    secret: fake("not-sk-", "but-still-secret-", "value"),
  },
  {
    name: "clé privée PEM",
    text: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
    secret: PEM_BODY,
  },
  { name: "en-tête Cookie", text: `Cookie: ${COOKIE_VALUE}; other=1`, secret: COOKIE_VALUE },
  { name: "clé Stripe", text: `paiement ${STRIPE}`, secret: STRIPE },
  {
    name: "option de ligne de commande",
    text: `codex --token ${CLI_TOKEN} run`,
    secret: CLI_TOKEN,
  },
  {
    name: "jeton dans une URL",
    text: `GET https://example.test/cb?access_token=${QUERY_TOKEN}&x=1`,
    secret: QUERY_TOKEN,
  },
];

/** Métadonnées où les secrets sont portés par des clés sensibles plutôt que par leur format. */
export const SENSITIVE_KEY_TRAPS = {
  apiKey: fake("plain", "ApiKey", "Value01"),
  env: {
    GITHUB_TOKEN: fake("plain", "GithubToken", "02"),
    DATABASE_PASSWORD: fake("plain", "DbPassword", "03"),
    ANTHROPIC_API_KEY: fake("plain", "AnthropicKey", "04"),
    PATH: "C:\\Windows",
  },
  headers: {
    Authorization: fake("plain", "AuthHeader", "05"),
    "x-api-key": fake("plain", "Xapi", "06"),
  },
  connectionString: fake("Server=x;", "Password=", "plainConn07"),
  nested: [{ client_secret: fake("plain", "ClientSecret", "08") }],
} as const;

export const SENSITIVE_KEY_SECRETS: readonly string[] = [
  SENSITIVE_KEY_TRAPS.apiKey,
  SENSITIVE_KEY_TRAPS.env.GITHUB_TOKEN,
  SENSITIVE_KEY_TRAPS.env.DATABASE_PASSWORD,
  SENSITIVE_KEY_TRAPS.env.ANTHROPIC_API_KEY,
  SENSITIVE_KEY_TRAPS.headers.Authorization,
  SENSITIVE_KEY_TRAPS.headers["x-api-key"],
  "plainConn07",
  SENSITIVE_KEY_TRAPS.nested[0].client_secret,
];

/** Tous les fragments secrets à rechercher dans une sortie. */
export const ALL_SECRETS: readonly string[] = [
  ...SECRET_TRAPS.map((trap) => trap.secret),
  ...SENSITIVE_KEY_SECRETS,
];
