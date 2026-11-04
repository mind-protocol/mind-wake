// Run locally with the bot token in .local/telegram-setup.json; never log it.
import fs from "node:fs";
import path from "node:path";
import { TelegramApi } from "../services/telegram/bridge.mjs";
const source = JSON.parse(fs.readFileSync(".local/telegram-setup.json", "utf8"));
const api = new TelegramApi(source.botToken);
try {
  const me = await api.call("getMe");
  const chat = await api.call("getChat", { chat_id: source.ownerId });
  if (
    chat.type !== "private" ||
    chat.username?.toLowerCase() !== source.ownerUsername.toLowerCase()
  )
    throw Error("Destinataire différent");
  const file = path.join(source.dataDir, "telegram.json");
  const { dataDir, ...config } = source;
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ bot: me.username, owner: chat.username, chatId: chat.id, configFile: file }),
  );
} catch {
  console.error(
    "Configuration Telegram non installée : vérifier réseau, bot et conversation privée initialisée.",
  );
  process.exitCode = 1;
}
