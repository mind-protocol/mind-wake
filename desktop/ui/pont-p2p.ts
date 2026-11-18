// Réglages « Pont pair-à-pair entre colonies ⬡ » : interrupteur, nom, empreinte, carnet d'adresses,
// conflits de nom et statut des messages envoyés. Tout passe par la commande Tauri `pont_p2p`
// (services/pont-p2p/desktop-main.ts) ; la clé privée ne sort jamais du profil.
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type CliRun = { stdout: string; exitCode: number };

export interface PontContact {
  name: string; fingerprint: string | null; publicKey: string; source: string; online: boolean;
  refreshed: string | null; lastSeen: string | null; firstSeen: string | null; agents: string[];
}
export interface PontConflict { name: string; pinnedFingerprint: string | null; claimedFingerprint: string | null; claimed: string; source: string; at: string }
export interface PontMessage { id: string; to: string; status: string; label: string; createdAt: string | null }
export interface PontView {
  enabled: boolean; name: string | null; annuaire: boolean; publicKey: string | null; fingerprint: string | null;
  card: string | null; service: string; dht: string | null;
  carnet: PontContact[]; conflicts: PontConflict[]; messages: PontMessage[];
}
type Envelope = { ok: boolean; data?: PontView; error?: { message: string } };

const SOURCE_LABEL: Record<string, string> = { manuel: "ajout manuel", pair: "fiche reçue du pair", "relayé": "fiche relayée par un tiers" };

