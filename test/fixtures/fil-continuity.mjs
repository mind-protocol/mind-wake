// Isolated crash/recovery fixture. No model, network, credentials or real Wake process.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { enqueueOwnerMessage } from "../../src/communication/owner-inbox.ts";
import { withFilResume } from "../../src/communication/fil-continuity.ts";
const [mode, dir] = process.argv.slice(2);
if (mode === "submit") {
  enqueueOwnerMessage(dir, {
    id: "process-message-1",
    at: "2026-10-30T12:00:00Z",
    text: "Message sauvegardé avant interruption",
  });
} else if (mode === "submit-batch") {
  const prefix = process.argv[4];
  for (let i = 0; i < 12; i++)
    enqueueOwnerMessage(dir, {
      id: `${prefix}-${i}`,
      at: new Date(1803902400000 + i).toISOString(),
      text: `${prefix} message ${i}`,
    });
} else if (mode === "interrupt") {
  const db = new Database(path.join(dir, "owner-inbox.sqlite"));
  db.prepare("INSERT INTO inbox(id,at,text) VALUES(?,?,?)").run(
    "process-message-2",
    "2026-10-30T12:01:00Z",
    "Soumission durable, export interrompu",
  );
  db.close();
  process.exit(19);
} else if (mode === "new-thread") {
  // No saved provider thread ID or native state is supplied to this new process.
  process.stdout.write(
    withFilResume(dir, path.join(dir, "workspace"), "CURRENT AUTHORIZATIONS AND STOP CONTROLS"),
  );
} else throw Error("Unknown fixture mode");
