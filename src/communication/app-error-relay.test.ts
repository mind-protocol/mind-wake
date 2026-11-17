import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openRepairQueue, redactSecrets, relayAppError, validateAppErrorReport } from "./app-error-relay.js";
import { ownerMessagePending, readOwnerInboxHistory } from "./owner-inbox.js";
import { RepairAgent } from "../daemon/repair-agent.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-error-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const now = () => Date.parse("2026-11-17T14:50:00Z");

it("groups call retries across CLI invocations and wakes only Réparateur", async () => {
  for (let i = 0; i < 30; i++) relayAppError(dir, {
    app: "desktop", screen: "Appel", text: `Écran indisponible [iframe appel : src posé il y a ${i} s]`,
  }, now);
  relayAppError(dir, { app: "mobile", screen: "chat", text: "connexion perdue" }, now);
  expect(readOwnerInboxHistory(dir)).toEqual([]);
  expect(ownerMessagePending(dir)).toBe(false);
  let turns = 0;
  let allowed = false;
  const agent = new RepairAgent(dir, () => allowed, () => {}, async input => {
    turns++;
    expect(input.promptFile).toContain("agent-reparateur.md");
    expect(JSON.parse(input.message).map((row: { occurrences: number }) => row.occurrences)).toEqual([30, 1]);
    return { outcome: "completed", text: "diagnostic", sessionConfirmed: true, tokens: 0, retryAtMs: null, detail: null };
  });
  await agent.processBatch();
  expect(turns).toBe(0);
  allowed = true;
  await agent.processBatch();
  relayAppError(dir, { app: "mobile", screen: "chat", text: "connexion perdue" }, now);
  await agent.processBatch();
  expect(turns).toBe(1);
});

it("never forwards secrets or unexpected fields", () => {
  const token = "a".repeat(16) + "0123456789abcdef".repeat(3);
  const text = [
    `GET /chat/messages Authorization: Bearer ${token}`,
    "http://user:hunter2@127.0.0.1:8789/x?token=abcd1234efgh&cursor=1",
    'payload {"api_key":"sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV","password": "p4ssw0rd!"}',
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ",
    "telegram api_hash=0123456789abcdef0123456789abcdef",
  ].join("\n");
  const report = validateAppErrorReport({ app: "desktop", screen: "s", text }, now);
  for (const secret of [token, "hunter2", "abcd1234efgh", "sk-ant-api03", "p4ssw0rd", "eyJhbGci", "AAHdqTcv", "0123456789abcdef0123"])
    expect(report.text).not.toContain(secret);
  expect(report.text).toContain("[masqué]");
  expect(() => validateAppErrorReport({ app: "desktop", text: "x", token }, now)).toThrow("invalid_app_error");
  expect(() => validateAppErrorReport({ app: "server", text: "x" }, now)).toThrow("invalid_app_error");
  expect(() => validateAppErrorReport({ app: "mobile", text: "  " }, now)).toThrow("invalid_app_error");
});

it("keeps ordinary diagnostics readable", () => {
  const plain = "Lecture impossible : wake_unavailable (http://192.168.1.20:8789) — C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/alignment-proxy229";
  expect(redactSecrets(plain)).toBe(plain);
  expect(redactSecrets("Session expirée : reconnecte cet appareil")).toBe("Session expirée : reconnecte cet appareil");
  const long = validateAppErrorReport({ app: "mobile", text: "x".repeat(5000) }, now);
  expect(long.text.length).toBeLessThanOrEqual(1000);
  expect(long.at).toBe("2026-11-17T14:50:00.000Z");
  expect(long.screen).toBe("inconnu");
});

it("CLI `app-error` (desktop path) reads stdin JSON and relays it", async () => {
  const { seedSimulatedProfile } = await import("../../test/demo/harness.js");
  const { processContext } = await import("../cli/context.js");
  const { runCli } = await import("../cli/run.js");
  seedSimulatedProfile(dir, { runtimeAdapterId: "codex", hostUnsandboxed: true, runtime: { nativeCapabilities: true } });
  const out: string[] = [];
  const input = JSON.stringify({ app: "desktop", screen: "Appel", text: "invoke wake_reply: Bearer 0123456789abcdef0123456789abcdef", at: "2026-11-17T14:50:00Z" });
  const code = await runCli(["app-error", "--data-dir", dir, "--json"], {
    ...processContext(), stdout: (s) => out.push(s), stderr: () => {}, readStdin: async () => input,
  });
  expect(code).toBe(0);
  expect(JSON.parse(out.join("")).data).toMatchObject({ app: "desktop", screen: "Appel" });
  const db = openRepairQueue(dir);
  try {
    const stored = db.prepare("SELECT report FROM incidents").get() as {report: string};
    expect(stored.report).toContain("[masqué]");
    expect(stored.report).not.toContain("0123456789abcdef0123");
  } finally { db.close(); }
  expect(readOwnerInboxHistory(dir)).toEqual([]);
});
