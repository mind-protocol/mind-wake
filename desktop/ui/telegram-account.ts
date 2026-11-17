type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type CliRun = { stdout: string; exitCode: number };
type Step = "phone" | "code" | "password";
export interface TelegramAccountView {
  configured: boolean;
  loggedIn: boolean;
  account: { name: string; username: string | null } | null;
  step: Step | null;
}
type Envelope = { ok: boolean; data: TelegramAccountView; error?: { message: string } };

export const TELEGRAM_API_URL = "https://my.telegram.org";
const STEP_LABEL: Record<Step, string> = {
  phone: "Numéro de téléphone du compte",
  code: "Code reçu dans Telegram",
  password: "Mot de passe 2FA Telegram",
};
const STEP_PLACEHOLDER: Record<Step, string> = { phone: "+33612345678", code: "12345", password: "" };
const STEP_TYPE: Record<Step, string> = { phone: "tel", code: "text", password: "password" };
const STEP_ACTION: Record<Step, string> = { phone: "login_phone", code: "login_code", password: "login_password" };
const STEP_FIELD: Record<Step, string> = { phone: "phone", code: "code", password: "password" };

/** Libellé d'état lu par `status` : nom du compte seulement, aucun secret. */
export function telegramAccountLabel(view: TelegramAccountView): string {
  if (!view.configured) return "Non configuré : api_id et api_hash manquants.";
  if (!view.loggedIn) return view.step === "code" || view.step === "password" ? "Connexion en cours." : "Non connecté.";
  const name = view.account?.name.trim() || "compte sans nom";
  return `Connecté : ${name}${view.account?.username ? ` (${view.account.username})` : ""}`;
}

/** Réglages « Telegram — mon compte ». Tout passe par la commande Tauri `telegram_user`. */
export function mountTelegramAccount(invoke: Invoke): { refresh(): Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller selects the concrete DOM element
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(`telegram-user-${id}`) as T;
  const state = get("state"), feedback = get("feedback");
  const configForm = get<HTMLFormElement>("config"), apiId = get<HTMLInputElement>("api-id"), apiHash = get<HTMLInputElement>("api-hash");
  const apiLink = get<HTMLAnchorElement>("api-link");
  const connect = get<HTMLButtonElement>("connect"), logout = get<HTMLButtonElement>("logout");
  const loginForm = get<HTMLFormElement>("login"), label = get("input-label"), input = get<HTMLInputElement>("input");
  const submit = get<HTMLButtonElement>("submit");
  let view: TelegramAccountView | null = null;
  let loginOpen = false;
  let busy = false;

  const call = async (action: string, payload?: Record<string, string>): Promise<TelegramAccountView> => {
    const result = (await invoke("telegram_user", { action, ...(payload === undefined ? {} : { payload }) })) as CliRun;
    let envelope: Envelope;
    try { envelope = JSON.parse(result.stdout) as Envelope; }
    catch { throw Error("Telegram : réponse illisible du pont local."); }
    if (result.exitCode !== 0 || !envelope.ok) throw Error(envelope.error?.message ?? "Telegram indisponible.");
    return envelope.data;
  };

  const render = (next: TelegramAccountView) => {
    view = next;
    state.textContent = telegramAccountLabel(next);
    configForm.hidden = next.configured;
    const pending = next.step === "code" || next.step === "password";
    if (next.loggedIn || !next.configured) loginOpen = false;
    if (pending) loginOpen = true;
    const step: Step = next.step ?? "phone";
    connect.hidden = !next.configured || next.loggedIn || loginOpen;
    loginForm.hidden = !next.configured || next.loggedIn || !loginOpen;
    logout.hidden = !next.loggedIn && !pending;
    logout.textContent = next.loggedIn ? "Déconnecter" : "Annuler la connexion";
    label.textContent = STEP_LABEL[step];
    input.type = STEP_TYPE[step];
    input.placeholder = STEP_PLACEHOLDER[step];
    input.autocomplete = step === "password" ? "current-password" : step === "code" ? "one-time-code" : "tel";
    input.value = "";
  };

  const action = async (work: () => Promise<TelegramAccountView>, done?: (next: TelegramAccountView) => string) => {
    if (busy) return;
    busy = true;
    for (const button of [connect, logout, submit]) button.disabled = true;
    feedback.textContent = "En cours…";
    try {
      const next = await work();
      render(next);
      feedback.textContent = done?.(next) ?? "";
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      for (const button of [connect, logout, submit]) button.disabled = false;
    }
  };

  configForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = { apiId: apiId.value.trim(), apiHash: apiHash.value.trim() };
    void action(async () => {
      try { return await call("configure", payload); }
      finally { apiId.value = ""; apiHash.value = ""; }
    }, () => "api_id et api_hash enregistrés. Ils ne seront plus affichés.");
  });
  apiLink.addEventListener("click", (event) => {
    event.preventDefault();
    void invoke("open_external_url", { url: TELEGRAM_API_URL }).catch(() => { feedback.textContent = `Ouvrir ${TELEGRAM_API_URL} dans le navigateur.`; });
  });
  connect.addEventListener("click", () => {
    if (!view) return;
    loginOpen = true;
    render({ ...view, step: "phone" });
    feedback.textContent = "";
  });
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const step: Step = view?.step ?? "phone";
    const value = input.value;
    input.value = "";
    void action(() => call(STEP_ACTION[step], { [STEP_FIELD[step]]: value }), (next) =>
      next.loggedIn ? "Compte connecté." : next.step === "password" ? "Telegram demande le mot de passe 2FA." : next.step === "code" ? "Code envoyé dans Telegram." : "");
  });
  logout.addEventListener("click", () => {
    void action(async () => {
      const next = await call("logout");
      loginOpen = false;
      return next;
    }, () => "Session locale supprimée.");
  });

  const refresh = () => action(() => call("status"));
  void refresh();
  return { refresh };
}
