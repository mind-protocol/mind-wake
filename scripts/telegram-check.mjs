import fs from "node:fs";
import { TelegramApi } from "../services/telegram/bridge.mjs";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const api = new TelegramApi(config.botToken);
try {
  const hook = await api.call("getWebhookInfo");
  if (hook.url) throw Error("Webhook existant : libérer ce bot avant le polling");
  const text = await api.call("sendMessage", {
    chat_id: config.ownerId,
    text: "MIND Wake connecté : tes textes et vocaux arrivent à ton agent. Les nouveaux messages du fil sont relayés ici en texte et en audio.",
  });
  const voice = await api.sendVoice(
    config.ownerId,
    fs.readFileSync(".local/telegram/voice-check.ogg"),
  );
  console.log(
    JSON.stringify({
      textMessageId: text.message_id,
      voiceMessageId: voice.message_id,
      chatId: config.ownerId,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
