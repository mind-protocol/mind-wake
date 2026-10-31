import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { connectors } from "../cli/commands/connectors.js";
import { processContext } from "../cli/context.js";
import { ConnectorRecords } from "./local.js";
import { GMAIL_SCOPE } from "./gmail.js";

it("owner CLI setup through real OAuth loopback, status and disconnect with synthetic HTTP", async () => {
  const dir = { path: path.resolve(".local/owner/" + randomUUID()), source: "option" as const };
  fs.mkdirSync(dir.path, { recursive: true });
  const values = new Map<string, string>();
  const records = new ConnectorRecords(dir.path, {
    put: (value) => {
      const ref = randomUUID();
      values.set(ref, value);
      return Promise.resolve(ref);
    },
    get: (ref) => Promise.resolve(values.get(ref) ?? ""),
    delete: (ref) => {
      values.delete(ref);
      return Promise.resolve();
    },
  });
  const filename = path.join(dir.path, "setup.json");
  fs.writeFileSync(
    filename,
    JSON.stringify({
      config: {
        account: "fixture@example.invalid",
        clientId: "fixture.apps.googleusercontent.com",
        labelIds: ["INBOX"],
        after: 1700000000,
        before: 1700100000,
        query: "fixture",
        selectedIds: [],
        maxResults: 2,
        maxPages: 1,
        maxReads: 2,
      },
    }),
  );
  const ctx = {
    ...processContext(),
    prompt: (question: string) =>
      Promise.resolve(question.includes("DISCONNECT") ? "DISCONNECT" : "CONNECT"),
  };
  const seams = {
    records,
    interactive: () => true,
    control: () => ({ allowed: true, revision: "fixture" }),
    browser: async (url: string) => {
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "synthetic-code");
      expect((await fetch(callback)).status).toBe(200);
    },
    transport: ((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            (url instanceof Request ? url.url : url.toString()).includes("/token")
              ? {
                  access_token: "SYNTHETIC_ACCESS",
                  refresh_token: "SYNTHETIC_REFRESH",
                  token_type: "Bearer",
                  scope: GMAIL_SCOPE,
                }
              : { emailAddress: "fixture@example.invalid" },
          ),
        ),
      )) as typeof fetch,
  };
  try {
    expect((await connectors(ctx, dir, "gmail-setup", filename, seams)).exitCode).toBe(0);
    expect((await connectors(ctx, dir, "status", undefined, seams)).data).toMatchObject({
      authorized: true,
      available: false,
    });
    expect((await records.read("gmail"))?.tokenRef).toBeTruthy();
    expect((await connectors(ctx, dir, "gmail-disconnect", undefined, seams)).exitCode).toBe(0);
    expect(await records.read("gmail")).toBeNull();
    expect(values.size).toBe(0);
  } finally {
    fs.rmSync(dir.path, { recursive: true, force: true });
  }
});
