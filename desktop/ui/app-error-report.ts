/**
 * Relais des erreurs du panneau vers l'agent principal (demande NLR, 17 nov 2026).
 *
 * Chargé avant `main.js` (index.html). Capte ce que l'humain voit échouer :
 *  - erreurs JS non rattrapées et promesses rejetées ;
 *  - `console.error` (les actions `.catch(console.error)`) ;
 *  - commandes natives rejetées (`__TAURI__.core.invoke`) — nom de commande seulement, jamais ses arguments ;
 *  - textes d'erreur affichés dans les zones d'état, alertes et bandeaux (`role=status|alert`, `aria-live`, `.error`) ;
 *  - écran de chargement encore affiché après 30 s.
 * Chaque erreur part via `app_error_report` → `mind-wake app-error` → message pair `app-error`.
 * V1 : aucune déduplication temporelle ni limite (décision NLR). Une zone d'état n'est
 * signalée que lorsque son texte d'erreur apparaît ou change, pas à chaque repeinte identique.
 * Les secrets sont masqués côté runtime (src/communication/app-error-relay.ts).
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type AppErrorSend = (screen: string, text: string, at: string) => Promise<unknown>;

const ERROR_WORDS =
  /erreur|error|échec|echec|échoué|impossible|indisponible|introuvable|refusé|invalide|failed|failure|unavailable|exception|timed? ?out|délai dépassé|expirée?|perdue?|non confirmé|non enregistré|hors ligne|injoignable|bloqué|crash/i;
const REPORT_COMMAND = "app_error_report";

/** Le texte affiché ressemble-t-il à une erreur ? (zones d'état mêlant info et erreur) */
export function looksLikeError(text: string): boolean {
  return ERROR_WORDS.test(text);
}

export function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack && !value.stack.startsWith(value.message) ? `${value.message}\n${value.stack}` : (value.stack ?? value.message);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

