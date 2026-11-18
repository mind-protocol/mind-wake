import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const CALL_TARGET =
  /^(?:@?[a-z0-9][a-z0-9_.-]{0,60}|⬡[a-z0-9][a-z0-9-]{1,30}(?:\/[a-z0-9][a-z0-9_.-]{0,60})?)$/;
export function openCallRequests(dir, { now = Date.now } = {}) {
  const db = new DatabaseSync(path.join(dir, "mobile-call-control.sqlite"));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS call_dial_requests(
      id TEXT PRIMARY KEY, caller TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
      at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', result TEXT);`);
  const view = (r) =>
    r ? { request: r.id, state: r.state, ...JSON.parse(r.result ?? "{}") } : null;
  const expire = () =>
    db
      .prepare(
        "UPDATE call_dial_requests SET state='settled',result=? WHERE state IN ('pending','processing') AND at<?",
      )
      .run(JSON.stringify({ status: "expired" }), now() - 60_000);
  return {
    close: () => db.close(),
    enqueue(input) {
      const targets = Array.isArray(input.target) ? input.target : [input.target];
      if (
        !targets.length ||
        targets.length > 32 ||
        !targets.every((t) => typeof t === "string" && CALL_TARGET.test(t)) ||
        !/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(input.caller)
      )
        throw Error("call_target_invalid");
      expire();
      const payload = JSON.stringify(input);
      const old = db
        .prepare(
          "SELECT * FROM call_dial_requests WHERE caller=? AND payload=? AND state IN ('pending','processing') LIMIT 1",
        )
        .get(input.caller, payload);
      if (old) return view(old);
      const id = randomUUID();
      db.prepare(
        "INSERT INTO call_dial_requests(id,caller,target,payload,at) VALUES(?,?,?,?,?)",
      ).run(id, input.caller, JSON.stringify(input.target), payload, now());
      return { request: id, state: "pending" };
    },
    pending() {
      expire();
      return db
        .prepare(
          "SELECT id,payload FROM call_dial_requests WHERE state='pending' ORDER BY at LIMIT 20",
        )
        .all()
        .map((r) => ({ request: r.id, ...JSON.parse(r.payload) }));
    },
    claim() {
      expire();
      const r = db
        .prepare(
          "UPDATE call_dial_requests SET state='processing' WHERE id=(SELECT id FROM call_dial_requests WHERE state='pending' ORDER BY at LIMIT 1) AND state='pending' RETURNING id,payload",
        )
        .get();
      return r ? { request: r.id, ...JSON.parse(r.payload) } : null;
    },
    settle(id, result) {
      db.prepare(
        "UPDATE call_dial_requests SET state='settled',result=? WHERE id=? AND state IN ('pending','processing')",
      ).run(JSON.stringify(result), id);
    },
    get(id, caller) {
      expire();
      return view(
        db.prepare("SELECT * FROM call_dial_requests WHERE id=? AND caller=?").get(id, caller),
      );
    },
  };
}
