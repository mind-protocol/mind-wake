import { describe, it, expect } from "vitest";
import { ColonyTokens } from "../../services/colony/client.js";

describe("Colony JWT lifecycle", () => {
  it("shares concurrent refreshes, caches, and renews before expiry", async () => {
    let now = 0;
    let calls = 0;
    const http: typeof fetch = (url, init) => {
      expect(url).toBe("https://thecolony.ai/api/v1/auth/token");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBe(JSON.stringify({ api_key: "test-key" }));
      calls++;
      return Promise.resolve(
        Response.json({ access_token: `jwt-${String(calls)}`, expires_in: 120 }),
      );
    };
    const tokens = new ColonyTokens("test-key", http, () => now);
    expect(await Promise.all([tokens.token(), tokens.token()])).toEqual(["jwt-1", "jwt-1"]);
    now = 59_000;
    expect(await tokens.token()).toBe("jwt-1");
    now = 60_000;
    expect(await tokens.token()).toBe("jwt-2");
    tokens.invalidate();
    expect(await tokens.token()).toBe("jwt-3");
    expect(calls).toBe(3);
  });

  it("honors JWT exp even when expires_in claims a longer lifetime", async () => {
    let now = 0;
    let calls = 0;
    const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 90 })).toString("base64url")}.sig`;
    const tokens = new ColonyTokens(
      "key",
      () => {
        calls++;
        return Promise.resolve(Response.json({ access_token: jwt, expires_in: 86400 }));
      },
      () => now,
    );
    await tokens.token();
    now = 31_000;
    await tokens.token();
    expect(calls).toBe(2);
  });

  it("does not disclose an auth failure body and can retry a failed refresh", async () => {
    let calls = 0;
    const tokens = new ColonyTokens("secret", () =>
      Promise.resolve(
        ++calls === 1
          ? new Response("sensitive echoed body", { status: 401 })
          : Response.json({ access_token: "good" }),
      ),
    );
    await expect(tokens.token()).rejects.toThrow("Colony authentication HTTP 401");
    expect(await tokens.token()).toBe("good");
  });
});
