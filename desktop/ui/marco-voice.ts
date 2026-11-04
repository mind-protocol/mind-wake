interface Message {
  from: string;
  text: string;
  id?: string;
  at: string;
}
/** Read only fresh principal replies while Voice is enabled; never replay the backlog. */
export function marcoVoice(options: {
  read(text: string): Promise<void>;
  cancel(): void;
  speaking(active: boolean): void;
  error(message: string): void;
}) {
  const seen = new Set<string>();
  let enabled = false,
    initialized = false,
    reading = false,
    epoch = 0;
  const queue: string[] = [];
  const pump = (): void => {
    if (!enabled || reading || !queue.length) return;
    const text = queue.shift()!;
    const current = epoch;
    reading = true;
    options.speaking(true);
    void options
      .read(text)
      .catch((error) => {
        if (current === epoch)
          options.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current !== epoch) return;
        reading = false;
        options.speaking(false);
        pump();
      });
  };
  return {
    setEnabled(value: boolean): void {
      if (enabled === value) return;
      enabled = value;
      if (!enabled) {
        epoch++;
        queue.length = 0;
        reading = false;
        options.cancel();
        options.speaking(false);
      } else pump();
    },
    observe(items: readonly Message[]): void {
      for (const item of items) {
        if (item.from !== "agent" || !item.text.trim()) continue;
        const key = `${item.id ?? item.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (initialized && enabled) queue.push(item.text);
      }
      initialized = true;
      pump();
    },
  };
}
