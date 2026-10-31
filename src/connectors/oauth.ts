import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as z from "zod";
import { ConnectorError } from "./core.js";
import { boundedJson, GMAIL_SCOPE, type GmailTokens } from "./gmail.js";

export interface OAuthPending {
  /** Owner surface only; never put in model results or logs. */
  authorizationUrl: string;
  complete(): Promise<GmailTokens>;
  cancel(): void;
}

export async function beginGmailOAuth(input: {
  clientId: string;
  clientSecret?: string;
  account: string;
  signal: AbortSignal;
  check: () => Promise<void>;
  transport?: typeof fetch;
  lifetimeMs?: number;
}): Promise<OAuthPending> {
  await input.check();
  const isAborted = () => input.signal.aborted;
  if (isAborted()) throw new ConnectorError("stopped");
  const transport = input.transport ?? fetch;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callbackPath = "/oauth/" + randomBytes(16).toString("hex");
  const expires = Date.now() + Math.min(input.lifetimeMs ?? 180_000, 180_000);
  let consumed = false;
  let settle: (code: string | null) => void = () => undefined;
  const codePromise = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400);
      res.end("OAuth callback rejected.");
      return;
    }
    const candidate = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (
      req.method !== "GET" ||
      url.pathname !== callbackPath ||
      consumed ||
      Date.now() >= expires ||
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected) ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length > 1
    ) {
      res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("OAuth callback rejected.");
      return;
    }
    consumed = true;
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end("Return to the local Wake terminal. No connection is confirmed here.");
    settle(url.searchParams.has("error") ? null : url.searchParams.get("code"));
  });
  server.maxHeadersCount = 30;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => {
      reject(new ConnectorError("unavailable"));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new ConnectorError("unavailable");
  const redirect = "http://127.0.0.1:" + String(address.port) + callbackPath;
  const cancel = (): void => {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", cancel);
    consumed = true;
    settle(null);
    server.closeAllConnections();
    server.close();
  };
  const timer = setTimeout(cancel, Math.max(1, expires - Date.now()));
  input.signal.addEventListener("abort", cancel, { once: true });
  if (isAborted()) cancel();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: GMAIL_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    login_hint: input.account,
  }).toString();
  let completing = false;
  return {
    authorizationUrl: url.toString(),
    cancel,
    async complete() {
      if (completing) throw new ConnectorError("oauth_rejected");
      completing = true;
      try {
        const code = await codePromise;
        await input.check();
        if (!code || code.length > 8192 || Date.now() >= expires || input.signal.aborted)
          throw new ConnectorError("oauth_rejected");
        const body = new URLSearchParams({
          client_id: input.clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        });
        if (input.clientSecret) body.set("client_secret", input.clientSecret);
        const token = z
          .object({
            access_token: z.string().min(1),
            refresh_token: z.string().min(1),
            token_type: z.literal("Bearer"),
            scope: z.string().optional(),
          })
          .parse(
            await boundedJson(
              await transport("https://oauth2.googleapis.com/token", {
                method: "POST",
                body,
                redirect: "error",
                signal: input.signal,
              }),
            ),
          );
        if (token.scope !== GMAIL_SCOPE) throw new ConnectorError("scope_missing");
        await input.check();
        const profile = z.object({ emailAddress: z.string() }).parse(
          await boundedJson(
            await transport("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
              method: "GET",
              headers: { Authorization: "Bearer " + token.access_token },
              redirect: "error",
              signal: input.signal,
            }),
          ),
        );
        await input.check();
        if (profile.emailAddress.toLowerCase() !== input.account.toLowerCase())
          throw new ConnectorError("account_mismatch");
        return {
          refreshToken: token.refresh_token,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("oauth_rejected");
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", cancel);
        cancel();
      }
    },
  };
}
