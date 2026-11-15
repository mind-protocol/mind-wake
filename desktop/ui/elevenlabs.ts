import {VOICE_START_SPACING_MS,type VoiceCycleEvent} from './voice-cycle.js';
import {isVoiceThreadId} from './voice-conversations.js';
import type {VoiceModeState} from "./voice-mode-view.js";
import {voiceShortcutAction} from "./voice-shortcuts.js";
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Settings {
  enabled: boolean;
  autoplay: boolean;
  voiceId: string;
  hasKey: boolean;
  /** Présent quand le disjoncteur crédits a coupé la voix ; recocher l'autorisation la rouvre. */
  voiceStatus?: string;
}
export interface Clip {
  id: string;
  text: string;
  voiceId: string;
  threadId?: string;
  agentRef?: string;
  cycleId?: string;
  voiceModeRevision?:string;
  autoplay: boolean;
}

export function initElevenLabs(invoke: Invoke, speaking: (active: boolean) => void = () => {}, played:(clip:Clip)=>void = () => {}, cycleEvent:(event:VoiceCycleEvent)=>void = () => {}): {interrupt():boolean} {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller selects the concrete DOM element
  const get = <T extends HTMLElement>(id: string): T =>
    document.getElementById(`elevenlabs-${id}`) as T;
  const form = get<HTMLFormElement>("form"),
    key = get<HTMLInputElement>("key");
  const voice = get<HTMLSelectElement>("voice"),
    enabled = get<HTMLInputElement>("enabled");
  const autoplay = get<HTMLInputElement>("autoplay"),
    feedback = get("feedback");
  const player = get("player"),
    audio = get<HTMLAudioElement>("audio");
  let current: Clip | null = null,
    url: string | null = null,
    polling = false,
    busy = false;
  let acknowledging = false;
  let acknowledged = false;
  let locallyStarted = false;
  let playbackRevision = 0;
  let lastStartedAt:number|undefined;
  // Clips listed by the last poll, and a counter that invalidates a poll racing a barge-in.
  let queued:Clip[]=[];
  let interruptRevision=0;
  const cycleState=(clip:Clip,phase:"ready"|"playing"|"ended"|"error"|"cancelled")=>{if(clip.cycleId&&isVoiceThreadId(clip.threadId))cycleEvent({kind:"state",cycleId:clip.cycleId,threadId:clip.threadId,phase,clipId:clip.id,at:Date.now()});};
  async function call<T>(action: string, payload?: unknown): Promise<T> {
    const result = (await invoke("elevenlabs", {
      action,
      ...(payload === undefined ? {} : { payload }),
    })) as { stdout: string; exitCode: number };
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: T;
      error?: { message: string };
    };
    if (!envelope.ok || result.exitCode !== 0)
      throw Error(envelope.error?.message ?? "ElevenLabs indisponible");
    return envelope.data;
  }
  function render(settings: Settings): void {
    enabled.checked = settings.enabled;
    autoplay.checked = settings.autoplay;
    voice.replaceChildren(new Option(settings.voiceId || "Choisir une voix", settings.voiceId));
    get("key-state").textContent = settings.hasKey ? "Clé enregistrée" : "Aucune clé enregistrée";
    if (settings.voiceStatus) feedback.textContent = settings.voiceStatus;
  }
  async function save(): Promise<void> {
    const settings = await call<Settings>("configure", {
      enabled: enabled.checked,
      autoplay: autoplay.checked,
      voiceId: voice.value,
      apiKey: key.value,
    });
    key.value = "";
    get("key-state").textContent = settings.hasKey ? "Clé enregistrée" : "Aucune clé enregistrée";
  }
  async function action(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    const buttons = [...form.querySelectorAll("button"), get<HTMLButtonElement>("generate")];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    feedback.textContent = "En cours…";
    try {
      await work();
    } catch (error) {
      feedback.textContent = String(error);
    } finally {
      busy = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
      await save();
      feedback.textContent = "Réglages enregistrés.";
    });
  });
  get("load").addEventListener(
    "click",
    () =>
      void action(async () => {
        // Saving the key alone does not enable generation or consume speech credits.
        if (key.value.trim()) {
          const saved = await call<Settings>("status");
          await call("configure", {
            enabled: saved.enabled,
            autoplay: saved.autoplay,
            voiceId: saved.voiceId,
            apiKey: key.value,
          });
          key.value = "";
          get("key-state").textContent = "Clé enregistrée";
        }
        const selected = voice.value,
          options: HTMLOptionElement[] = [new Option("Choisir une voix", "")];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await call<{
            voices: { voice_id: string; name: string; labels?: Record<string, string> }[];
            has_more: boolean;
            next_page_token?: string | null;
          }>("voices", cursor);
          for (const item of page.voices)
            options.push(
              new Option(
                `${item.name}${item.labels?.["language"] ? ` · ${item.labels["language"]}` : ""}`,
                item.voice_id,
              ),
            );
          cursor = page.has_more ? (page.next_page_token ?? undefined) : undefined;
          if (cursor && seen.has(cursor)) throw Error("Pagination ElevenLabs invalide.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        if (selected && !options.some((option) => option.value === selected))
          options.push(new Option(selected, selected));
        voice.replaceChildren(...options);
        voice.value = selected;
        feedback.textContent = "Choisir une voix puis enregistrer.";
      }),
  );
  get("generate").addEventListener(
    "click",
    () =>
      void action(async () => {
        await save();
        await call("generate", { text: get<HTMLTextAreaElement>("test").value });
        feedback.textContent = "Voix générée. Disponible dans le lecteur.";
        await poll();
      }),
  );
  function clear(): void {
    playbackRevision++;
    if (current && !audio.ended) cycleState(current,"cancelled");
    if (current && !audio.ended) void call("event", {id:current.id,phase:"cancelled"}).catch(() => {});
    speaking(false);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (url) URL.revokeObjectURL(url);
    url = null;
    current = null;
    acknowledged = false;
    locallyStarted = false;
    player.hidden = true;
  }
  window.addEventListener('voice-mode-off',()=>{if(current&&isVoiceThreadId(current.threadId))clear();});
  async function acknowledge(): Promise<boolean> {
    if (acknowledged) return true;
    if (!current || acknowledging) return false;
    acknowledging = true;
    const clip = current;
    const id = clip.id;
    try {
      await call("ack", id);
      if (current === clip) acknowledged = true;
      return true;
    } catch (error) {
      feedback.textContent = String(error);
      return false;
    } finally {
      acknowledging = false;
    }
  }
  // Acknowledging on first actual playback avoids replaying old clips after reopening.
  audio.addEventListener("play", () => {
    playbackRevision++;
  });
  audio.addEventListener("playing", () => {
    speaking(true);
    const clip=current;
    if(clip) {locallyStarted=true;lastStartedAt=Date.now();played({...clip});cycleState(clip,"playing");}
    // The service acknowledges inside started. Keep local playback alive while IPC
    // returns, and never let an old receipt acknowledge a newer selected clip.
    if(clip) void call("event", {id:clip.id,phase:"started"}).then(() => {
      if(current===clip)acknowledged=true;
    }).catch(error => {feedback.textContent=String(error);});
  });
  audio.addEventListener("ended", () => {
    speaking(false);
    if(current) cycleState(current,"ended");
    if(current) void call("event", {id:current.id,phase:"ended"}).catch(() => {});
    void poll();
  });
  audio.addEventListener("pause", () => speaking(false));
  audio.addEventListener("error", () => {
    speaking(false);
    if(current) cycleState(current,"error");
    if(current) void call("event", {id:current.id,phase:"error"}).catch(() => {});
    get("playing").textContent = "Lecture impossible. Passer ce clip ou réessayer avec le lecteur.";
  });
  audio.addEventListener("timeupdate",()=>{if(current&&isVoiceThreadId(current.threadId))cycleEvent({kind:"playback",threadId:current.threadId,clipId:current.id,at:Date.now(),elapsed:audio.currentTime,duration:audio.duration});});
  const skip = (): void => {
    audio.pause();
    void acknowledge().then((ok) => {
      if (ok) { clear(); void poll(); }
    });
  };
  get("skip").addEventListener("click", skip);
  get("skip").title = "Passer le vocal · Entrée";
  audio.title = "Espace : pause / reprise · Entrée : vocal suivant";
  window.addEventListener("keydown", (event) => {
    if (!current || player.hidden) return;
    const shortcut = voiceShortcutAction(event, audio);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "skip") { skip(); return; }
    if (!audio.paused) { audio.pause(); return; }
    void audio.play().catch(() => {
      if (current) void call("event", {id:current.id,phase:"blocked"}).catch(() => {});
      get("playing").textContent = `Appuyer sur lecture · ${current?.text ?? ""}`;
    });
  });
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const pending = await call<{ allowed: boolean; clips: Clip[];voiceMode?:VoiceModeState }>("pending");
      if(current&&isVoiceThreadId(current.threadId)&&pending.voiceMode&&(!pending.voiceMode.enabled||!pending.voiceMode.microphoneActive||pending.voiceMode.paused||pending.voiceMode.forceOff||current.voiceModeRevision!==pending.voiceMode.revision))clear();
      if (!pending.allowed) {
        cycleEvent({kind:"stop",at:Date.now()});
        if (current) clear();
        return;
      }
      queued=pending.clips;
      for(const clip of pending.clips)cycleState(clip,"ready");
      // Drop an unplayed stale selection whose marker was removed externally.
      if (current && !locallyStarted && !acknowledged && !pending.clips.some(item => item.id === current?.id)) clear();
      if (current && !audio.ended) {
        const updated = pending.clips.find(item => item.id === current?.id);
        if (!acknowledged && !current.autoplay && updated?.autoplay) {
          current.autoplay = true;
          try { await audio.play(); }
          catch { void call("event", {id:current.id,phase:"blocked"}).catch(() => {}); }
        }
        return;
      }
      const candidates = pending.clips.filter((item) => item.id !== current?.id);
      if (!candidates.length) return; // Keep finished audio available for replay.
      // Model replies may arrive together; speech remains serial and spaced.
      const wait=lastStartedAt===undefined?0:Math.max(0,lastStartedAt+VOICE_START_SPACING_MS-Date.now());
      if(wait>0){get("playing").textContent=`Vocal prêt · pause avant la prochaine voix (${Math.ceil(wait/1000)} s)`;return;}
      const revision = playbackRevision;
      const interrupted = interruptRevision;
      // A clip already claimed elsewhere must not block the ones behind it.
      let clip: Clip | undefined, data: { base64: string } | undefined;
      for (const candidate of candidates) {
        const audioData = await call<{ base64: string }>("audio", candidate.id);
        // A replay may have started while the next clip was loading. Let it finish.
        if (revision !== playbackRevision || (current && !audio.ended)) return;
        if ((await call<{claimed:boolean}>("claim", candidate.id)).claimed) { clip = candidate; data = audioData; break; }
      }
      // The human interrupted while this clip was being claimed: it belongs to the dropped queue.
      if (clip && interrupted !== interruptRevision) { dropQueued([clip]); return; }
      if (!clip || !data) return;
      clear();
      current = clip;
      const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      audio.src = url;
      player.hidden = false;
      get("playing").textContent = clip.text;
      if (clip.autoplay) {
        try {
          await audio.play();
        } catch {
          void call("event", {id:clip.id,phase:"blocked"}).catch(() => {});
          get("playing").textContent = `Appuyer sur lecture · ${clip.text}`;
        }
      }
    } catch (error) {
      feedback.textContent = String(error);
    } finally {
      polling = false;
    }
  }
  function dropQueued(clips:Clip[]):void{
    for(const clip of clips){
      cycleState(clip,"cancelled");
      void call("event",{id:clip.id,phase:"cancelled"}).catch(() => {});
      // Same receipt as Skip: removes the pending marker, keeps the MP3 on disk.
      void call("ack",clip.id).catch(() => {});
    }
  }
  /** Barge-in: the human speaks over the agent. Stops at once, drops the clips already queued. */
  function interrupt():boolean{
    if(!current||audio.paused||audio.ended)return false;
    const clip=current,rest=queued.filter(item=>item.id!==clip.id);
    interruptRevision++;
    queued=[];
    audio.pause();
    clear();
    void call("ack",clip.id).catch(() => {});
    dropQueued(rest);
    return true;
  }
  void call<Settings>("status")
    .then(render)
    .catch((error: unknown) => {
      feedback.textContent = String(error);
    });
  void poll();
  window.setInterval(() => void poll(), 1500);
  return {interrupt};
}

