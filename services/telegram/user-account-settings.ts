/**
 * Réglages desktop « Telegram — mon compte » (NLR, 16 nov. 2026 : « mets le connecter dans settings »).
 * Pont entre le panneau et le sidecar Telethon `user_account.py` : état, connexion non interactive
 * (téléphone, code, mot de passe 2FA), déconnexion (suppression de la session locale) et première
 * saisie de `api_id` / `api_hash`.
 *
 * Secrets : `telegram-user.json` n'est jamais lu ici ; seule son existence est testée. Il est écrit
 * une seule fois (création exclusive) et son contenu n'est jamais renvoyé. Code, mot de passe et
 * téléphone passent au sidecar par stdin, pas en argument de ligne de commande.
 */
import fs from "node:fs";
import path from "node:path";
import * as z from "zod";
import type { UserSidecar, UserSidecarResult } from "../mcp/telegram-user-tools.js";

export const TELEGRAM_USER_ACTIONS = ["status", "configure", "login_phone", "login_code", "login_password", "logout"] as const;
export type TelegramUserAction = (typeof TELEGRAM_USER_ACTIONS)[number];

export interface TelegramUserAccountView {
  /** `telegram-user.json` existe (api_id et api_hash déjà saisis). */
  configured: boolean;
  loggedIn: boolean;
  /** Nom affichable du compte et @username, rien d'autre. */
  account: { name: string; username: string | null } | null;
  /** Étape de connexion attendue par le sidecar : code ou mot de passe 2FA. */
  step: "phone" | "code" | "password" | null;
}

export class TelegramUserSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_FILES = ["telegram-user.session", "telegram-user.session-journal", "telegram-user.login.json"];

const configureSchema = z.object({
  apiId: z.string().trim().regex(/^\d{3,12}$/, "api_id : un nombre (my.telegram.org)."),
  apiHash: z.string().trim().regex(/^[0-9a-fA-F]{32}$/, "api_hash : 32 caractères hexadécimaux (my.telegram.org)."),
});
const phoneSchema = z.object({
  phone: z
    .string()
    .transform((value) => value.replace(/[\s.-]/g, ""))
    .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "Numéro au format international, par exemple +33612345678.")),
});
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{4,8}$/, "Code : les chiffres reçus dans Telegram.") });
const passwordSchema = z.object({ password: z.string().min(1, "Mot de passe vide.").max(256) });

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload ?? {});
  if (!result.success) throw new TelegramUserSettingsError("invalid_input", result.error.issues[0]?.message ?? "Saisie invalide.");
  return result.data;
}

function accountOf(result: UserSidecarResult): TelegramUserAccountView["account"] {
  if (!result.ok) return null;
  const account = result["account"] as { name?: unknown; username?: unknown } | null | undefined;
  if (!account) return null;
  return {
    name: typeof account.name === "string" ? account.name : "",
    username: typeof account.username === "string" ? account.username : null,
  };
}

export class TelegramUserSettings {
  constructor(
    private readonly dataDir: string,
    private readonly sidecar: UserSidecar,
  ) {}

  private file(name: string): string {
    return path.join(this.dataDir, name);
  }

  private configured(): boolean {
    return fs.existsSync(this.file("telegram-user.json"));
  }

  private pending(): boolean {
    return fs.existsSync(this.file("telegram-user.login.json"));
  }

  private async run(args: string[], stdin?: string): Promise<UserSidecarResult & { ok: true }> {
    const result = await this.sidecar(args, stdin);
    if (!result.ok) throw new TelegramUserSettingsError(result.error, result.message);
    return result;
  }

  private loginView(result: UserSidecarResult & { ok: true }): TelegramUserAccountView {
    const loggedIn = result["logged_in"] === true;
    const step = result["step"];
    return {
      configured: true,
      loggedIn,
      account: loggedIn ? accountOf(result) : null,
      step: loggedIn ? null : step === "password" ? "password" : "code",
    };
  }

  async handle(action: TelegramUserAction, payload: unknown): Promise<TelegramUserAccountView> {
    switch (action) {
      case "status":
        return this.status();
      case "configure":
        return this.configure(payload);
      case "login_phone": {
        const { phone } = parse(phoneSchema, payload);
        this.requireConfigured();
        return this.loginView(await this.run(["login", "--phone", "-"], phone));
      }
      case "login_code": {
        const { code } = parse(codeSchema, payload);
        this.requireConfigured();
        return this.loginView(await this.run(["login", "--code", "-"], code));
      }
      case "login_password": {
        const { password } = parse(passwordSchema, payload);
        this.requireConfigured();
        return this.loginView(await this.run(["login", "--password", "-"], password));
      }
      case "logout":
        return this.logout();
    }
  }

  private requireConfigured(): void {
    if (!this.configured())
      throw new TelegramUserSettingsError("not_configured", "Saisir d'abord api_id et api_hash (my.telegram.org).");
  }

  async status(): Promise<TelegramUserAccountView> {
    if (!this.configured()) return { configured: false, loggedIn: false, account: null, step: null };
    // Sans session, inutile de lancer Telethon : le compte n'est pas connecté.
    if (!fs.existsSync(this.file("telegram-user.session")))
      return { configured: true, loggedIn: false, account: null, step: this.pending() ? "code" : "phone" };
    const result = await this.run(["status"]);
    const loggedIn = result["logged_in"] === true;
    return {
      configured: true,
      loggedIn,
      account: loggedIn ? accountOf(result) : null,
      step: loggedIn ? null : this.pending() ? "code" : "phone",
    };
  }

  /** Première saisie seulement : un fichier existant n'est ni relu ni remplacé. */
  configure(payload: unknown): TelegramUserAccountView {
    const { apiId, apiHash } = parse(configureSchema, payload);
    if (this.configured())
      throw new TelegramUserSettingsError("already_configured", "api_id et api_hash sont déjà enregistrés.");
    const content = JSON.stringify({ api_id: Number(apiId), api_hash: apiHash.toLowerCase() }, null, 2) + "\n";
    try {
      fs.writeFileSync(this.file("telegram-user.json"), content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new TelegramUserSettingsError("already_configured", "api_id et api_hash sont déjà enregistrés.");
      throw new TelegramUserSettingsError("write_failed", "Impossible d'écrire telegram-user.json dans le dossier de données.");
    }
    return { configured: true, loggedIn: false, account: null, step: "phone" };
  }

  /** Supprime la session locale (et une connexion en cours). `telegram-user.json` reste. */
  logout(): TelegramUserAccountView {
    for (const name of SESSION_FILES) fs.rmSync(this.file(name), { force: true });
    return { configured: this.configured(), loggedIn: false, account: null, step: this.configured() ? "phone" : null };
  }
}

/** Entrée JSON du pont desktop : `{action, payload}` ; sortie `{ok, data}` ou `{ok: false, error}`. */
export async function runTelegramUserSettings(
  input: string,
  settings: TelegramUserSettings,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const request = z
      .object({ action: z.enum(TELEGRAM_USER_ACTIONS), payload: z.unknown().optional() })
      .parse(JSON.parse(input));
    const data = await settings.handle(request.action, request.payload);
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }) };
  } catch (error) {
    const known = error instanceof TelegramUserSettingsError;
    const message = known ? error.message : "Requête Telegram invalide.";
    return {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: { code: known ? error.code : "invalid_request", message } }),
    };
  }
}
