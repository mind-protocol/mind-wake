/**
 * Entrée de owner-send-main.ts : `{ text, idempotency_key, image_path?, workspace? }`. `image_path`
 * part tel quel vers `TelegramOwner.send_` ; `workspace` (workspace de la room qui envoie) remplace
 * le workspace MIND comme racine où le fichier doit se trouver. Sans fichier, le texte est requis.
 */
export interface OwnerSendInput {
  send: { text: string; idempotency_key: string; image_path?: string };
  workspace?: string;
}

export function parseOwnerSendInput(raw: string): OwnerSendInput {
  const input = JSON.parse(raw) as { text?: unknown; idempotency_key?: unknown; image_path?: unknown; workspace?: unknown };
  const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid_input" });
  if (typeof input.text !== "string" || typeof input.idempotency_key !== "string") throw invalid("text et idempotency_key requis.");
  if (input.image_path !== undefined && (typeof input.image_path !== "string" || input.image_path === "")) throw invalid("image_path invalide.");
  if (input.workspace !== undefined && (typeof input.workspace !== "string" || input.workspace === "")) throw invalid("workspace invalide.");
  return {
    send: {
      text: input.text,
      idempotency_key: input.idempotency_key,
      ...(input.image_path === undefined ? {} : { image_path: input.image_path }),
    },
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  };
}
