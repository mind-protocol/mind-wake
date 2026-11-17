/** Pont desktop des réglages « Telegram — mon compte » : une requête JSON sur stdin, une réponse sur stdout. */
import { resolveDataDir } from "../../src/cli/paths.js";
import { processContext } from "../../src/cli/context.js";
import { pythonUserSidecar } from "../mcp/telegram-user-tools.js";
import { runTelegramUserSettings, TelegramUserSettings } from "./user-account-settings.js";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 4096) break;
}
const dataDir = resolveDataDir(processContext(), undefined).path;
const result = await runTelegramUserSettings(input, new TelegramUserSettings(dataDir, pythonUserSidecar(dataDir, process.env, 60_000)));
process.stdout.write(result.stdout + "\n");
process.exitCode = result.exitCode;
