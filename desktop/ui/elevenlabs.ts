type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Settings {
  enabled: boolean;
  autoplay: boolean;
  voiceId: string;
  hasKey: boolean;
}
interface Clip {
  id: string;
  text: string;
  voiceId: string;
  autoplay: boolean;
}

export function initElevenLabs(invoke: Invoke): void {
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
  let playbackRevision = 0;
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
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (url) URL.revokeObjectURL(url);
    url = null;
    current = null;
    acknowledged = false;
    player.hidden = true;
  }
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
  audio.addEventListener("playing", () => void acknowledge());
  audio.addEventListener("ended", () => void poll());
  audio.addEventListener("error", () => {
    get("playing").textContent = "Lecture impossible. Passer ce clip ou réessayer avec le lecteur.";
  });
  get("skip").addEventListener("click", () => {
    audio.pause();
    void acknowledge().then((ok) => {
      if (ok) clear();
    });
  });
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const pending = await call<{ allowed: boolean; clips: Clip[] }>("pending");
      if (!pending.allowed) {
        if (current) clear();
        return;
      }
      if (current && !audio.ended) return;
      const clip = pending.clips.find((item) => item.id !== current?.id);
      if (!clip) return; // Keep finished audio available for replay.
      const revision = playbackRevision;
      const data = await call<{ base64: string }>("audio", clip.id);
      // A replay may have started while the next clip was loading. Let it finish.
      if (revision !== playbackRevision || (current && !audio.ended)) return;
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
          get("playing").textContent = `Appuyer sur lecture · ${clip.text}`;
        }
      }
    } catch (error) {
      feedback.textContent = String(error);
    } finally {
      polling = false;
    }
  }
  void call<Settings>("status")
    .then(render)
    .catch((error: unknown) => {
      feedback.textContent = String(error);
    });
  void poll();
  window.setInterval(() => void poll(), 3000);
}
