/**
 * Journal des temps du fil principal Claude : pensée (génération du modèle), attente (outils,
 * livraison des messages) et communication (outils du canal, délai de réponse). Lit les
 * sessions Claude Code de l'espace Wake et les files locales, sans rien modifier d'autre que
 * `<données>/runtimes/claude/timing-log.jsonl`, réécrit à chaque passage.
 *
 *   node scripts/timing-log.mjs [--data-dir DIR] [--workspace DIR] [--hours 24]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";

const { values } = parseArgs({
  options: { "data-dir": { type: "string" }, workspace: { type: "string" }, hours: { type: "string" } },
});
const dataDir =
  values["data-dir"] ?? process.env.MIND_WAKE_DATA_DIR ?? path.join(os.homedir(), "AppData/Local/mind-wake-essai");
const workspace = values.workspace ?? path.join(dataDir, "workspace");
const hours = Number(values.hours ?? 24);
const since = Date.now() - hours * 3_600_000;
const COMM_TOOLS = /^mcp__mind__(message_owner|edit_owner_message|delete_owner_message|list_owner_messages|message_peer|reply_peer|send_.*)$/;

/** Dossier des sessions Claude Code pour un dossier de travail donné. */
const projectDir = path.join(os.homedir(), ".claude", "projects", path.resolve(workspace).replace(/[^A-Za-z0-9]/g, "-"));
const entries = [];
const add = (kind, start, end, detail, session) => {
  const s = Date.parse(start), e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s || e < since) return;
  entries.push({ kind, at: new Date(s).toISOString(), end: new Date(e).toISOString(), ms: e - s, detail, session });
};

for (const name of fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : []) {
  const file = path.join(projectDir, name);
  if (!name.endsWith(".jsonl") || fs.statSync(file).mtimeMs < since) continue;
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const j = JSON.parse(l);
        return j && typeof j.timestamp === "string" && j.isSidechain !== true ? [j] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const session = name.replace(/\.jsonl$/, "");
  const toolStart = new Map();
  let lastInput = null; // fin du dernier résultat d'outil ou message utilisateur
  const requests = new Map(); // requestId -> {start, end, thinkingMs}
  for (const l of lines) {
    const content = Array.isArray(l.message?.content) ? l.message.content : [];
    if (l.type === "assistant") {
      if (l.requestId) {
        const r = requests.get(l.requestId) ?? { start: lastInput, end: l.timestamp, thinkingMs: 0 };
        r.end = l.timestamp;
        r.thinkingMs += Number(l.thinkingDurationMs ?? 0);
        requests.set(l.requestId, r);
      }
      for (const c of content) if (c.type === "tool_use") toolStart.set(c.id, { at: l.timestamp, name: c.name });
    } else if (l.type === "user") {
      for (const c of content)
        if (c.type === "tool_result" && toolStart.has(c.tool_use_id)) {
          const t = toolStart.get(c.tool_use_id);
          toolStart.delete(c.tool_use_id);
          add(COMM_TOOLS.test(t.name) ? "comm" : "attente", t.at, l.timestamp, `outil ${t.name}`, session);
        }
      lastInput = l.timestamp;
    }
  }
  for (const [id, r] of requests)
    if (r.start) add("pensée", r.start, r.end, `requête modèle ${id.slice(0, 16)}${r.thinkingMs ? `, réflexion ${r.thinkingMs} ms` : ""}`, session);
  // Outils restés sans résultat : attente encore ouverte au moment du journal.
  for (const t of toolStart.values()) add("attente", t.at, new Date().toISOString(), `outil ${t.name} (sans résultat)`, session);
}

const open = (file) => (fs.existsSync(path.join(dataDir, file)) ? new Database(path.join(dataDir, file), { readonly: true }) : null);
const inbox = open("owner-inbox.sqlite");
const published = [];
const outbox = open("owner-messages.sqlite");
if (outbox) {
  for (const r of outbox.prepare("SELECT created_at FROM messages ORDER BY created_at").all()) published.push(Date.parse(r.created_at));
  outbox.close();
}
if (inbox) {
  for (const r of inbox.prepare("SELECT id, at, emitted_at FROM inbox ORDER BY at").all()) {
    const from = r.id.startsWith("ui-") || r.id.startsWith("latency-") ? "humain" : `agent/canal ${r.id.split(/[:-]/)[0]}`;
    if (r.emitted_at) add("attente", r.at, r.emitted_at, `livraison d'un message (${from})`, null);
    if (from === "humain") {
      const reply = published.find((t) => t > Date.parse(r.at));
      if (reply) add("comm", r.at, new Date(reply).toISOString(), "délai de réponse au message humain", null);
    }
  }
  inbox.close();
}

entries.sort((a, b) => (a.at < b.at ? -1 : 1));
const out = path.join(dataDir, "runtimes", "claude", "timing-log.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));

const fmt = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const groups = new Map();
for (const e of entries) {
  const key = `${e.kind} · ${e.detail.replace(/ \(.*\)$|requête modèle .*/, (m) => (m.startsWith("requête") ? "requêtes modèle" : ""))}`;
  const g = groups.get(key) ?? [];
  g.push(e.ms);
  groups.set(key, g);
}
console.log(`Journal : ${out} (${entries.length} entrées, ${hours} h)`);
console.log("catégorie".padEnd(62), "n".padStart(5), "total".padStart(9), "médiane".padStart(9), "max".padStart(9));
for (const [key, ms] of [...groups].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, 25)) {
  ms.sort((a, b) => a - b);
  console.log(key.slice(0, 62).padEnd(62), String(ms.length).padStart(5), fmt(ms.reduce((x, y) => x + y, 0)).padStart(9), fmt(ms[Math.floor(ms.length / 2)]).padStart(9), fmt(ms.at(-1)).padStart(9));
}
const total = (k) => entries.filter((e) => e.kind === k).reduce((x, e) => x + e.ms, 0);
console.log(`\nTotaux : pensée ${fmt(total("pensée"))} · attente ${fmt(total("attente"))} · comm ${fmt(total("comm"))}`);
