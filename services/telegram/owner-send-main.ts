/**
 * Envoi d'un texte à NLR par le bot, pour le worker des rooms (src/ ne peut pas importer
 * services/). Même chemin que l'outil telegram_send_owner (`TelegramOwner.send_`) : journal
 * `channel_outgoing` (canal `owner`), clé d'idempotence, et donc le vocal qui suit chaque envoi.
 * Entrée : JSON `{ text, idempotency_key, image_path?, workspace? }` sur stdin (voir
 * owner-send-input.ts), `MIND_WAKE_DATA_DIR` dans l'environnement.
 * Sortie : une ligne JSON `{ ok, message_id }` ou `{ ok: false, code, message }`.
 */
import { TelegramOwner } from "../mcp/telegram-tools.js";
import { parseOwnerSendInput } from "./owner-send-input.js";

async function main(): Promise<void> {
  const dataDir = process.env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) throw Object.assign(new Error("MIND_WAKE_DATA_DIR requis."), { code: "invalid_input" });
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  const input = parseOwnerSendInput(raw);
  const workspace = input.workspace;
  const owner = workspace === undefined ? new TelegramOwner(dataDir) : new TelegramOwner(dataDir, undefined, undefined, () => workspace);
  const r = await owner.send_(input.send);
  process.stdout.write(JSON.stringify({ ok: true, message_id: r.message_id }) + "\n");
}

main().catch((error: unknown) => {
  const code = (error as { code?: unknown }).code;
  process.stdout.write(
    JSON.stringify({ ok: false, code: typeof code === "string" ? code : "error", message: error instanceof Error ? error.message : String(error) }) + "\n",
  );
  process.exitCode = 1;
});