/** Date courte locale, ou tiret. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Libellé d'une entrée du carnet pour la colonne « en ligne ». */
export function onlineLabel(c: Pick<PontContact, "online" | "lastSeen">): string {
  return c.online ? "en ligne" : c.lastSeen ? `vu ${shortDate(c.lastSeen)}` : "jamais vu";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) {
    if (k === "text") node.textContent = v; else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function mountPontP2P(invoke: Invoke): { refresh(): Promise<void> } | null {
  const root = document.getElementById("pont-p2p");
  if (!root) return null;
  const state = el("p", { role: "status", text: "Chargement…" });
  const feedback = el("p", { role: "status", class: "hint" });
  const body = el("div");
  root.querySelector("#pont-p2p-state")?.remove();
  root.append(state, body, feedback);
  let view: PontView | null = null;
  let busy = false;

  const call = async (action: string, payload?: Record<string, unknown>): Promise<PontView> => {
    const run = (await invoke("pont_p2p", { action, ...(payload === undefined ? {} : { payload }) })) as CliRun;
    let env: Envelope;
    try { env = JSON.parse(run.stdout) as Envelope; } catch { throw new Error("Réponse illisible du pont pair-à-pair"); }
    if (!env.ok || !env.data) throw new Error(env.error?.message ?? "Action impossible");
    return env.data;
  };

  const act = async (action: string, payload?: Record<string, unknown>, done?: string) => {
    if (busy) return;
    busy = true;
    feedback.textContent = "…";
    try { view = await call(action, payload); feedback.textContent = done ?? ""; render(); }
    catch (e) { feedback.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  };

  function render() {
    const v = view;
    if (!v) return;
    body.replaceChildren();
    state.textContent = v.enabled
      ? `Activé : ${v.name ?? "?"} — service ${v.service}${v.dht ? `, DHT ${v.dht}` : ""}.`
      : "Désactivé : aucune connexion réseau du pont.";

    // Interrupteur + nom.
    const toggle = el("input", { type: "checkbox", id: "pont-p2p-enabled" });
    toggle.checked = v.enabled;
    const nameInput = el("input", { type: "text", id: "pont-p2p-name", spellcheck: "false", autocomplete: "off", placeholder: "⬡nlr-bureau" });
    nameInput.value = v.name ?? "";
    const nameRow = el("div", {}, el("label", { for: "pont-p2p-name", text: "Nom de cette colonie (choisi à l'activation)" }), nameInput);
    nameRow.hidden = v.enabled;
    toggle.addEventListener("change", () => {
      if (toggle.checked) {
        const name = nameInput.value.trim();
        if (!name && !v.name) { toggle.checked = false; feedback.textContent = "Choisir d'abord un nom ⬡…"; nameRow.hidden = false; nameInput.focus(); return; }
        void act("enable", name ? { name } : {}, "Pont activé. Le moteur le démarre sous 10 s.");
      } else void act("disable", {}, "Pont désactivé : connexions fermées, file conservée.");
    });
    body.append(
      el("label", { class: "workspace-sync-toggle" }, toggle, " Pont pair-à-pair entre colonies"),
      el("p", { class: "hint", text: "Relie directement cette app à d'autres apps MIND Wake (Hyperswarm, chiffré, sans serveur relais). Désactivé par défaut. Un message reçu devient un réveil : pause, Force-off et quota restent décidés par le moteur." }),
      nameRow,
    );
    if (!v.enabled && !v.publicKey) return;

    // Identité à communiquer.
    if (v.publicKey) {
      const card = el("input", { type: "text", readonly: "", id: "pont-p2p-card", spellcheck: "false" });
      card.value = v.card ?? v.publicKey;
      const copy = el("button", { type: "button", text: "Copier" });
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(card.value).then(() => { feedback.textContent = "Carte copiée : l'envoyer à l'autre colonie."; }, () => { card.select(); feedback.textContent = "Sélectionnée : Ctrl+C pour copier."; });
      });
      body.append(
        el("p", {}, "Empreinte de cette colonie : ", el("strong", { text: v.fingerprint ?? "?" })),
        el("label", { for: "pont-p2p-card", text: "Carte à envoyer à l'autre colonie (nom et clé publique, rien de secret)" }),
        el("div", { class: "workspace-sync-actions" }, card, copy),
      );
      const annuaire = el("input", { type: "checkbox" });
      annuaire.checked = v.annuaire;
      annuaire.addEventListener("change", () => void act("set_annuaire", { annuaire: annuaire.checked }, annuaire.checked ? "Annuaire commun : participation activée." : "Annuaire commun : carnet manuel et pairs connus seulement."));
      body.append(el("label", { class: "workspace-sync-toggle" }, annuaire, " Participer à l'annuaire commun (les colonies connectées échangent leurs fiches)"));
    }

    // Conflits de nom : alerte à trancher par l'humain.
    for (const c of v.conflicts) {
      const keep = el("button", { type: "button", text: "Garder la clé actuelle" });
      const replace = el("button", { type: "button", text: "Adopter la nouvelle clé" });
      keep.addEventListener("click", () => void act("resolve_conflict", { name: c.name, claimed: c.claimed, choice: "keep" }, `${c.name} : clé actuelle conservée.`));
      replace.addEventListener("click", () => {
        if (!confirm(`Remplacer la clé de ${c.name} ?\nActuelle : ${c.pinnedFingerprint ?? "?"}\nNouvelle : ${c.claimedFingerprint ?? "?"}\nVérifier d'abord l'empreinte avec la personne, par un autre canal.`)) return;
        void act("resolve_conflict", { name: c.name, claimed: c.claimed, choice: "replace" }, `${c.name} : nouvelle clé adoptée.`);
      });
      body.append(el("div", { role: "alert", class: "pont-p2p-conflict" },
        el("strong", { text: `⚠ Conflit de nom : ${c.name}` }),
        ` — épinglé à ${c.pinnedFingerprint ?? "?"}, réclamé par ${c.claimedFingerprint ?? "?"} (${SOURCE_LABEL[c.source] ?? c.source}, ${shortDate(c.at)}). `,
        keep, " ", replace));
    }

    // Carnet d'adresses.
    body.append(el("h3", { text: "Carnet d'adresses" }));
    if (v.carnet.length === 0) body.append(el("p", { class: "hint", text: "Vide. Ajouter une colonie avec la carte qu'elle vous a envoyée." }));
    else {
      const head = el("tr", {}, ...["Nom", "Empreinte", "Source", "En ligne", "Rafraîchi", ""].map((h) => el("th", { text: h })));
      const rows = v.carnet.map((c) => {
        const forget = el("button", { type: "button", text: "Retirer" });
        forget.addEventListener("click", () => { if (confirm(`Retirer ${c.name} du carnet ?`)) void act("forget", { name: c.name }, `${c.name} retiré.`); });
        return el("tr", {}, el("td", { text: c.name }), el("td", { text: c.fingerprint ?? "?" }), el("td", { text: SOURCE_LABEL[c.source] ?? c.source }),
          el("td", { text: onlineLabel(c) }), el("td", { text: shortDate(c.refreshed ?? c.firstSeen) }), el("td", {}, forget));
      });
      body.append(el("table", { class: "pont-p2p-carnet" }, el("thead", {}, head), el("tbody", {}, ...rows)));
    }
    const addName = el("input", { type: "text", id: "pont-p2p-add-name", placeholder: "⬡aurore (facultatif si la carte contient le nom)", spellcheck: "false", autocomplete: "off" });
    const addKey = el("input", { type: "text", id: "pont-p2p-add-key", placeholder: "⬡aurore ed25519:…", spellcheck: "false", autocomplete: "off", required: "" });
    const addForm = el("form", { class: "workspace-sync-form" },
      el("label", { for: "pont-p2p-add-key", text: "Carte ou clé reçue" }), addKey,
      el("label", { for: "pont-p2p-add-name", text: "Nom" }), addName,
      el("button", { type: "submit", text: "Ajouter au carnet" }));
    addForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void act("add_contact", { key: addKey.value, ...(addName.value.trim() ? { name: addName.value.trim() } : {}) }, "Ajouté au carnet.");
    });
    body.append(addForm);

    // Messages envoyés et leur statut.
    if (v.messages.length > 0) {
      body.append(el("h3", { text: "Messages envoyés" }));
      body.append(el("ul", { class: "pont-p2p-messages" }, ...v.messages.map((m) =>
        el("li", { title: m.id }, el("strong", { text: m.to }), ` — ${m.label} (${shortDate(m.createdAt)})`))));
    }
  }

  const refresh = async () => {
    if (busy) return;
    try { view = await call("status"); render(); }
    catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      state.textContent = /pont_p2p.*not found|not found.*pont_p2p|allow-pont-p2p/i.test(text)
        ? "Cette version de l'app ne connaît pas encore le pont : installer la mise à jour de l'app (commande pont_p2p absente du binaire)."
        : text;
    }
  };
  void refresh();
  // Rafraîchi toutes les 5 s quand le panneau est visible (statuts, pairs en ligne).
  setInterval(() => { if (root.offsetParent !== null && !document.hidden && !root.contains(document.activeElement)) void refresh(); }, 5000);
  return { refresh };
}
