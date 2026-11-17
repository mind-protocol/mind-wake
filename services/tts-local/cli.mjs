/**
 * Entrée en ligne de commande de la voix locale, pour le desktop (Tauri) et les scripts :
 *   node services/tts-local/cli.mjs voice <agentId>            → JSON de la voix
 *   node services/tts-local/cli.mjs voices                     → JSON de toutes les voix
 *   node services/tts-local/cli.mjs status                     → réglages + santé du serveur
 *   node services/tts-local/cli.mjs synth <agentId> <out.wav> [fr|en]  (texte sur stdin)
 */
import fs from "node:fs";
import { getVoice, listVoices, localTtsConfig, localTtsHealth, synth } from "./client.mjs";

const [command, agent, out, lang] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  if (command === "voice") print(getVoice(agent));
  else if (command === "voices") print(listVoices());
  else if (command === "status") {
    const config = localTtsConfig();
    print({ ...config, health: config.enabled ? await localTtsHealth({ url: config.url }) : null });
  } else if (command === "synth") {
    if (!out) throw Error("fichier de sortie manquant");
    let text = "";
    for await (const chunk of process.stdin) text += String(chunk);
    const result = await synth(agent, text, lang ? { lang } : {});
    fs.writeFileSync(out, result.bytes);
    print({ ok: true, voice: result.voice.id, engine: result.engine, out });
  } else throw Error("commande inconnue (voice | voices | status | synth)");
} catch (error) {
  process.stderr.write(`${String(error?.message ?? error).slice(0, 300)}\n`);
  process.exitCode = 1;
}
