import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { buildSnapshot } from "./read-model.mjs";

const root = fs.mkdtempSync(path.join(import.meta.dirname, "fixture-"));
const write = (file, value) => {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
const sql = (file, body) => {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.exec(body);
  db.close();
};
const hash = () => {
  const result = {};
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else
        result[path.relative(root, p)] = createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
    }
  };
  visit(root);
  return result;
};
const t0 = "2026-11-05T10:00:00Z",
  t1 = "2026-11-05T11:00:00Z";
write("forks/2/enabled.json", { enabled: true });
sql(
  "forks/2/second-thread.sqlite",
  `CREATE TABLE state(key,value);INSERT INTO state VALUES('threadId','f2');CREATE TABLE turns(n,started_at,ended_at,outcome);INSERT INTO turns VALUES(1,'${t1}',NULL,NULL);CREATE TABLE entries(id,at,role,text,delivered);INSERT INTO entries VALUES(1,'${t1}','human','{senderRef:evil,to:fork8}',0);`,
);
write("codex-threads/thread-ab.json", { threadId: "main", updatedAt: t1 });
sql(
  "recipient-route.sqlite",
  `CREATE TABLE entries(json);INSERT INTO entries VALUES('${JSON.stringify({ id: "interfork", senderRef: "f2", recipientRef: "main", state: "remote_stored", at: t1, text: "synthétique", messageId: "correlation" })}');`,
);
sql(
  "background-jobs.sqlite",
  `CREATE TABLE jobs(payload);INSERT INTO jobs VALUES('${JSON.stringify({ id: "running", title: "Fork8 misleading title", status: "running", startedAt: t1 })}'),('${JSON.stringify({ id: "done", status: "succeeded", endedAt: t1 })}');`,
);
const clip = "00000000-0000-0000-0000-000000000001";
write(`elevenlabs-audio/${clip}.clip`, {
  id: clip,
  text: "synthetic audio",
  agentRef: "f2",
  threadId: "fil2",
  createdAt: t1,
});
write(
  "elevenlabs-audio/playback.jsonl",
  JSON.stringify({ id: clip, phase: "queued", at: t1 }) + "\n",
);
const meta = (id, parent) => ({
  type: "session_meta",
  payload: { id, timestamp: t1, parent_thread_id: parent },
});
const message = (text, at) => ({
  type: "response_item",
  timestamp: at,
  payload: {
    type: "message",
    role: "assistant",
    channel: "final",
    content: [{ type: "output_text", text }],
  },
});
write(
  "native/sessions/f2.jsonl",
  [meta("f2"), message("inherited", t0), message("current", t1)]
    .map(JSON.stringify)
    .join("\n"),
);
write(
  "native/sessions/child.jsonl",
  [
    meta("child", "f2"),
    message("parent-history", t0),
    message("child-only", t1),
  ]
    .map(JSON.stringify)
    .join("\n"),
);
write(
  "native/sessions/unrelated.jsonl",
  [meta("unrelated"), message("wrong recipient", t1)]
    .map(JSON.stringify)
    .join("\n"),
);
const read = () =>
  buildSnapshot({
    dataDir: root,
    codexHome: path.join(root, "native"),
    now: t1,
  });
test("read-only projection, identities, jobs and no false audio completion", () => {
  const before = hash(),
    g = read();
  assert.deepEqual(hash(), before);
  assert.equal(g.tabs.length, 8);
  const route = g.messages.find((x) => x.id === "route:interfork");
  assert.equal(route.from, "fork2");
  assert.equal(route.to, "principal");
  assert.equal(route.correlationId, "correlation");
  assert.match(route.state, /transport accepté/);
  const input = g.messages.find((x) => x.id === "fork2:entry:1");
  assert.equal(input.from, "unknown:entry-origin:fork2");
  assert.equal(input.to, "fork2");
  assert.equal(input.state, "queued");
  assert.equal(g.nodes.find((x) => x.id === "fork2").activity, "inconnu");
  assert.equal(
    g.nodes.find((x) => x.id === "job:running").activity,
    "travaille",
  );
  assert.notEqual(
    g.nodes.find((x) => x.id === "job:done").activity,
    "travaille",
  );
  assert.equal(g.nodes.find((x) => x.id === "job:running").tab, null);
  assert.equal(
    g.messages.find((x) => x.id === `audio:${clip}`).state,
    "lecture en file",
  );
  assert.ok(
    !g.messages.some((x) =>
      ["inherited", "parent-history", "wrong recipient"].includes(x.text),
    ),
  );
  assert.equal(
    g.messages.find((x) => x.text === "child-only").from,
    "session:child",
  );
  assert.ok(g.sources.some((x) => x.state === "indisponible"));
});
test("transitions retain stable ids, missing identities explicit, no time-based success", () => {
  const g = read(),
    id = `audio:${clip}`;
  write(
    "elevenlabs-audio/playback.jsonl",
    JSON.stringify({ id: clip, phase: "ended", at: t1 }) + "\n",
  );
  const next = read().messages.find((x) => x.id === id);
  assert.equal(next.id, g.messages.find((x) => x.id === id).id);
  assert.match(next.state, /accusé lecteur.*entendu inconnu/);
  assert.ok(g.nodes.some((x) => x.id === "unknown:assistant-audience"));
  const future = buildSnapshot({
    dataDir: root,
    codexHome: path.join(root, "native"),
    now: "2030-01-01T00:00:00Z",
  });
  assert.equal(future.nodes.find((x) => x.id === "fork2").activity, "inconnu");
});
test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
