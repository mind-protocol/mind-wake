type Decision = "authorized" | "encouraged" | "discouraged" | "forbidden";
interface Entry { id: string; action: string; scope: string; decision: Decision; category: string }
interface Document { version: 1; title: string; context: string; example: string; guidance: string; entries: Entry[] }
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const labels: Record<Decision, string> = { authorized: "✅ Autorisé en autonomie", encouraged: "🌟 Encouragé", discouraged: "⚠️ Découragé", forbidden: "⛔ Interdit" };
const categories = ["prepare", "find_out", "build", "fix", "check", "tend", "connect", "reflect"];

export function parseAuthorizations(text: string): Document {
  const value = JSON.parse(text) as Document;
  if (!value || value.version !== 1 || ![value.title, value.context, value.example, value.guidance].every(s => typeof s === "string") || !Array.isArray(value.entries)) throw Error("Format de document invalide.");
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || ![entry.id, entry.action, entry.scope].every(s => typeof s === "string" && s.trim()) || !Object.hasOwn(labels, entry.decision) || !categories.includes(entry.category) || ids.has(entry.id)) throw Error("Entrée invalide ou identifiant dupliqué.");
    ids.add(entry.id);
  }
  return value;
}

export function mountAuthorizations(invoke: Invoke): { open: () => Promise<void> } {
  const get = (id: string): HTMLElement => document.getElementById(`authorization-${id}`)!;
  const save = get("save") as HTMLButtonElement;
  const search = get("search") as HTMLInputElement;
  const importer = get("import") as HTMLInputElement;
  const reload = get("reload") as HTMLButtonElement;
  let doc: Document | null = null, revision: string | null = null, dirty = false, loaded = false, busy = false;
  const status = (message: string): void => { get("status").textContent = message; };
  const summary = (): void => { get("summary").textContent = doc ? `${doc.entries.length} décisions · ${doc.entries.filter(e => e.decision === "authorized" || e.decision === "encouraged").length} pistes personnelles disponibles` : ""; };
  const changed = (): void => { dirty = true; save.disabled = false; summary(); status("Modifications non enregistrées."); };
  const controls = (disabled: boolean): void => {
    busy = disabled; reload.disabled = disabled; importer.disabled = disabled; save.disabled = disabled || !dirty;
    get("entries").querySelectorAll<HTMLInputElement | HTMLSelectElement>("select,textarea").forEach(e => { e.disabled = disabled; });
  };
  const render = (): void => {
    get("entries").replaceChildren(); summary();
    get("context").textContent = doc ? `${doc.example}\n\n${doc.guidance}` : "";
    for (const entry of doc?.entries ?? []) {
      if (!`${entry.id} ${entry.action} ${entry.scope}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue;
      const card = document.createElement("article"), title = document.createElement("h2"), select = document.createElement("select"), label = document.createElement("label"), scope = document.createElement("textarea");
      card.className = "authorization-card"; card.dataset["id"] = entry.id;
      title.textContent = `${entry.id} · ${entry.action}`;
      select.setAttribute("aria-label", `Décision pour ${entry.action}`);
      for (const [value, text] of Object.entries(labels)) { const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option); }
      select.value = entry.decision; select.onchange = () => { entry.decision = select.value as Decision; changed(); };
      label.textContent = "Périmètre"; scope.value = entry.scope; scope.rows = 3; scope.oninput = () => { entry.scope = scope.value; changed(); }; label.append(scope);
      select.disabled = busy; scope.disabled = busy;
      card.append(title, select, label); get("entries").append(card);
    }
  };
  const load = async (): Promise<void> => {
    if (busy) return;
    controls(true);
    try {
      const result = await invoke("authorizations_read") as { document: unknown; revision: string | null; file: string };
      doc = result.document === null ? null : parseAuthorizations(JSON.stringify(result.document));
      revision = result.revision; loaded = true; dirty = false;
      get("file").textContent = result.file;
      render(); status(doc ? "Choix du profil actif chargés." : "Aucun choix enregistré pour cet agent. Importe ton AUTORISATIONS.json puis enregistre-le.");
    } catch (error) { status(String(error)); }
    finally { controls(false); }
  };
  reload.onclick = () => { if (!dirty || confirm("Abandonner les modifications non enregistrées ?")) void load(); };
  importer.onchange = async () => {
    try {
      const file = importer.files?.[0]; if (!file || busy) return;
      if (!loaded) throw Error("Recharge d’abord les choix du profil actif.");
      if (file.size > 1_000_000) throw Error("Document trop volumineux.");
      doc = parseAuthorizations(await file.text()); render(); changed();
      status("Choix importés. Enregistre pour les appliquer à cet agent.");
    } catch (error) { status(String(error)); }
    finally { importer.value = ""; }
  };
  save.onclick = async () => {
    if (!doc || busy) return;
    controls(true);
    try {
      const document = parseAuthorizations(JSON.stringify(doc));
      const result = await invoke("authorizations_save", { document, revision }) as { revision: string };
      revision = result.revision; dirty = false; status("Enregistré pour cet agent. Pris en compte au prochain appel MCP.");
    } catch (error) { status(String(error)); }
    finally { controls(false); }
  };
  search.oninput = render;
  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  return { open: async () => { if (!dirty) await load(); } };
}
