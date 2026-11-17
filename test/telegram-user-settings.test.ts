/** Pont des réglages « Telegram — mon compte » : faux sidecar, aucune connexion ni aucun envoi. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { UserSidecar, UserSidecarResult } from "../services/mcp/telegram-user-tools.js";
import { runTelegramUserSettings, TelegramUserSettings } from "../services/telegram/user-account-settings.js";

let dataDir: string;
let calls: { args: string[]; stdin?: string | undefined }[];
let reply: (args: string[]) => UserSidecarResult;
const fake: UserSidecar = async (args, stdin) => {
  calls.push({ args, stdin });
  return reply(args);
};
const run = async (action: string, payload?: unknown) => {
  const result = await runTelegramUserSettings(JSON.stringify({ action, payload }), new TelegramUserSettings(dataDir, fake));
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as { ok: boolean; data?: any; error?: { code: string; message: string } } };
};
const file = (name: string) => path.join(dataDir, name);
const configure = () => fs.writeFileSync(file("telegram-user.json"), "{}");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-user-settings-"));
  calls = [];
  reply = () => ({ ok: true });
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("reports not configured without running the sidecar", async () => {
  const { body } = await run("status");
  expect(body).toEqual({ ok: true, data: { configured: false, loggedIn: false, account: null, step: null } });
  expect(calls).toEqual([]);
});

it("reports not connected without a session, and asks the sidecar status otherwise", async () => {
  configure();
  expect((await run("status")).body.data).toEqual({ configured: true, loggedIn: false, account: null, step: "phone" });
  expect(calls).toEqual([]);
  fs.writeFileSync(file("telegram-user.session"), "");
  reply = () => ({ ok: true, logged_in: true, account: { id: 7, name: "NLR", username: "@nlr", kind: "user" } });
  expect((await run("status")).body.data).toEqual({ configured: true, loggedIn: true, account: { name: "NLR", username: "@nlr" }, step: null });
  expect(calls).toEqual([{ args: ["status"], stdin: undefined }]);
});

it("writes api_id and api_hash once, never returns them, and refuses to overwrite", async () => {
  const hash = "0123456789ABCDEF0123456789abcdef";
  const first = await run("configure", { apiId: " 123456 ", apiHash: hash });
  expect(first.body.data).toEqual({ configured: true, loggedIn: false, account: null, step: "phone" });
  expect(JSON.stringify(first.body)).not.toContain("123456");
  expect(JSON.parse(fs.readFileSync(file("telegram-user.json"), "utf8"))).toEqual({ api_id: 123456, api_hash: hash.toLowerCase() });
  const second = await run("configure", { apiId: "999", apiHash: hash });
  expect(second.exitCode).toBe(1);
  expect(second.body.error?.code).toBe("already_configured");
  expect(JSON.parse(fs.readFileSync(file("telegram-user.json"), "utf8")).api_id).toBe(123456);
});

it("rejects a malformed api_hash without writing the file", async () => {
  const { body } = await run("configure", { apiId: "123456", apiHash: "nope" });
  expect(body.error?.code).toBe("invalid_input");
  expect(fs.existsSync(file("telegram-user.json"))).toBe(false);
});

it("drives the non-interactive login through stdin, never through arguments", async () => {
  configure();
  reply = (args) =>
    args.includes("--phone") ? { ok: true, logged_in: false, step: "code" }
    : args.includes("--code") ? { ok: true, logged_in: false, step: "password" }
    : { ok: true, logged_in: true, step: "done", account: { name: "NLR", username: null } };
  expect((await run("login_phone", { phone: "+33 6 12 34 56 78" })).body.data.step).toBe("code");
  expect((await run("login_code", { code: "12345" })).body.data.step).toBe("password");
  const done = await run("login_password", { password: "mot de passe" });
  expect(done.body.data).toEqual({ configured: true, loggedIn: true, account: { name: "NLR", username: null }, step: null });
  expect(calls).toEqual([
    { args: ["login", "--phone", "-"], stdin: "+33612345678" },
    { args: ["login", "--code", "-"], stdin: "12345" },
    { args: ["login", "--password", "-"], stdin: "mot de passe" },
  ]);
});

it("passes sidecar errors through and validates input before calling it", async () => {
  configure();
  reply = () => ({ ok: false, error: "code_invalid", message: "Code incorrect.", definite: true });
  const wrong = await run("login_code", { code: "12345" });
  expect(wrong.exitCode).toBe(1);
  expect(wrong.body.error).toEqual({ code: "code_invalid", message: "Code incorrect." });
  calls = [];
  expect((await run("login_phone", { phone: "0612" })).body.error?.code).toBe("invalid_input");
  expect((await run("login_code", { code: "abc" })).body.error?.code).toBe("invalid_input");
  expect(calls).toEqual([]);
});

it("refuses to log in before api_id and api_hash exist", async () => {
  const { body } = await run("login_phone", { phone: "+33612345678" });
  expect(body.error?.code).toBe("not_configured");
  expect(calls).toEqual([]);
});

it("logout deletes the local session and a pending login, keeps telegram-user.json", async () => {
  configure();
  for (const name of ["telegram-user.session", "telegram-user.session-journal", "telegram-user.login.json"]) fs.writeFileSync(file(name), "x");
  const { body } = await run("logout");
  expect(body.data).toEqual({ configured: true, loggedIn: false, account: null, step: "phone" });
  expect(fs.readdirSync(dataDir)).toEqual(["telegram-user.json"]);
  expect(calls).toEqual([]);
});

it("rejects unknown actions", async () => {
  const { exitCode, body } = await run("send", { to: "@x", text: "y" });
  expect(exitCode).toBe(1);
  expect(body.error?.code).toBe("invalid_request");
});
