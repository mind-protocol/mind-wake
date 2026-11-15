interface Snapshot {
  turn: string;
  text: string;
  at: number;
}

/** Read just the selected fork's current text, without spawning CLI polls or replaying history. */
export function watchForkReply(
  selected: () => number | undefined,
  read: (id: number) => Promise<unknown>,
  show: (text: string) => Promise<unknown>,
  showIncoming: (text: string) => void = () => {},
): void {
  let previous = "";
  let selectedId: number | undefined;
  let busy = false;
  const render = async (text: string) => {
    if (text === previous) return;
    previous = text;
    try {
      await show(text);
    } catch {
      /* Overlay availability never affects the thread. */
    }
  };
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const id = selected();
      if (id !== selectedId) {
        selectedId = id;
        showIncoming("");
        await render("");
      }
      if (id === undefined) return;
      const state = (await read(id)) as {
        reply?: Partial<Snapshot>;
        incoming?: { from: number; text: string; at: number }[];
      } | null;
      if (selected() !== id) {
        showIncoming("");
        return;
      }
      const now = Date.now();
      showIncoming((state?.incoming ?? [])
        .filter(draft => draft.at <= now && now - draft.at < 15_000)
        .map(draft => `Fork ${draft.from} écrit… ${draft.text}`).join("\n"));
      const raw = state?.reply;
      if (
        selected() !== id ||
        typeof raw?.at !== "number" ||
        typeof raw.turn !== "string" ||
        typeof raw.text !== "string" ||
        raw.at > Date.now() ||
        Date.now() - raw.at > 4_000
      ) {
        await render("");
        return;
      }
      const lines = raw.text.trim().split(/\s+/u).join(" ");
      const tail = lines.length > 210 ? lines.slice(-210).replace(/^\S*\s/u, "") : lines;
      await render(tail ? `Fork ${id} · ${tail}` : "");
    } catch {
      showIncoming("");
      await render("");
    } finally {
      busy = false;
    }
  };
  setInterval(() => void refresh(), 300);
}
