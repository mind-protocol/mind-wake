import {voiceChatControls,voiceTranscriptStatus} from './voice-chat-ui.js';
import { watchForkReply } from "./fork-reply-overlay.js";
import {forkVoice} from './fork-voice.js';
import type {VoiceScreenshots} from './voice-screenshots.js';
import { tr, formatLocale } from "./i18n.js";
import { projectWakesCard } from "./project-wakes.js";
import { renderMarkdown } from "./markdown.js";
import { roomName, setRoomLabels, setPrincipalName } from "./room-name.js";
import { renderRoomParticipants } from "./room-participants.js";
import { roomActivity } from "./room-activity.js";
import { composeField, copyButton } from "./copy-button.js";
import { agentTint, authorMarker, VOX_ROOM } from "./author-tint.js";
import { readingHold } from "./scroll-hold.js";
import { browserStorage, DraftStore, Outbox, sendOnEnter, typingIdle } from "./composer-kit.js";

interface ForkEntry {
  id: number;
  at: string;
  role: "agent" | "human" | "event";
  text: string;
  delivered: boolean;
  activity?: boolean;
  senderFork?: number;
  clusterStatus?: true;
  /** Notice runtime (ex. réponse rapide d'un autre fil) : ni toi ni un fork. */
  notice?: { label: string; hidden: boolean };
  source?: string;
}
export interface ForkView {
  projectWakes?: unknown;
  planning?: boolean;
  id: number;
  /** Nom affiché de la room (affectation `name`, signature, sinon « Room N »). */
  label?: string;
  enabled: boolean;
  projects: string[];
  threadId: string | null;
  lastTurn: { projectId: string | null; endedAt: string | null; outcome: string | null } | null;
  entries: ForkEntry[];
  activity?: { id:string; at:string; text:string; kind?:"final"; source?:string; threadId?:string }[];
}
export interface ForksView {
  principalName?: string;
  running: boolean;
  retryAtMs?: number;
  profile: string;
  forks: ForkView[];
}
/** Keep public activity separate from persisted replies and their unread cursors. */
export function forkConversationEntries(fork: ForkView): ForkEntry[] {
  return [...fork.entries, ...(fork.activity ?? [])
    .filter((item) => item.kind !== "final" || item.threadId !== undefined)
    .map((item): ForkEntry => ({id:0, at:item.at, text:item.text, role:"event", delivered:true,
      activity:true, ...(item.source === undefined ? {} : {source:item.source})}))]
    .sort((a,b) => Date.parse(a.at)-Date.parse(b.at));
}

export function forkIsWorking(fork: ForkView, model: ForksView, now = Date.now()): boolean {
  return (
    fork.enabled &&
    model.running &&
    model.profile === "run" &&
    (model.retryAtMs ?? 0) <= now &&
    fork.lastTurn?.endedAt === null &&
    (fork.planning === true || (
    fork.lastTurn.projectId !== null &&
    fork.projects.includes(fork.lastTurn.projectId)))
  );
}

/** Independent read cursors; human messages and lifecycle events never trigger a badge. */
export class ForkReadState {
  readonly cursors = new Map<number, number>();
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}
  private cursor(id: number): number {
    let value = this.cursors.get(id);
    if (value === undefined) {
      try {
        value = Number(this.storage.getItem(`mind-wake-fork-${String(id)}-read`));
      } catch {
        value = 0;
      }
      if (!Number.isSafeInteger(value) || value < 0) value = 0;
      this.cursors.set(id, value);
    }
    return value;
  }
  unread(fork: ForkView): number {
    const cursor = this.cursor(fork.id);
    return fork.entries.filter((entry) => entry.role === "agent" && entry.id > cursor).length;
  }
  markRead(fork: ForkView): void {
    const cursor = Math.max(
      this.cursor(fork.id),
      ...fork.entries.filter((entry) => entry.role === "agent").map((entry) => entry.id),
    );
    this.cursors.set(fork.id, cursor);
    try {
      this.storage.setItem(`mind-wake-fork-${String(fork.id)}-read`, String(cursor));
    } catch {
      /* Keep the cursor in memory when storage is unavailable. */
    }
  }
}

