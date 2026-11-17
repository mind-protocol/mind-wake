/**
 * Sous-processus du pont Telegram : texte sur stdin → MP3 ElevenLabs dans le fichier donné en
 * argument. La clé reste lue par `ElevenLabs` (elevenlabs.json du profil) ; rien n'est affiché
 * d'autre qu'un message d'erreur court et expurgé.
 */
import fs from "node:fs";
import { ElevenLabs } from "./service.js";
import { resolveDataDir } from "../../src/cli/paths.js";
import { processContext } from "../../src/cli/context.js";

try {
  const out = process.argv[2];
  if (!out) throw Error("Fichier de sortie manquant.");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 16384) throw Error("Entrée trop longue.");
  }
  const service = new ElevenLabs(resolveDataDir(processContext(), undefined).path);
  const bytes = await service.synthesizeMp3(text, AbortSignal.timeout(60_000));
  fs.writeFileSync(out, bytes, { mode: 0o600 });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replace(/[0-9a-f]{32,}|sk_[A-Za-z0-9]+/g, "[redacted]").slice(0, 200)}\n`);
  process.exitCode = 1;
}
