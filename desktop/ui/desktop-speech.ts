interface Message {
  from: string;
  text: string;
  id?: string;
  at: string;
  source?: string;
  edited?: boolean;
  threadId?: string;
  agentRef?:string;
  cycleId?:string;
}
/** Observe live principal replies only. Both first load and older pagination are silent. */
export function desktopSpeech(options: {
  speak(
    text: string,
    key: string,
    metadata?: { threadId: string;agentRef?:string;cycleId?:string },
  ): Promise<unknown>;
  error(note: string): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const since = now();
  const seen = new Set<string>();
  let initialized = false;
  let reading = false;
  const queue: Message[] = [];
  async function pump(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (queue.length) {
        const item = queue.shift()!;
        try {
          if (item.threadId)
            await options.speak(item.text, `reply:${item.id ?? item.at}`, {
              threadId: item.threadId,
              ...(item.agentRef?{agentRef:item.agentRef}:{}),
              ...(item.cycleId?{cycleId:item.cycleId}:{}),
            });
          else await options.speak(item.text, `reply:${item.id ?? item.at}`);
        } catch (error) {
          options.error(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      reading = false;
    }
  }
  return {
    observe(
      items: readonly Message[],
      mode: "live" | "history" = "live",
    ): void {
      for (const item of items) {
        if (item.from !== "agent" || item.source || !item.text.trim()) continue;
        // La réponse rapide ⚡ demande sa voix elle-même dès sa publication (même clé).
        if (item.text.startsWith("⚡ ")) continue;
        const key = item.id ?? item.at;
        if (seen.has(key)) continue;
        seen.add(key);
        // Refuse bursts/backlog rather than spending on an archive. No implicit retry.
        const at = Date.parse(item.at);
        if (
          initialized &&
          mode === "live" &&
          !item.edited &&
          at >= since &&
          at >= now() - 60_000 &&
          at <= now() + 5_000 &&
          queue.length < 3
        )
          queue.push(item);
      }
      initialized = true;
      void pump();
    },
  };
}
