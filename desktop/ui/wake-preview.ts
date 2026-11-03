import { projectMarker, projectBadge, undefinedObjectiveBadge } from "./project-marker.js";
type WakeType = "prepare" | "work" | "free";
interface Wake {
  number: number; day: number; inBlock: number; projectId: string | null; title: string;
  phase: WakeType; objective: string | null; expected: string | null;
  state: "planned" | "reserved" | "running";
}
export interface WakePreviewModel {
  revision: number | null;
  state: "ready" | "disabled" | "unavailable";
  wakes: Wake[];
  completed: number;
  counts: Record<WakeType, number>;
  defined: number;
  projects: number;
}
const TYPES: readonly WakeType[] = ["prepare", "work", "free"];
const LABELS: Record<WakeType, string> = { prepare: "Préparation", work: "Travail", free: "Exploration libre" };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
export function wakePreviewModel(input: unknown): WakePreviewModel {
  const data = object(input);
  const empty: WakePreviewModel = { revision: typeof data?.["revision"] === "number" && Number.isSafeInteger(data["revision"]) ? data["revision"] : null, state: data?.["state"] === "disabled" ? "disabled" : "unavailable", wakes: [], completed: 0, counts: { prepare: 0, work: 0, free: 0 }, defined: 0, projects: 0 };
  if (data?.["state"] !== "ready" || !Array.isArray(data["wakes"])) return empty;
  const wakes: Wake[] = [];
  const seen = new Set<number>();
  for (const value of data["wakes"].slice(0, 500)) {
    const row = object(value);
    if (!row || !Number.isSafeInteger(row["number"]) || (row["number"] as number) < 1 ||
        !Number.isSafeInteger(row["day"]) || (row["day"] as number) < 1 ||
        !Number.isInteger(row["inBlock"]) || !TYPES.includes(row["phase"] as WakeType) || typeof row["title"] !== "string") continue;
    const number = row["number"] as number;
    if (seen.has(number)) continue;
    seen.add(number);
    wakes.push({ number, day: row["day"] as number, inBlock: row["inBlock"] as number, phase: row["phase"] as WakeType,
      title: row["title"], projectId: typeof row["projectId"] === "string" ? row["projectId"] : null,
      objective: typeof row["objective"] === "string" ? row["objective"].trim() || null : null,
      expected: typeof row["expected"] === "string" ? row["expected"] : null,
      state: row["state"] === "running" || row["state"] === "reserved" ? row["state"] : "planned" });
  }
  if (wakes.length === 0) return empty;
  wakes.sort((a, b) => a.number - b.number);
  for (const wake of wakes) empty.counts[wake.phase]++;
  return { ...empty, state: "ready", wakes, completed: typeof data["completed"] === "number" ? data["completed"] : 0,
    defined: wakes.filter(wake => Boolean(wake.objective?.trim())).length,
    projects: new Set(wakes.flatMap(wake => wake.projectId ? [wake.projectId] : [])).size };
}

export interface WakeCard { wakes: Wake[]; movable: boolean; }
export function wakeCards(wakes: Wake[]): WakeCard[] {
  const cards: WakeCard[] = [];
  for (const wake of wakes) {
    const last = cards.at(-1), previous = last?.wakes.at(-1);
    if (last && previous && wake.projectId === previous.projectId && wake.inBlock === previous.inBlock + 1 && wake.number === previous.number + 1) last.wakes.push(wake);
    else cards.push({wakes: [wake], movable: false});
  }
  for (const card of cards) card.movable = card.wakes.length === 10 && card.wakes[0]?.inBlock === 1 &&
    card.wakes[0]?.projectId !== null && card.wakes.every(wake => wake.state === "planned");
  return cards;
}

