import { afterEach, expect, it, vi } from "vitest";
import { mountTelegramAccount, telegramAccountLabel, TELEGRAM_API_URL, type TelegramAccountView } from "./telegram-account.js";

afterEach(() => { vi.unstubAllGlobals(); });

type View = TelegramAccountView;
const view = (patch: Partial<View>): View => ({ configured: true, loggedIn: false, account: null, step: "phone", ...patch });

function setup(responses: Record<string, View | Error | ((payload: unknown) => View)>) {
  const elements = new Map<string, any>();
  const get = (id: string) => elements.get(id) ?? elements.set(id, {
    hidden: false, disabled: false, textContent: "", value: "", type: "text", placeholder: "", autocomplete: "",
    handlers: {} as Record<string, (event: { preventDefault(): void }) => void>,
    addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) { this.handlers[name] = handler; },
  }).get(id);
  vi.stubGlobal("document", { getElementById: get });
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "open_external_url") return null;
    const response = responses[String(args?.["action"])];
    const data = typeof response === "function" ? response(args?.["payload"]) : response;
    if (!data || data instanceof Error) return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { message: data?.message ?? "absent" } }) };
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }) };
  });
  const ui = mountTelegramAccount(invoke);
  const el = (id: string) => get(`telegram-user-${id}`);
  const fire = async (id: string, name: string) => {
    const event = { preventDefault: vi.fn() };
    el(id).handlers[name](event);
    await vi.waitFor(() => expect(el("submit").disabled).toBe(false));
    return event;
  };
  return { ui, el, fire, invoke };
}

it("labels the state from status with the account name only", () => {
  expect(telegramAccountLabel(view({ configured: false, step: null }))).toBe("Non configuré : api_id et api_hash manquants.");
  expect(telegramAccountLabel(view({}))).toBe("Non connecté.");
  expect(telegramAccountLabel(view({ step: "code" }))).toBe("Connexion en cours.");
  expect(telegramAccountLabel(view({ loggedIn: true, step: null, account: { name: "NLR", username: "@nlr" } }))).toBe("Connecté : NLR (@nlr)");
});

it("asks for api_id and api_hash when telegram-user.json is missing, then hides and clears them", async () => {
  const t = setup({ status: view({ configured: false, step: null }), configure: view({}) });
  await vi.waitFor(() => expect(t.el("state").textContent).toBe("Non configuré : api_id et api_hash manquants."));
  expect(t.el("config").hidden).toBe(false);
  expect(t.el("connect").hidden).toBe(true);
  t.el("api-id").value = "123456";
  t.el("api-hash").value = "0123456789abcdef0123456789abcdef";
  await t.fire("config", "submit");
  expect(t.invoke).toHaveBeenLastCalledWith("telegram_user", { action: "configure", payload: { apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" } });
  expect(t.el("api-id").value).toBe("");
  expect(t.el("api-hash").value).toBe("");
  expect(t.el("config").hidden).toBe(true);
  expect(t.el("connect").hidden).toBe(false);
  expect(t.el("feedback").textContent).toContain("ne seront plus affichés");
});

it("opens my.telegram.org through the validated external link command", async () => {
  const t = setup({ status: view({ configured: false, step: null }) });
  await vi.waitFor(() => expect(t.el("config").hidden).toBe(false));
  const event = { preventDefault: vi.fn() };
  t.el("api-link").handlers["click"](event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(t.invoke).toHaveBeenCalledWith("open_external_url", { url: TELEGRAM_API_URL });
});

it("connects with phone, then code, then 2FA password, never keeping the typed values", async () => {
  const t = setup({
    status: view({}),
    login_phone: view({ step: "code" }),
    login_code: view({ step: "password" }),
    login_password: view({ loggedIn: true, step: null, account: { name: "NLR", username: null } }),
  });
  await vi.waitFor(() => expect(t.el("state").textContent).toBe("Non connecté."));
  expect(t.el("login").hidden).toBe(true);
  t.el("connect").handlers["click"]({ preventDefault() {} });
  expect(t.el("login").hidden).toBe(false);
  expect(t.el("connect").hidden).toBe(true);
  expect(t.el("input").type).toBe("tel");

  t.el("input").value = "+33612345678";
  await t.fire("login", "submit");
  expect(t.invoke).toHaveBeenLastCalledWith("telegram_user", { action: "login_phone", payload: { phone: "+33612345678" } });
  expect(t.el("input-label").textContent).toBe("Code reçu dans Telegram");
  expect(t.el("input").value).toBe("");

  t.el("input").value = "12345";
  await t.fire("login", "submit");
  expect(t.invoke).toHaveBeenLastCalledWith("telegram_user", { action: "login_code", payload: { code: "12345" } });
  expect(t.el("input").type).toBe("password");
  expect(t.el("feedback").textContent).toBe("Telegram demande le mot de passe 2FA.");

  t.el("input").value = "secret 2fa";
  await t.fire("login", "submit");
  expect(t.invoke).toHaveBeenLastCalledWith("telegram_user", { action: "login_password", payload: { password: "secret 2fa" } });
  expect(t.el("input").value).toBe("");
  expect(t.el("state").textContent).toBe("Connecté : NLR");
  expect(t.el("login").hidden).toBe(true);
  expect(t.el("logout").hidden).toBe(false);
  expect(t.el("logout").textContent).toBe("Déconnecter");
});

it("shows the sidecar error and stays on the same step", async () => {
  const t = setup({ status: view({ step: "code" }), login_code: new Error("Code incorrect.") });
  await vi.waitFor(() => expect(t.el("state").textContent).toBe("Connexion en cours."));
  expect(t.el("login").hidden).toBe(false);
  t.el("input").value = "00000";
  await t.fire("login", "submit");
  expect(t.el("feedback").textContent).toBe("Code incorrect.");
  expect(t.el("input-label").textContent).toBe("Code reçu dans Telegram");
});

it("disconnects by deleting the local session", async () => {
  const t = setup({ status: view({ loggedIn: true, step: null, account: { name: "NLR", username: "@nlr" } }), logout: view({}) });
  await vi.waitFor(() => expect(t.el("state").textContent).toBe("Connecté : NLR (@nlr)"));
  expect(t.el("connect").hidden).toBe(true);
  await t.fire("logout", "click");
  expect(t.invoke).toHaveBeenLastCalledWith("telegram_user", { action: "logout" });
  expect(t.el("state").textContent).toBe("Non connecté.");
  expect(t.el("connect").hidden).toBe(false);
  expect(t.el("login").hidden).toBe(true);
  expect(t.el("logout").hidden).toBe(true);
  expect(t.el("feedback").textContent).toBe("Session locale supprimée.");
});