export function forkStatus(fork: ForkView, model: ForksView): string {
  if (!fork.enabled) return tr("Off · historique conservé");
  if (model.profile === "hold") return tr("En pause avec Wake");
  if (model.profile === "stop") return tr("En attente du profil Codex natif actif");
  if ((model.retryAtMs ?? 0) > Date.now()) return tr("En attente du fournisseur");
  if (!model.running) return tr("Démarrage du moteur…");
  if (fork.planning && forkIsWorking(fork, model)) return tr("Travaille · choix de ses prochains wakes");
  if (fork.projects.length === 0) return tr("En attente d’un projet disponible");
  if (forkIsWorking(fork, model)) return tr("Travaille · {0}", [fork.lastTurn?.projectId ?? tr("projet")]);
  return fork.lastTurn?.outcome === "rate_limited" ? tr("En attente du fournisseur") : "On";
}
export function mountForks(options: {
  invoke: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  voiceScreenshots: VoiceScreenshots;
  sampleVoiceScreen?():Promise<string>;
  liveReply?: { read(id: number): Promise<unknown>; show(text: string): Promise<unknown> };
  importVoiceImage(raw:string):Promise<{reference:string;capturedAt:string}>;
  selectTab: () => void;
  decorate: (body: HTMLElement, text: string) => void;
}): void {
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (found === null) throw Error(tr("Élément #{0} absent", [id]));
    return found;
  };
  const controls = element("fork-controls");
  const panel = element("view-forks");
  const heading = document.createElement("h2");
  const icon = (id: number): HTMLElement => {
    const avatar = document.createElement("span");
    avatar.className = "fork-icon";
    avatar.dataset["forkIcon"] = String(id);
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", tr("Agent Codex · {0}", [roomName(id)]));
    avatar.textContent = `⑂${String(id)}`;
    return avatar;
  };
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  // Agents et pattern holders de la room (holders-salles, 18 nov. 2026).
  const participants = document.createElement("p");
  participants.className = "room-participants";
  participants.hidden = true;
  const messages = document.createElement("ol");
  messages.id = "fork-thread-messages";
  messages.className = "messages";
  const incoming = document.createElement("p");
  incoming.className = "fork-presence";
  incoming.hidden = true;
  const presence = document.createElement("p");
  presence.className = "fork-presence";
  presence.setAttribute("role", "status");
  presence.hidden = true;
  const form = document.createElement("form");
  const text = document.createElement("textarea");
  text.rows = 3;
  text.maxLength = 4000;
  text.required = true;
  text.setAttribute("aria-label", tr("Message à la Room sélectionnée"));
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = tr("Envoyer");
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const voice=document.createElement('button'),cancelVoice=document.createElement('button'),voiceStatus=document.createElement('p');
  voice.type='button';voice.textContent='Voice';voice.setAttribute('aria-pressed','false');cancelVoice.type='button';cancelVoice.textContent='Annuler Voice';voiceStatus.setAttribute('role','status');
  form.append(composeField(text),send,voice,cancelVoice,voiceStatus,feedback);
  panel.append(heading, status, participants, messages, incoming, presence, form);
  const transcriptStatus=voiceTranscriptStatus(panel,"2");
  const updateVoice=voiceChatControls(voice,cancelVoice);
  updateVoice(false,false);
  const transcriptions=new Map<number,number>();
  // Access to localStorage itself may be disabled by the webview.
  const readState = new ForkReadState({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => {
      localStorage.setItem(key, value);
    },
  });
  let current = 2,
    model: ForksView | null = null,
    busy = false,
    lastEnsure = 0,
    signature = "",
    fresh = false;
  const rows = new Map<
    number,
    {
      toggle: HTMLButtonElement;
      detail: HTMLElement;
      tab: HTMLButtonElement;
      names: HTMLElement[];
      awaiting: HTMLElement;
      unread: HTMLElement[];
      working: HTMLElement[];
    }
  >();
  const drafts = new Map<number, string>();
  // Brouillons par Room gardés localement : un rechargement de l'app ne les efface plus.
  const storage = browserStorage();
  const draftStore = new DraftStore(storage, "mind-wake.room-draft.");
  const outbox = new Outbox(storage, "mind-wake.room-outbox");
  const draftOf = (id: number): string => drafts.get(id) ?? draftStore.get(id);
  const keepDraft = (id: number, value: string): void => { drafts.set(id, value); draftStore.set(id, value); };
  /** Envoi affiché tout de suite dans le fil, avant la réponse de la CLI (~1 à 3 s). */
  interface PendingSend { key: string; id: number; text: string; at: number; state: "sending" | "sent" | "unknown" | "failed"; restored: boolean; li: HTMLLIElement; label: HTMLElement }
  const pendings: PendingSend[] = [];
  let sendQueue: Promise<unknown> = Promise.resolve();
  const selections = new Map<number, {start:number;end:number;direction:'forward'|'backward'|'none'}>();
  const pendingVoiceOff = new Set<number>();
  const scrolls = new Map<number,number>(),voiceNotes=new Map<number,string>();
  // NLR (6 nov. 2026, 04:45) : ne jamais faire défiler quand il est remonté lire ; suivre seulement
  // s'il est déjà tout en bas, à quelques pixels près ; à l'ouverture de l'onglet, en bas une fois.
  const FOLLOW_SLACK_PX = 8;
  let pinned = true;
  const hold = readingHold(messages);
  const capture=forkVoice({screenshots:options.voiceScreenshots,invoke:options.invoke,importImage:raw=>options.importVoiceImage(raw),
    ...(options.sampleVoiceScreen?{visualSnapshot:options.sampleVoiceScreen}:{}),
    send:async(id,body,voiceScreenRefs)=>{
      // Recheck at transport time: a delayed transcription must not outlive Off/Pause.
      if(model?.profile!=="run" || pendingVoiceOff.has(id) || !model.forks.find(f=>f.id===id)?.enabled)
        throw Error("Dictée conservée en brouillon : Room arrêtée ou en pause ; aucun nouvel envoi.");
      await request('send',{id,text:body,...(voiceScreenRefs?.length?{voiceScreenRefs}:{})});
    },
    recover:(id,body)=>{const previous=id===current?text.value:draftOf(id);const recovered=[previous,body].filter(Boolean).join('\n\n');keepDraft(id,recovered);if(current===id){const start=text.selectionStart,end=text.selectionEnd,direction=text.selectionDirection;text.value=recovered;if(typeof text.setSelectionRange === "function")text.setSelectionRange(start,end,direction);}},
    captureSegment:(id,event)=>{transcriptStatus.segment(String(id),event);},
    transcribing:(id,pending)=>{transcriptions.set(id,pending);transcriptStatus(transcriptions.get(current)??0);},
    presentation:(recording,processing,starting)=>{updateVoice(recording,processing,starting);},
    status:(id,note)=>{const scoped=roomName(id)+" · "+note;voiceNotes.set(id,scoped);if(id===current)voiceStatus.textContent=scoped;},
  });
  voice.onclick=()=>{
    if(capture.target()===undefined && (model?.profile!=="run" || pendingVoiceOff.has(current) || !model.forks.find(f=>f.id===current)?.enabled)) {
      voiceStatus.textContent="Voice indisponible : cette Room est arrêtée ou Wake est en pause.";
      return;
    }
    void (capture.target()===undefined?capture.start(current):capture.stop()).catch(showError);
  };
  cancelVoice.onclick=()=>{void capture.stop(true);};
  window.addEventListener('voice-stop',()=>{void capture.stop(true);});
  window.addEventListener('fork-voice-stop',()=>{void capture.stop(true);});
  window.addEventListener('beforeunload',()=>{void capture.stop(true);});
  // Bandeau : seulement les salles actives (critère : room-activity.ts) ; les autres derrière « + N autres ».
  let showAllRooms = false;
  const moreRooms = document.createElement("button");
  moreRooms.type = "button";
  moreRooms.className = "fork-more-rooms";
  moreRooms.hidden = true;
  moreRooms.addEventListener("click", () => { showAllRooms = !showAllRooms; render(); });
  element("tab-second").before(moreRooms);
  // Renommer en un geste (NLR, 18 nov. 2026) : clic sur le nom dans l'en-tête → champ → Entrée.
  // Nom affiché seulement : l'identifiant de la salle (fork:N, @roomN) ne change pas.
  const headingName = document.createElement("button");
  headingName.type = "button";
  headingName.className = "room-name-edit";
  headingName.title = tr("Renommer la salle (nom affiché seulement)");
  let renaming = false;
  headingName.addEventListener("click", () => {
    if (renaming) return;
    renaming = true;
    const id = current;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.value = roomName(id);
    input.className = "room-name-input";
    input.setAttribute("aria-label", tr("Nouveau nom de la salle (vide : nom par défaut)"));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(headingName);
      renaming = false;
      if (!save || value === roomName(id)) { render(); return; }
      headingName.textContent = value || `Room ${String(id)}`;
      void request("rename", { id, text: value }).then(apply).catch((error: unknown) => { showError(error); render(); });
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => { finish(false); });
    headingName.replaceWith(input);
    input.focus();
    input.select();
  });
  for (let id = 2; id <= 8; id++) {
    const row = document.createElement("div");
    row.className = "fork-control";
    const label = document.createElement("strong");
    const labelName = document.createElement("span");
    labelName.textContent = roomName(id);
    label.append(icon(id), " ", labelName, " · Codex");
    const badge = (): HTMLElement => {
      const node = document.createElement("span");
      node.className = "fork-unread";
      node.hidden = true;
      return node;
    };
    const working = (): HTMLElement => {
      const node = document.createElement("span");
      node.className = "fork-working";
      node.textContent = tr("Travaille");
      node.hidden = true;
      return node;
    };
    const overviewUnread = badge(),
      overviewWorking = working();
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", tr("Activer {0} · Codex", [roomName(id)]));
    toggle.setAttribute("aria-checked", "false");
    toggle.textContent = "Off";
    const detail = document.createElement("small");
    detail.textContent = tr("Lecture…");
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = tr("Ouvrir le fil");
    row.append(label, toggle, open, overviewWorking, overviewUnread, detail);
    controls.append(row);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `tab-fork-${String(id)}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "view-forks");
    tab.setAttribute("aria-selected", "false");
    tab.dataset["forkTab"] = String(id);
    const tabUnread = badge(),
      tabWorking = working();
    const tabName = document.createElement("span");
    tabName.className = "fork-tab-name";
    tabName.textContent = roomName(id);
    const tabAwaiting = document.createElement("span");
    tabAwaiting.className = "fork-unread fork-awaiting";
    tabAwaiting.textContent = tr("attend ta réponse");
    tabAwaiting.hidden = true;
    tab.append(icon(id), " ", tabName, tabWorking, tabUnread, tabAwaiting);
    tab.hidden = true;
    moreRooms.before(tab);
    const select = () => {
      keepDraft(current, text.value);
      selections.set(current,{start:text.selectionStart,end:text.selectionEnd,direction:text.selectionDirection});
      // Position de lecture gardée seulement si NLR était remonté lire ; en bas, rien à garder.
      if (!panel.hidden && messages.scrollHeight - messages.scrollTop - messages.clientHeight > FOLLOW_SLACK_PX)
        scrolls.set(current, messages.scrollTop);
      else scrolls.delete(current);
      current = id;
      transcriptStatus.select(String(id));
      transcriptStatus(transcriptions.get(id)??0);
      text.value = draftOf(id);
      const selection=selections.get(id);
      if(selection && typeof text.setSelectionRange === "function")text.setSelectionRange(selection.start,selection.end,selection.direction);
      feedback.textContent = "";
      voiceStatus.textContent=voiceNotes.get(id) || ((target)=>target===undefined?'':'Capture liée à '+roomName(target))(capture.target());
      signature = "";
      options.selectTab();
      document.querySelectorAll("[data-fork-tab]").forEach((button) => {
        button.setAttribute("aria-selected", "false");
      });
      panel.hidden = false;
      panel.setAttribute("aria-labelledby", tab.id);
      tab.setAttribute("aria-selected", "true");
      render();
      // NLR (6 nov. 2026, 04:45) : à l'ouverture, en bas une fois ; un fil quitté en cours de
      // lecture retrouve sa position, sans défilement.
      const reading = scrolls.get(id);
      if (reading === undefined) scrollToEnd();
      else {
        pinned = false;
        hold.keep(reading);
      }
      updateIndicators();
    };
    tab.addEventListener("click", select);
    open.addEventListener("click", select);
    toggle.addEventListener("click", () => {
      const fork = model?.forks.find((f) => f.id === id);
      if (!fork) return;
      toggle.disabled = true;
      if(fork.enabled) {
        pendingVoiceOff.add(id);
        // Cancel synchronously, before waiting on the Off request or a status refresh.
        if(capture.target()===id)void capture.stop(true);
      }
      void request(fork.enabled ? "off" : "on", { id })
        .then(apply)
        .catch(showError)
        .finally(() => {
          pendingVoiceOff.delete(id);
          toggle.disabled = false;
        });
    });
    rows.set(id, {
      toggle,
      detail,
      tab,
      names: [labelName, tabName],
      awaiting: tabAwaiting,
      unread: [overviewUnread, tabUnread],
      working: [overviewWorking, tabWorking],
    });
  }
  function showError(error: unknown) {
    fresh = false;
    updateIndicators();
    feedback.textContent = error instanceof Error ? error.message : String(error);
    element("fork-feedback").textContent = feedback.textContent;
  }
  async function request(action: string, args: Record<string, unknown> = {}) {
    const response = await options.invoke("wake_forks", { action, ...args });
    if (response.ok !== true)
      throw Error(
        typeof response.error?.message === "string"
          ? response.error.message
          : tr("Commande de Room refusée"),
      );
    return response.data as ForksView;
  }
  function apply(next: ForksView) {
    model = next;
    setPrincipalName(next.principalName ?? "Marco");
    const principalTab = document.getElementById("conversation-general");
    if (principalTab) principalTab.textContent = roomName(1);
    setRoomLabels(next.forks);
    const target=capture.target();
    if(target!==undefined && (next.profile!=="run" || pendingVoiceOff.has(target) || !next.forks.find(f=>f.id===target)?.enabled))void capture.stop(true);
    fresh = true;
    render();
  }
  function updateIndicators() {
    if (model === null) return;
    const active = model.forks.find((fork) => fork.id === current);
    if (
      active &&
      !panel.hidden &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100
    )
      readState.markRead(active);
    for (const fork of model.forks) {
      const row = rows.get(fork.id);
      if (!row) continue;
      const count = readState.unread(fork);
      for (const badge of row.unread) {
        badge.hidden = count === 0;
        badge.textContent = count > 1 ? tr("Nouveau message · {0}", [String(count)]) : tr("Nouveau message");
      }
      const working = fresh && forkIsWorking(fork, model);
      for (const indicator of row.working) indicator.hidden = !working;
      row.tab.dataset["working"] = String(working);
      row.tab.setAttribute(
        "aria-label",
        `${roomName(fork.id)}${working ? tr(" · Travaille") : ""}${count ? ` · ${String(count)} message(s) non lu(s)` : ""}`,
      );
    }
    const working = active !== undefined && fresh && forkIsWorking(active, model);
    presence.hidden = !working;
    if (working)
      presence.replaceChildren(
        icon(current),
        document.createTextNode(` ${roomName(current)} travaille`),
      );
  }
  function render() {
    if (!model) return;
    let hiddenRooms = 0;
    for (const fork of model.forks) {
      const row = rows.get(fork.id);
      if (!row) continue;
      row.toggle.textContent = fork.enabled ? "On" : "Off";
      row.toggle.setAttribute("aria-checked", String(fork.enabled));
      row.detail.textContent = `${forkStatus(fork, model)}${fork.projects.length ? ` · ${fork.projects.join(", ")}` : ""}`;
      for (const name of row.names) name.textContent = roomName(fork.id);
      const used = fork.enabled || fork.entries.length > 0 || fork.threadId !== null || (fork.id === current && !panel.hidden);
      const unread = readState.unread(fork);
      const reason = used ? roomActivity(fork, {
        selected: fork.id === current && !panel.hidden,
        working: fresh && forkIsWorking(fork, model),
        unread,
      }) : null;
      row.awaiting.hidden = reason !== "attend ta réponse" || unread > 0;
      row.tab.dataset["active"] = String(reason !== null);
      row.tab.title = reason ? `${roomName(fork.id)} · ${tr(reason)}` : roomName(fork.id);
      if (used && reason === null) hiddenRooms++;
      row.tab.hidden = !used || (reason === null && !showAllRooms);
    }
    moreRooms.hidden = hiddenRooms === 0;
    moreRooms.textContent = showAllRooms ? tr("Masquer les salles inactives") : tr("+ {0} autres", [String(hiddenRooms)]);
    moreRooms.setAttribute("aria-expanded", String(showAllRooms));
    const fork = model.forks.find((f) => f.id === current);
    if (!fork) return;
    if (!renaming) {
      headingName.textContent = roomName(current);
      heading.replaceChildren(icon(current), " ", headingName, document.createTextNode(" · Codex"));
    }
    status.textContent = forkStatus(fork, model);
    renderRoomParticipants(participants, fork);
    const conversation = forkConversationEntries(fork);
    prunePendings();
    const next = JSON.stringify([current, conversation, fork.projectWakes]);
    if (next === signature) {
      updateIndicators();
      return;
    }
    signature = next;
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= FOLLOW_SLACK_PX;
    const reading = messages.scrollTop;
    messages.replaceChildren(
      ...conversation.map((entry) => {
        const statusAuthor = entry.clusterStatus && entry.senderFork !== undefined
          ? roomName(entry.senderFork)
          : undefined;
        const li = document.createElement("li");
        li.dataset["self"] = String(entry.role === "human" && entry.senderFork === undefined && entry.notice === undefined);
        if (entry.notice) li.dataset["from"] = "received";
        if (statusAuthor) li.dataset["from"] = "received";
        else if (entry.activity) li.dataset["from"] = "activity";
        const meta = document.createElement("small");
        const marker = authorMarker(li, entry.notice ? null
          : entry.role === "human" ? entry.senderFork === undefined ? "owner" : entry.senderFork === VOX_ROOM ? "vox" : null
          : entry.role === "agent" ? agentTint(entry.text, current) : null);
        if (marker) meta.append(marker);
        if (entry.role === "agent") meta.append(icon(current), " ");
        meta.append(
          `${entry.notice ? entry.notice.label : statusAuthor ? `FYI · ${statusAuthor}` : entry.role === "human" ? (entry.senderFork === undefined ? tr("Toi") : roomName(entry.senderFork)) : entry.role === "agent" ? `Codex · ${roomName(current)}` : entry.activity ? tr("Activité{0}", [entry.source ? ` · ${entry.source}` : ""]) : tr("État")} · ${new Date(entry.at).toLocaleString(formatLocale())}`,
        );
        if (entry.role === "human" && !entry.notice) {
          const receipt = document.createElement("span");
          receipt.className = "delivery-receipt";
          receipt.dataset["delivered"] = String(entry.delivered);
          receipt.textContent = entry.delivered ? " ✓✓" : tr(" ✓ · en file");
          receipt.title = entry.delivered ? tr("Transmis à la session de l’agent") : tr("Message enregistré dans la boîte de la Room.");
          meta.append(receipt);
        }
        const body =
          entry.role === "agent" ? renderMarkdown(entry.text) : document.createElement("p");
        if (entry.role === "agent") options.decorate(body, entry.text);
        else {
          const prefix = `FYI — ${statusAuthor} : `;
          body.textContent = statusAuthor && entry.text.startsWith(prefix) ? entry.text.slice(prefix.length) : entry.text;
        }
        li.append(meta, body, copyButton(() => entry.text));
        return li;
      }),
    );
    const objectives = projectWakesCard(fork.projectWakes, `fork-${String(current)}`);
    if (objectives) messages.append(objectives);
    showPendings();
    if (follow) scrollToEnd();
    else {
      pinned = false;
      hold.keep(reading);
    }
    updateIndicators();
  }
  /** Bas du fil, puis encore après la mise en page (Markdown, images) : le dernier message reste visible. */
  function scrollToEnd() {
    pinned = true;
    hold.keep(null);
    messages.scrollTop = messages.scrollHeight;
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => {
        if (pinned) messages.scrollTop = messages.scrollHeight;
      });
  }
  // Suit le bas tant que NLR y est ; une image chargée plus tard ne le fait pas décrocher.
  messages.addEventListener("scroll", () => {
    // Un défilement causé par le re-rendu (images rechargées) n'est pas une lecture de l'humain.
    if (!hold.holding()) pinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= FOLLOW_SLACK_PX;
  });
  messages.addEventListener(
    "load",
    () => {
      if (pinned) messages.scrollTop = messages.scrollHeight;
    },
    true,
  );
  messages.addEventListener("scroll", updateIndicators);
  document.addEventListener("visibilitychange", updateIndicators);
  window.addEventListener("focus", updateIndicators);
  function pendingState(p: PendingSend, state: PendingSend["state"], detail = ""): void {
    p.state = state;
    p.li.dataset["sending"] = String(state === "sending" || state === "unknown");
    if (state === "failed") p.li.dataset["failed"] = "true";
    else delete p.li.dataset["failed"];
    p.li.querySelector(".message-retry")?.remove();
    p.label.textContent = state === "sending" ? tr("Toi · Envoi en cours…")
      : state === "sent" ? tr("Toi · Parti ✓")
      : state === "unknown" ? tr("Toi · Envoi interrompu par le rechargement · vérification…")
      : tr("Toi · Échec de l’envoi : {0}", [detail]);
    if (state === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "message-retry";
      retry.textContent = tr("Réessayer");
      retry.addEventListener("click", () => { transmit(p); });
      p.li.append(retry);
    }
  }
  function pendingBubble(key: string, id: number, value: string, at: number, restored: boolean): PendingSend {
    const li = document.createElement("li"), meta = document.createElement("small"), label = document.createElement("span");
    const body = document.createElement("p");
    li.dataset["self"] = "true";
    li.className = "message-outgoing";
    label.setAttribute("role", "status");
    const marker = authorMarker(li, "owner");
    if (marker) meta.append(marker);
    meta.append(label);
    body.textContent = value;
    li.append(meta, body, copyButton(() => value));
    const p: PendingSend = { key, id, text: value, at, state: "sending", restored, li, label };
    pendings.push(p);
    return p;
  }
  function dropPending(p: PendingSend): void {
    const index = pendings.indexOf(p);
    if (index >= 0) pendings.splice(index, 1);
    p.li.remove();
    outbox.remove(p.key);
  }
  /** Retire un envoi confirmé dès que le message réel apparaît dans le fil de sa Room. */
  function prunePendings(): void {
    if (!model) return;
    for (const p of [...pendings]) {
      if (p.state === "sending" || (p.state === "failed" && !p.restored)) continue;
      const fork = model.forks.find((f) => f.id === p.id);
      const seen = fork?.entries.some((e) => e.role === "human" && e.senderFork === undefined && e.notice === undefined &&
        e.text.trim() === p.text && Date.parse(e.at) >= p.at - 120_000) === true;
      // Arrivé finalement (envoi d'avant le rechargement) : retirer aussi le texte rendu au champ.
      if (seen && p.restored && p.id === current && text.value.trim() === p.text) { text.value = ""; keepDraft(p.id, ""); }
      if (seen || (p.state === "sent" && Date.now() - p.at > 120_000)) dropPending(p);
    }
  }
  function showPendings(): void {
    for (const p of pendings) if (p.id === current) messages.append(p.li);
  }
  /** Échec : le texte revient dans le champ de sa Room s'il est vide. */
  function restoreText(p: PendingSend): void {
    if (p.id === current) {
      if (text.value.trim() !== "") return;
      text.value = p.text;
      keepDraft(p.id, p.text);
    } else if (draftOf(p.id).trim() === "") keepDraft(p.id, p.text);
  }
  function transmit(p: PendingSend): void {
    pendingState(p, "sending");
    // Envois de la page gardés dans l'ordre ; la frappe et les autres Rooms restent libres.
    const run = sendQueue.then(() => request("send", { id: p.id, text: p.text }));
    sendQueue = run.catch(() => undefined);
    void run.then((next) => {
      outbox.remove(p.key);
      pendingState(p, "sent");
      if (current === p.id && text.value.trim() === p.text) { text.value = ""; keepDraft(p.id, ""); }
      apply(next);
    }, (error: unknown) => {
      outbox.remove(p.key);
      pendingState(p, "failed", error instanceof Error ? error.message : String(error));
      restoreText(p);
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    const id = current, at = Date.now(), key = `room-${String(id)}-${String(at)}-${Math.random().toString(36).slice(2, 8)}`;
    const p = pendingBubble(key, id, value, at, false);
    outbox.add({ key, text: value, at: new Date(at).toISOString(), target: id });
    // Champ vidé tout de suite ; le texte reste dans la bulle et la file locale jusqu'à confirmation.
    text.value = "";
    keepDraft(id, "");
    feedback.textContent = "";
    messages.append(p.li);
    scrollToEnd();
    transmit(p);
  });
  sendOnEnter(text, () => { form.requestSubmit(); });
  text.addEventListener("input", () => { keepDraft(current, text.value); });
  text.value = draftOf(current);
  // Rechargement pendant un envoi : sans clé d'idempotence côté Room, vérifier le fil avant de proposer un renvoi.
  for (const saved of outbox.list()) {
    const id = Number(saved.target);
    if (!Number.isInteger(id) || id < 2 || id > 8) { outbox.remove(saved.key); continue; }
    pendingState(pendingBubble(saved.key, id, saved.text, Date.parse(saved.at) || Date.now(), true), "unknown");
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      // ~0,9 Mo de JSON par lecture : attendre une pause de frappe (5 s au plus).
      await typingIdle();
      const ensure = Date.now() - lastEnsure > 60_000;
      if (ensure) lastEnsure = Date.now();
      apply(await request(ensure ? "ensure" : "status"));
      // Envois d'avant le rechargement toujours absents du fil : proposer le renvoi, rendre le texte.
      for (const p of [...pendings]) if (p.state === "unknown") { outbox.remove(p.key); pendingState(p, "failed", tr("non confirmé avant le rechargement")); restoreText(p); }
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }
  if (options.liveReply) watchForkReply(
    () => !panel.hidden && model?.profile === "run" && model.forks.some(fork => fork.id === current && fork.enabled) ? current : undefined,
    options.liveReply.read, options.liveReply.show, text => {
      incoming.textContent = text;
      incoming.hidden = !text;
    },
  );
  void refresh();
  setInterval(() => void refresh(), 5000);
}
