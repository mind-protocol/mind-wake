interface Envelope {
  ok?: unknown;
  data?: Record<string, unknown>;
  error?: { message?: unknown };
}
/** Invokes the same fixed Tauri API used by the form. Failed sends keep draft/key. */
export function recipientSender(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<Envelope>,
  key: () => string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  let pending: { key: string; text: string } | null = null,
    busy = false;
  try {
    const value = JSON.parse(storage?.getItem("mind-wake.recipient-pending") ?? "null") as {
      key?: unknown;
      text?: unknown;
    } | null;
    if (
      typeof value?.key === "string" &&
      /^[A-Za-z0-9_.:-]{8,128}$/.test(value.key) &&
      typeof value.text === "string" &&
      value.text.length <= 4000
    )
      pending = { key: value.key, text: value.text };
  } catch {
    /* Storage is optional; never block an explicit send. */
  }
  return async (field: { value: string; focus(): void }): Promise<string> => {
    const text = field.value.trim();
    if (!text || busy) return "";
    busy = true;
    if (pending?.text !== text) pending = { key: key(), text };
    try {
      storage?.setItem("mind-wake.recipient-pending", JSON.stringify(pending));
    } catch {
      /* Optional local recovery. */
    }
    try {
      const result = await invoke("recipient_send", { idempotencyKey: pending.key, text });
      if (result.ok !== true || result.data?.["state"] !== "remote_stored")
        throw Error(
          typeof result.error?.message === "string"
            ? result.error.message
            : "Envoi non confirmé. Brouillon conservé.",
        );
      if (field.value.trim() === text) field.value = "";
      field.focus();
      pending = null;
      try {
        storage?.removeItem("mind-wake.recipient-pending");
      } catch {
        /* Send is already confirmed. */
      }
      return "Stocké sur le hub pour Auroracle ; réception et lecture non attestées. Copie de contexte conservée pour Marco.";
    } finally {
      busy = false;
    }
  };
}
