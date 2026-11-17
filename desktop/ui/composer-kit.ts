/**
 * Saisie réactive (NLR, 15 nov. 2026 : « rendre l'input et send + réactif » ; un message
 * était resté bloqué sans signe puis avait disparu au rechargement).
 * - Entrée envoie, Maj+Entrée va à la ligne.
 * - Brouillons et envois en vol gardés localement, par conversation, pour survivre au rechargement.
 * - Les lectures lourdes (fil principal ≈ 6 Mo de JSON) attendent une pause de frappe.
 */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserStorage(): Store | undefined {
  try { return localStorage; } catch { return undefined; }
}

interface EnterEvent {
  key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  isComposing?: boolean; keyCode?: number; preventDefault(): void;
}

/** Vrai quand la touche doit envoyer (et non insérer un retour à la ligne). */
export function enterSends(event: EnterEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
    event.isComposing !== true && event.keyCode !== 229;
}

export function sendOnEnter(field: { addEventListener(name: "keydown", handler: (event: KeyboardEvent) => void): void }, submit: () => void): void {
  field.addEventListener("keydown", (event) => {
    if (!enterSends(event)) return;
    event.preventDefault();
    submit();
  });
}

/** Brouillon par conversation ; le stockage est facultatif et ne bloque jamais la saisie. */
export class DraftStore {
  constructor(private readonly storage: Store | undefined, private readonly prefix: string) {}
  get(id: string | number): string {
    try {
      const value = this.storage?.getItem(this.prefix + String(id));
      return typeof value === "string" && value.length <= 8000 ? value : "";
    } catch { return ""; }
  }
  set(id: string | number, text: string): void {
    try {
      if (text === "") this.storage?.removeItem(this.prefix + String(id));
      else this.storage?.setItem(this.prefix + String(id), text);
    } catch { /* Affichage local seulement. */ }
  }
}

export interface Outgoing { readonly key: string; readonly text: string; readonly at: string; readonly target?: string | number }

/** Envois partis mais pas encore confirmés : un rechargement les retrouve au lieu de les perdre. */
export class Outbox {
  constructor(private readonly storage: Store | undefined, private readonly storageKey: string) {}
  list(): Outgoing[] {
    try {
      const raw: unknown = JSON.parse(this.storage?.getItem(this.storageKey) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((item): item is Outgoing => {
        const o = item as Record<string, unknown> | null;
        return o !== null && typeof o === "object" && typeof o["key"] === "string" &&
          typeof o["text"] === "string" && typeof o["at"] === "string" && o["text"].length <= 8000;
      });
    } catch { return []; }
  }
  add(item: Outgoing): void { this.write([...this.list().filter((o) => o.key !== item.key), item].slice(-20)); }
  remove(key: string): void {
    const items = this.list();
    if (items.some((o) => o.key === key)) this.write(items.filter((o) => o.key !== key));
  }
  private write(items: Outgoing[]): void {
    try {
      if (items.length === 0) this.storage?.removeItem(this.storageKey);
      else this.storage?.setItem(this.storageKey, JSON.stringify(items));
    } catch { /* Le message reste visible dans le fil de cette page. */ }
  }
}

let lastTypingAt = 0;
export function noteTyping(at = Date.now()): void { lastTypingAt = at; }

/** Toute frappe dans une zone de saisie retarde les lectures lourdes. */
export function trackTyping(target: { addEventListener(name: string, handler: (event: Event) => void, capture?: boolean): void }): void {
  const note = (event: Event) => {
    const node = event.target as { tagName?: string } | null;
    if (node?.tagName === "TEXTAREA" || node?.tagName === "INPUT") noteTyping();
  };
  target.addEventListener("input", note, true);
  target.addEventListener("keydown", note, true);
}

/**
 * Attend une pause de frappe (`quietMs`) avant une lecture qui gèle le fil d'interface,
 * sans jamais retarder plus de `maxWaitMs` : un fil qui tape sans arrêt reste à jour.
 */
export function typingIdle(quietMs = 1000, maxWaitMs = 5000, now = Date.now): Promise<void> {
  const start = now();
  if (start - lastTypingAt >= quietMs) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      const t = now(), quietFor = t - lastTypingAt, waited = t - start;
      if (quietFor >= quietMs || waited >= maxWaitMs) resolve();
      else setTimeout(check, Math.min(quietMs - quietFor, maxWaitMs - waited) + 10);
    };
    check();
  });
}