export function mountWakePreview(root: HTMLElement, saveOrder?: (projectIds: string[], revision: number) => Promise<void>): (input: unknown) => void {
  let signature = "", busy = false, dragging: number | null = null;
  let model = wakePreviewModel(null);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const status = element("p", "wake-plan-hint"); status.setAttribute("role", "status");
  const move = async (from: number, to: number) => {
    if (!saveOrder || model.revision === null || busy || from === to) return;
    const cards = wakeCards(model.wakes), movable = cards.filter(card => card.movable);
    if (!cards[from]?.movable || !cards[to]?.movable) return;
    const source = movable.indexOf(cards[from]!), target = movable.indexOf(cards[to]!);
    const [card] = movable.splice(source, 1); movable.splice(target, 0, card!);
    busy = true; status.textContent = "Enregistrement du nouvel ordre…";
    root.setAttribute("aria-busy", "true");
    try {
      await saveOrder(movable.map(item => item.wakes[0]!.projectId!), model.revision);
      status.textContent = "Ordre enregistré pour les prochains réveils.";
    } catch (error) { status.textContent = String(error); }
    finally { busy = false; root.removeAttribute("aria-busy"); }
  };
  return input => {
    if (dragging !== null || busy) return;
    const next = wakePreviewModel(input), key = JSON.stringify(next);
    if (signature === key) return;
    signature = key; model = next;
    const oldScroll = root.querySelector(".wake-plan-cards")?.scrollTop ?? 0;
    root.replaceChildren();
    if (model.state !== "ready") {
      root.append(element("p", "hint", model.state === "disabled" ? "La rotation des projets est désactivée." : "Le planning des wakes est indisponible pour le moment."));
      return;
    }
    root.append(element("p", "wake-plan-summary", `${model.wakes.length} réveils · ${model.projects} projets · ${model.defined} objectifs définis`),
      element("p", "wake-plan-hint", "Une carte = un bloc de projet. Glissez les cartes pour réordonner les blocs à venir, ou utilisez les flèches. Le bloc engagé garde sa place."));
    const list = element("div", "wake-plan-cards"); list.setAttribute("role", "list");
    const cards = wakeCards(model.wakes);
    cards.forEach((card, index) => {
      const first = card.wakes[0]!, last = card.wakes.at(-1)!;
      const node = element("article", "wake-project-card"); node.setAttribute("role", "listitem");
      node.style.setProperty("--project-color", projectMarker(first.projectId, first.title).color);
      const movable = card.movable && Boolean(saveOrder) && model.revision !== null;
      node.draggable = movable; node.dataset["movable"] = String(movable);
      const heading = element("div", "wake-card-heading"), title = element("strong", "wake-card-title", first.title);
      heading.append(projectBadge(first.projectId, first.title), title);
      if (movable) {
        const controls = element("span", "wake-card-controls");
        for (const [label, offset] of [["↑", -1], ["↓", 1]] as const) {
          const button = element("button", "wake-card-move", label); button.type = "button";
          button.setAttribute("aria-label", `${offset < 0 ? "Avancer" : "Reculer"} le bloc ${first.title}`);
          const target = offset < 0 ? cards.slice(0, index).findLastIndex(item => item.movable) : cards.findIndex((item, i) => i > index && item.movable);
          button.disabled = target < 0; button.addEventListener("click", () => { void move(index, target); });
          controls.append(button);
        }
        heading.append(controls);
      }
      const count = element("div", "wake-card-count", `${card.wakes.length} réveil${card.wakes.length > 1 ? "s" : ""}`);
      const range = element("p", "wake-card-range", `Wakes ${first.number}–${last.number} · J${first.day}${first.day !== last.day ? `–J${last.day}` : ""}`);
      const missing = card.wakes.filter(wake => !wake.objective).length;
      const badges = element("div", "wake-card-statuses");
      if (missing) { const badge = undefinedObjectiveBadge(); badge.textContent = `? ${missing} à définir`; badges.append(badge); }
      if (card.wakes.some(wake => wake.state === "running")) badges.append(element("span", "wake-band-state", "En cours"));
      else if (card.wakes.some(wake => wake.state === "reserved")) badges.append(element("span", "wake-band-state", "Lancement réservé"));
      else if (!movable) badges.append(element("span", "wake-card-range", "Bloc engagé ou partiel"));
      const details = element("details", "wake-card-objectives"), summary = element("summary", "", "Voir les objectifs");
      details.append(summary);
      for (const wake of card.wakes) {
        const row = element("p", "wake-card-objective", `Wake ${wake.number} · ${wake.objective || "Objectif à définir"}`);
        row.dataset["objectiveDefined"] = String(Boolean(wake.objective));
        details.append(row);
      }
      node.append(heading, count, range, badges, details);
      node.addEventListener("dragstart", event => {
        if (!movable || busy) { event.preventDefault(); return; }
        dragging = index; node.classList.add("wake-card-dragging");
        event.dataTransfer?.setData("text/plain", String(index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      node.addEventListener("dragover", event => {
        if (dragging === null || !movable || dragging === index || busy) return;
        event.preventDefault(); node.classList.add("wake-card-drop");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      node.addEventListener("dragleave", () => node.classList.remove("wake-card-drop"));
      node.addEventListener("drop", event => {
        event.preventDefault(); node.classList.remove("wake-card-drop");
        const source = dragging; dragging = null;
        if (source !== null) void move(source, index);
      });
      node.addEventListener("dragend", () => {
        dragging = null; node.classList.remove("wake-card-dragging");
        root.querySelectorAll(".wake-card-drop").forEach(item => item.classList.remove("wake-card-drop"));
      });
      list.append(node);
    });
    root.append(list, status, element("p", "wake-plan-footnote", `${model.completed} réveils effectués · Ordre enregistré dans le gestionnaire. Les objectifs restent révisables.`));
    list.scrollTop = oldScroll;
  };
}
