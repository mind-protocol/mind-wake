/**
 * @handles postés par Marco sur Telegram (NLR, 16 nov. 2026 18:04 : « si toi tu postes des
 * handles, ça les appelle aussi, comme ça tu peux appeler VOX directement dans le chat » ;
 * 18:05 : « pareil pour tous les autres handles »).
 *
 * Un message de Marco à NLR par telegram_send_owner (journal `channel_outgoing`, canal `owner`,
 * statut `sent`) qui commence par des @handles est routé comme un message de NLR : notice
 * « Marco (Telegram, devant NLR) » dans la room (tour unique si elle est désactivée, plafond de
 * la room compris), réponse renvoyée sur Telegram. Holder du fil principal : message au fil
 * principal qui le mentionne.
 *
 * Gardes : seuls les envois de Marco comptent, jamais les réponses renvoyées par les rooms ou
 * les holders (clés `room<n>-reply-…`, `holder-…`) ni les messages du groupe public ; un
 * déclenchement par message ; 10 par heure et par room au plus ; l'historique antérieur au
 * premier passage ne déclenche rien.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { MARCO_TELEGRAM_LABEL, routeTelegramHandle, telegramHandleTable } from "./telegram-handle-route.js";
import { OwnerMessages } from "./owner-messages.js";

export const MARCO_ROUTES_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;
const MAIN_HANDLES = ["marco", "principal"];
/** Clés des envois qui ne viennent pas de Marco : réponses renvoyées par les rooms et les holders. */
const RELAYED_KEY = /^owner:(room\d+-reply-|holder-)/;
/** Marque du message déposé au fil principal pour un holder appelé par Marco sur Telegram. */
export const MARCO_HOLDER_MARK = `[${MARCO_TELEGRAM_LABEL}]`;

/** `@handle` consécutifs en tête, sans doublon (même règle que le bridge). */
export function leadHandles(text: string): string[] {
  const handles: string[] = [];
  const re = /^[\s,]*@([A-Za-z0-9][A-Za-z0-9_.-]*)/;
  let rest = text;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const handle = (m[1] ?? "").replace(/[.-]+$/, "").toLowerCase();
    if (!handles.includes(handle)) handles.push(handle);
    rest = rest.slice(m[0].length);
  }
  return handles;
}

export interface MarcoRouteResult {
  readonly key: string;
  readonly handle: string;
  readonly status: string;
}

/** Un passage : route les nouveaux envois de Marco qui commencent par des @handles. */
export function routeMarcoHandles(
  dataDir: string,
  options: { log?: (line: string) => void; now?: () => number; table?: ReturnType<typeof telegramHandleTable> } = {},
): MarcoRouteResult[] {
  const now = options.now ?? Date.now;
  const db = new Database(path.join(dataDir, "telegram.sqlite"));
  const out: MarcoRouteResult[] = [];
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS channel_outgoing(key TEXT PRIMARY KEY,channel TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT); CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS marco_routes(key TEXT PRIMARY KEY,at TEXT NOT NULL,handles TEXT NOT NULL,rooms TEXT NOT NULL,status TEXT NOT NULL);",
    );
    let since = (db.prepare("SELECT value FROM state WHERE key='marcoRoutesSince'").get() as { value?: string } | undefined)?.value;
    if (since === undefined) {
      since = new Date(now()).toISOString();
      db.prepare("INSERT OR REPLACE INTO state VALUES('marcoRoutesSince',?)").run(since);
      return out;
    }
    const rows = db
      .prepare(
        "SELECT o.key,o.text,o.at FROM channel_outgoing o WHERE o.channel='owner' AND o.status='sent' AND o.at>=? AND NOT EXISTS(SELECT 1 FROM marco_routes r WHERE r.key=o.key) ORDER BY o.at LIMIT 20",
      )
      .all(since) as { key: string; text: string; at: string }[];
    for (const row of rows) {
      const handles = RELAYED_KEY.test(row.key) ? [] : leadHandles(row.text).filter((h) => !MAIN_HANDLES.includes(h));
      // Réservé avant toute remise : un déclenchement par message, même après une panne.
      db.prepare("INSERT OR IGNORE INTO marco_routes VALUES(?,?,?,?,?)").run(row.key, new Date(now()).toISOString(), JSON.stringify(handles), "[]", handles.length === 0 ? "none" : "routing");
      if (handles.length === 0) continue;
      const table = options.table ?? telegramHandleTable(dataDir);
      const rooms: number[] = [];
      for (const handle of handles) {
        const target = table.get(handle);
        let status: string;
        if (target === undefined) status = "unknown";
        else if (target.holder !== undefined) {
          const messages = new OwnerMessages(dataDir, "claude-wake");
          try {
            messages.publish(`${MARCO_HOLDER_MARK} ${handle === target.holder ? "" : `@${target.holder} `}${row.text}`.slice(0, 4000), `telegram-marco:${row.key}:${target.holder}`.slice(0, 200));
            status = "main";
          } finally {
            messages.close();
          }
        } else {
          const hourAgo = new Date(now() - HOUR_MS).toISOString();
          const recent = (db.prepare("SELECT rooms FROM marco_routes WHERE at>=? AND status='routed'").all(hourAgo) as { rooms: string }[])
            .flatMap((r) => JSON.parse(r.rooms) as number[])
            .filter((r) => r === target.room).length;
          if (recent >= MARCO_ROUTES_PER_HOUR) status = "hourly_cap";
          else {
            try {
              routeTelegramHandle(dataDir, handle, row.text, row.key, table, "marco");
              rooms.push(target.room);
              status = "routed";
            } catch (error) {
              status = `failed: ${String(error).slice(0, 200)}`;
            }
          }
        }
        options.log?.(`Marco → @${handle} : ${status}`);
        out.push({ key: row.key, handle, status });
      }
      db.prepare("UPDATE marco_routes SET rooms=?,status=? WHERE key=?").run(JSON.stringify(rooms), rooms.length > 0 ? "routed" : "done", row.key);
    }
  } finally {
    db.close();
  }
  return out;
}
