#!/usr/bin/env node
/**
 * Ajoute un rappel martelé : node scripts/add-wake-reminder.mjs <dataDir> <every> <hours> <text> [source]
 * Même format que src/daemon/wake-reminders.ts (`<dataDir>/wake-reminders.json`).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [dataDir, everyArg, hoursArg, text, source = "cli"] = process.argv.slice(2);
const every = Number(everyArg), hours = Number(hoursArg);
if (!dataDir || !Number.isInteger(every) || every < 1 || !(hours > 0) || !text?.trim()) {
  console.error("usage: add-wake-reminder.mjs <dataDir> <every≥1> <hours>0> <text> [source]");
  process.exit(2);
}
const file = path.join(dataDir, "wake-reminders.json");
let store = { lastWake: null, reminders: [] };
if (fs.existsSync(file)) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    store = Array.isArray(raw) ? { lastWake: null, reminders: raw } : { lastWake: raw.lastWake ?? null, reminders: raw.reminders ?? [] };
  } catch {
    console.error(`${file} illisible : corrigez-le avant d'ajouter un rappel`);
    process.exit(1);
  }
}
const now = new Date();
const reminder = {
  id: `rappel-${randomUUID().slice(0, 8)}`,
  text: text.trim(),
  every,
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
  source,
  startWake: Number.isInteger(store.lastWake) ? store.lastWake + 1 : null,
};
store.reminders.push(reminder);
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
fs.renameSync(tmp, file);
console.log(JSON.stringify(reminder, null, 2));
