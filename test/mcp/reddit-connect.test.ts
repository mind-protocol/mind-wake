import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startRedditConnect } from "../../services/reddit/connect.js";
import { redditEnvironment } from "../../services/reddit/config.js";

async function harness(webApp = false, username = "testuser") {
  const dir = mkdtempSync(join(tmpdir(), "wake-reddit-"));
  const file = join(dir, "reddit.json");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          scope: "identity read",
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ name: username })));
  const connection = await startRedditConnect(
    { clientId: "client123", username: "testuser", configFile: file, webApp, port: 0 },
    fetcher,
  );
  const auth = new URL(connection.authorizationUrl);
  const state = auth.searchParams.get("state") ?? "";
  const callback = new URL(connection.redirectUri);
  callback.search = new URLSearchParams({ state, code: "one-use-code" }).toString();
  return {
    ...connection,
    file,
    fetcher,
    callback,
    prepare: (origin = callback.origin) =>
      fetch(new URL("/prepare", callback), {
        method: "POST",
        redirect: "manual",
        headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state, client_secret: "  web-secret  " }),
      }),
    cleanup: async () => {
      await connection.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("connects an installed app, verifies identity and saves profile-scoped read-only credentials", async () => {
  const h = await harness();
  try {
    const response = await fetch(h.callback, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/done");
    expect(JSON.parse(readFileSync(h.file, "utf8"))).toMatchObject({
      clientId: "client123",
      refreshToken: "refresh-secret",
      allowWrite: false,
      enabled: true,
    });
    expect(readFileSync(h.file, "utf8")).not.toContain("access-secret");
    expect((await fetch(h.callback)).status).toBe(409);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(
      redditEnvironment({ MIND_REDDIT_CONFIG_FILE: h.file, MIND_REDDIT_ACCESS_TOKEN: "stale" }),
    ).toMatchObject({
      MIND_REDDIT_ENABLED: "1",
      MIND_REDDIT_ACCESS_TOKEN: undefined,
      MIND_REDDIT_ALLOW_WRITE: "0",
      MIND_REDDIT_REFRESH_TOKEN: "refresh-secret",
    });
  } finally {
    await h.cleanup();
  }
});

it("rejects a callback with a wrong state without contacting Reddit", async () => {
  const h = await harness();
  try {
    h.callback.searchParams.set("state", "forged");
    expect((await fetch(h.callback)).status).toBe(400);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(existsSync(h.file)).toBe(false);
  } finally {
    await h.cleanup();
  }
});

it("accepts a web-app secret only through the same-origin local form", async () => {
  const h = await harness(true);
  try {
    const page = await fetch(h.setupUrl);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://www.reddit.com",
    );
    expect(await page.text()).toContain('type="password"');
    expect((await h.prepare("https://evil.example")).status).toBe(403);
    expect((await fetch(h.callback)).status).toBe(409);
    expect(h.fetcher).not.toHaveBeenCalled();
    const prepared = await h.prepare();
    expect(prepared.status).toBe(303);
    expect(prepared.headers.get("location")).toBe(h.authorizationUrl);
    expect((await fetch(h.callback, { redirect: "manual" })).status).toBe(303);
    const first = h.fetcher.mock.calls[0];
    expect(first?.[1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client123:web-secret").toString("base64")}`,
    });
    expect(JSON.parse(readFileSync(h.file, "utf8"))).toMatchObject({ clientSecret: "web-secret" });
  } finally {
    await h.cleanup();
  }
});

it("explains invalid application credentials without persisting or exposing secrets", async () => {
  const h = await harness(true);
  try {
    h.fetcher.mockReset().mockResolvedValueOnce(new Response("web-secret", { status: 401 }));
    await h.prepare();
    const response = await fetch(h.callback, { redirect: "manual" });
    const message = await response.text();
    expect(response.status).toBe(502);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("pas le client ID");
    expect(message).not.toContain("web-secret");
    expect(existsSync(h.file)).toBe(false);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await h.cleanup();
  }
});

it("does not save credentials for a different account or a refused consent", async () => {
  for (const denied of [false, true]) {
    const h = await harness(false, "someoneelse");
    try {
      if (denied) h.callback.searchParams.set("error", "access_denied");
      expect((await fetch(h.callback)).status).toBe(denied ? 403 : 409);
      expect(existsSync(h.file)).toBe(false);
    } finally {
      await h.cleanup();
    }
  }
});

it("upgrades reply scopes only after consent, reuses the saved secret and preserves subscriptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-reddit-upgrade-"));
  const file = join(dir, "reddit.json");
  const previous = {
    version: 1,
    enabled: true,
    clientId: "client123",
    clientSecret: "saved-secret",
    refreshToken: "old-token",
    userAgent: "desktop:mind-wake:0.1 (by /u/testuser)",
    allowWrite: false,
    subscriptions: ["MachineToMachine"],
  };
  writeFileSync(file, JSON.stringify(previous));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "new-token",
          scope: "identity read privatemessages",
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ name: "testuser" })));
  const h = await startRedditConnect(
    {
      clientId: "client123",
      username: "testuser",
      configFile: file,
      webApp: true,
      enableReplies: true,
      port: 0,
    },
    fetcher,
  );
  try {
    const authorization = new URL(h.authorizationUrl);
    expect(authorization.searchParams.get("scope")).toBe("identity read privatemessages");
    expect(h.setupUrl).toBe(h.authorizationUrl);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(previous);
    const callback = new URL(h.redirectUri);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state") ?? "",
      code: "consented",
    }).toString();
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(303);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      refreshToken: "new-token",
      syncReplies: true,
      allowWrite: false,
      subscriptions: ["MachineToMachine"],
      clientSecret: "saved-secret",
    });
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves existing credentials and fails closed on an invalid profile config", async () => {
  const h = await harness();
  try {
    writeFileSync(h.file, "invalid");
    await expect(
      startRedditConnect({
        clientId: "client123",
        username: "testuser",
        configFile: h.file,
        port: 0,
      }),
    ).rejects.toThrow("aucun identifiant remplacé");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        redditEnvironment({ MIND_WAKE_DATA_DIR: join(h.file, ".."), MIND_REDDIT_ALLOW_WRITE: "1" }),
      ).toMatchObject({ MIND_REDDIT_ENABLED: "0", MIND_REDDIT_ALLOW_WRITE: "0" });
    } finally {
      stderr.mockRestore();
    }
  } finally {
    await h.cleanup();
  }
});