const RECOVERY_MS = 60_000;
/** Signatures du message pair produit par src/communication/app-error-relay.ts. */
const RELAY_SIGNATURE = /Erreur affichée à NLR|Relais automatique, pas un message humain|Erreur app/;
/** Forme comparée : sans suffixe d'état d'iframe, chiffres (compteurs, heures) neutralisés. */
export function errorShape(text: string): string {
  return text.replace(/\[iframe appel :[^\]]*\]/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

export function createAppErrorReporter(send: AppErrorSend, now: () => number = Date.now) {
  let sending = 0;
  // Par zone : dernière erreur signalée (forme stable) et début de la période sans erreur.
  const shown = new Map<string, { shape: string; okSince?: number | undefined }>();
  function report(screen: string, text: string): void {
    const value = text.trim();
    // Pas de récursion : une erreur du relais lui-même n'est jamais relayée.
    if (!value || sending > 0) return;
    // Garde anti-boucle : un message relayé (affiché dans un fil, quel qu'il soit) n'est jamais re-relayé.
    if (RELAY_SIGNATURE.test(value)) return;
    sending++;
    try {
      void Promise.resolve()
        .then(() => send(screen, value.slice(0, 4000), new Date(now()).toISOString()))
        .catch(() => { /* Relais indisponible : rien d'autre à faire, surtout pas console.error. */ });
    } finally { sending--; }
  }
  return {
    report,
    /**
     * Zone visible : signale une erreur quand elle apparaît ou change. La même erreur n'est
     * renvoyée qu'après RECOVERY_MS sans erreur dans la zone (une relance qui affiche
     * brièvement « Ouverture… » puis la même erreur n'est pas une nouvelle erreur), ou après forget().
     */
    shownText(key: string, screen: string, text: string): void {
      const value = text.replace(/\s+/g, " ").trim();
      const last = shown.get(key);
      if (!value || !looksLikeError(value)) {
        if (last && last.okSince === undefined) last.okSince = now();
        return;
      }
      const shape = errorShape(value);
      if (last && last.shape === shape && (last.okSince === undefined || now() - last.okSince < RECOVERY_MS)) {
        last.okSince = undefined;
        return;
      }
      shown.set(key, { shape });
      report(screen, value);
    },
    /** Succès constaté (ex. mind.call.ready) : la prochaine erreur de cette zone repart. */
    forget(key: string): void { shown.delete(key); },
    consoleError(args: readonly unknown[], screen: string): void {
      report(screen, args.map(describeError).join(" "));
    },
    commandFailed(command: string, error: unknown, screen: string): void {
      if (command !== REPORT_COMMAND) report(screen, `Commande ${command} en échec : ${describeError(error)}`);
    },
  };
}

/**
 * État de l'iframe d'appel (#call-frame, page /desktop-call de la passerelle) joint à chaque
 * erreur liée à l'appel : src courant, événement load reçu, message mind.call.ready reçu.
 */
export function createCallFrameTracker(now: () => number = Date.now) {
  let src = "";
  let since = 0;
  let loaded = false;
  let ready = false;
  return {
    srcChanged(value: string | null): void {
      const next = value ?? "";
      if (next === src) return;
      src = next; since = now(); loaded = false; ready = false;
    },
    loaded(): void { loaded = true; },
    ready(): void { ready = true; },
    describe(): string {
      const age = since ? `, src posé il y a ${String(Math.round((now() - since) / 1000))} s` : "";
      return `[iframe appel : src=${src || "(aucun)"}${age} ; load reçu : ${loaded ? "oui" : "non"} ; mind.call.ready reçu : ${ready ? "oui" : "non"}]`;
    },
  };
}

export const CALL_FRAME_ORIGIN = "http://127.0.0.1:8789";

function activeScreen(): string {
  const tab = document.querySelector('[role="tab"][aria-selected="true"]');
  const label = tab?.textContent?.replace(/\s+/g, " ").trim();
  return label ? `panneau · ${label}` : "panneau";
}

/** Vrais éléments d'erreur : bandeaux/alertes, champs d'état, toasts marqués erreur. Pas les régions aria-live génériques. */
export const WATCHED = '[role="status"],[role="alert"],.error,.is-error,.toast-error,[data-tone="error"],#reason';
/** Transcriptions de conversation : le texte des messages n'est jamais une erreur affichée par l'app. */
export const TRANSCRIPT = '#chat,#second-thread-messages,.messages,[role="log"],[data-message-id]';

/** L'élément peut-il porter une erreur affichée par l'app ? (exclut toute bulle de conversation) */
export function watchableErrorZone(element: { matches(selector: string): boolean; closest(selector: string): unknown }): boolean {
  // Aucune exception : les messages relayés « Erreur app » s'affichent dans #chat (boucle sinon).
  return element.matches(WATCHED) && element.closest(TRANSCRIPT) === null;
}

/** Installe les capteurs du panneau principal. Sans Tauri (tests, navigateur), ne fait rien. */
export function installAppErrorReporter(win: Window = window): void {
  const tauri = (win as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  const core = tauri?.core;
  const original = core?.invoke?.bind(core);
  if (!core || !original) return;
  // Toute erreur vue pendant que l'onglet Appel est ouvert, ou venant de l'iframe d'appel,
  // emporte l'état de l'iframe (premier cas réel : NLR n'arrive pas à ouvrir un appel).
  const frame = createCallFrameTracker();
  const callContext = (screen: string) => /appel|call/i.test(screen);
  const reporter = createAppErrorReporter((screen, text, at) =>
    original(REPORT_COMMAND, { screen, text: callContext(screen) ? `${text}
${frame.describe()}` : text, at }));
  const watchFrame = () => {
    const element = document.getElementById("call-frame") as HTMLIFrameElement | null;
    if (!element) return false;
    frame.srcChanged(element.getAttribute("src"));
    new MutationObserver(() => { frame.srcChanged(element.getAttribute("src")); })
      .observe(element, { attributes: true, attributeFilter: ["src"] });
    element.addEventListener("load", () => { if (element.getAttribute("src")) frame.loaded(); });
    element.addEventListener("error", () => {
      reporter.report("appel · iframe", `Échec de chargement de l'iframe d'appel (${element.getAttribute("src") ?? "sans src"}).`);
    });
    win.addEventListener("message", (event) => {
      if (event.source !== element.contentWindow || event.origin !== CALL_FRAME_ORIGIN) return;
      if (event.data === "mind.call.ready") { frame.ready(); reporter.forget("call-status"); return; }
      // Erreurs de l'iframe (console, JS, écran) relayées par l'app web : texte seulement, champs fixés.
      const data = event.data as { type?: unknown; screen?: unknown; text?: unknown } | null;
      if (data?.type === "mind.app-error" && typeof data.text === "string")
        reporter.report(`appel · iframe · ${typeof data.screen === "string" ? data.screen.slice(0, 80) : "inconnu"}`, data.text);
    });
    return true;
  };

  win.addEventListener("error", (event) => {
    reporter.report(activeScreen(), `Erreur JS : ${event.message}${event.filename ? ` (${event.filename}:${String(event.lineno)})` : ""}`);
  });
  win.addEventListener("unhandledrejection", (event) => {
    reporter.report(activeScreen(), `Promesse rejetée : ${describeError(event.reason)}`);
  });
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleError(...args);
    reporter.consoleError(args, activeScreen());
  };
  try {
    core.invoke = (command: string, args?: Record<string, unknown>) =>
      original(command, args).catch((error: unknown) => {
        reporter.commandFailed(command, error, activeScreen());
        throw error;
      });
  } catch { /* Objet figé : les autres capteurs restent actifs. */ }

  const scan = (root: Element) => {
    const elements = root.matches(WATCHED) ? [root] : [];
    elements.push(...Array.from(root.querySelectorAll(WATCHED)));
    for (const element of elements) {
      // Un conteneur (ex. l'en-tête #state) est lu par ses zones internes, pas en bloc.
      if (element.querySelector(WATCHED) !== null) continue;
      if (!watchableErrorZone(element)) continue;
      const hidden = (element as HTMLElement).hidden || element.closest("[hidden],[aria-hidden='true']") !== null;
      const bubble = (element.closest("[data-message-id]") as HTMLElement | null)?.dataset["messageId"];
      const key = element.id || (bubble ? `envoi:${bubble}` : `${element.tagName}.${element.className}`);
      reporter.shownText(key, `${activeScreen()}${element.id ? ` · #${element.id}` : ""}`, hidden ? "" : element.textContent ?? "");
    }
  };
  const start = () => {
    watchFrame();
    new MutationObserver((records) => {
      const touched = new Set<Element>();
      for (const record of records) {
        const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement;
        const watched = node?.closest(WATCHED);
        if (watched && watchableErrorZone(watched)) touched.add(watched);
        for (const added of Array.from(record.addedNodes))
          if (added.nodeType === Node.ELEMENT_NODE) touched.add(added as Element);
      }
      for (const element of touched) scan(element);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "data-tone", "class"] });
    scan(document.body);
  };
  if (document.body) start(); else win.addEventListener("DOMContentLoaded", start, { once: true });

  // « L'app charge à l'infini » : l'interface n'a pas signalé qu'elle est prête après 30 s.
  let ready = false;
  win.addEventListener("wake-interface-ready", () => { ready = true; }, { once: true });
  win.setTimeout(() => {
    if (!ready && document.getElementById("wake-loading"))
      reporter.report("chargement", `Chargement du panneau bloqué : interface pas prête après 30 s (${document.getElementById("wake-loading-status")?.textContent?.trim() ?? "sans statut"}).`);
  }, 30_000);
}

if (typeof window !== "undefined" && typeof document !== "undefined") installAppErrorReporter(window);
