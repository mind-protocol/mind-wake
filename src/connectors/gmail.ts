import * as z from "zod";
import { ConnectorError, ConnectorGate, type SecretVault } from "./core.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_HOSTS = ["gmail.googleapis.com", "oauth2.googleapis.com"] as const;
export const gmailConfigSchema = z
  .strictObject({
    account: z.email().max(254),
    clientId: z.string().regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/),
    labelIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
      .min(1)
      .max(20),
    after: z.int().min(0),
    before: z.int().positive(),
    query: z.string().trim().min(1).max(1000),
    selectedIds: z.array(z.string().regex(/^[a-fA-F0-9]{1,32}$/)).max(100),
    maxResults: z.int().min(1).max(50),
    maxPages: z.int().min(1).max(5),
    maxReads: z.int().min(1).max(20),
  })
  .refine((c) => c.after < c.before && c.before - c.after <= 366 * 86400);
export type GmailConfig = z.infer<typeof gmailConfigSchema>;
export interface GmailTokens {
  refreshToken: string;
  clientSecret?: string;
}

const listSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().regex(/^[a-fA-F0-9]{1,32}$/),
        threadId: z.string().regex(/^[a-fA-F0-9]{1,32}$/),
      }),
    )
    .max(50)
    .default([]),
  nextPageToken: z.string().max(2048).optional(),
});
const partSchema = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  body: z
    .object({ data: z.string().max(1_000_000).optional(), attachmentId: z.string().optional() })
    .optional(),
});
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.string(),
  labelIds: z.array(z.string()),
  snippet: z.string().max(10000).optional(),
  payload: partSchema
    .extend({
      headers: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .max(200)
        .optional(),
      parts: z.array(partSchema).max(100).optional(),
    })
    .optional(),
});

/** Bounded streaming parse; never retain response bodies or error text on disk. */
export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    const code =
      response.status === 401
        ? "reauthorize"
        : response.status === 403
          ? "forbidden"
          : response.status === 429
            ? "rate_limited"
            : "unavailable";
    throw new ConnectorError(code);
  }
  if (!response.body) throw new ConnectorError("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new ConnectorError("unavailable");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** No arbitrary URL, HTTP verb, headers, query or pagination token from the model. */
export class GmailReader {
  constructor(
    readonly config: GmailConfig,
    readonly tokenRef: string,
    readonly vault: SecretVault,
    readonly gate: ConnectorGate,
    readonly transport: typeof fetch = fetch,
  ) {
    gmailConfigSchema.parse(config);
  }

  private async operation<T>(
    work: (get: (resource: string, params?: URLSearchParams) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    return this.gate.run("gmail", this.config.account, async (signal, check) => {
      await check();
      const tokens = JSON.parse(await this.vault.get(this.tokenRef)) as GmailTokens;
      await check();
      const body = new URLSearchParams({
        client_id: this.config.clientId,
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
      });
      if (tokens.clientSecret) body.set("client_secret", tokens.clientSecret);
      // No automatic retries, including 429. A new call rechecks all controls.
      const refreshed = await this.transport("https://oauth2.googleapis.com/token", {
        method: "POST",
        body,
        signal,
        redirect: "error",
      });
      if (refreshed.status === 400) {
        await refreshed.body?.cancel();
        throw new ConnectorError("reauthorize");
      }
      const token = z
        .object({
          access_token: z.string().min(1).max(16384),
          token_type: z.literal("Bearer"),
          scope: z.string().optional(),
        })
        .parse(await boundedJson(refreshed));
      if (token.scope !== undefined && token.scope !== GMAIL_SCOPE)
        throw new ConnectorError("scope_missing");
      await check();
      const get = async (resource: string, params = new URLSearchParams()): Promise<unknown> => {
        if (!/^(profile|messages|messages\/[a-fA-F0-9]{1,32})$/.test(resource))
          throw new ConnectorError("invalid_input");
        await check();
        const response = await this.transport(
          "https://gmail.googleapis.com/gmail/v1/users/me/" + resource + "?" + params.toString(),
          {
            method: "GET",
            headers: { Authorization: "Bearer " + token.access_token },
            signal,
            redirect: "error",
          },
        );
        const data = await boundedJson(response);
        await check();
        return data;
      };
      const profile = z.object({ emailAddress: z.string() }).parse(await get("profile"));
      if (profile.emailAddress.toLowerCase() !== this.config.account.toLowerCase())
        throw new ConnectorError("account_mismatch");
      return work(get);
    });
  }

  private async candidates(get: (resource: string, params?: URLSearchParams) => Promise<unknown>) {
    const result: { id: string; threadId: string }[] = [];
    let page: string | undefined;
    for (let i = 0; i < this.config.maxPages; i++) {
      const remaining = this.config.maxResults - result.length;
      if (remaining <= 0) break;
      const params = new URLSearchParams({
        q:
          "(" +
          this.config.query +
          ") after:" +
          String(this.config.after) +
          " before:" +
          String(this.config.before),
        maxResults: String(remaining),
        includeSpamTrash: "false",
      });
      for (const label of this.config.labelIds) params.append("labelIds", label);
      if (page) params.set("pageToken", page);
      const data = listSchema.parse(await get("messages", params));
      for (const m of data.messages.slice(0, remaining)) {
        if (this.config.selectedIds.length === 0 || this.config.selectedIds.includes(m.id))
          result.push(m);
      }
      page = data.nextPageToken;
      if (!page) break;
    }
    return result;
  }

  search() {
    return this.operation(async (get) => {
      const candidates = await this.candidates(get);
      return {
        provider: "gmail",
        account: this.config.account,
        readAt: new Date().toISOString(),
        untrusted: true,
        partial: true,
        messages: candidates.map((message) => ({
          ...message,
          url: this.messageUrl(message.id),
          sourceDate: null,
        })),
        sourceDateMeaning:
          "Gmail messages.list does not return source dates; read a selected message for its date",
      };
    });
  }

  private messageUrl(id: string): string {
    return (
      "https://mail.google.com/mail/u/" + encodeURIComponent(this.config.account) + "/#all/" + id
    );
  }

  private async readCandidate(
    get: (resource: string, params?: URLSearchParams) => Promise<unknown>,
    id: string,
    threadId: string,
  ) {
    const m = messageSchema.parse(
      await get("messages/" + id, new URLSearchParams({ format: "full" })),
    );
    const time = Number(m.internalDate) / 1000;
    if (
      m.id !== id ||
      m.threadId !== threadId ||
      !Number.isFinite(time) ||
      time <= this.config.after ||
      time >= this.config.before ||
      !this.config.labelIds.every((label) => m.labelIds.includes(label))
    )
      throw new ConnectorError("out_of_scope");
    const parts = [m.payload, ...(m.payload?.parts ?? [])];
    // Plain text only. Never expose HTML, attachment IDs, fetch links or executable rendering.
    const text = parts
      .filter((p) => p?.mimeType === "text/plain" && !p.filename && !p.body?.attachmentId)
      .map((p) => Buffer.from(p?.body?.data ?? "", "base64url").toString("utf8"))
      .join("\n")
      .slice(0, 32000);
    return {
      provider: "gmail",
      account: this.config.account,
      id: m.id,
      threadId: m.threadId,
      url: this.messageUrl(m.id),
      sourceDate: new Date(Number(m.internalDate)).toISOString(),
      readAt: new Date().toISOString(),
      untrusted: true,
      text,
      snippet: m.snippet ?? "",
      headers: (m.payload?.headers ?? []).filter((h) =>
        ["from", "to", "date", "subject"].includes(h.name.toLowerCase()),
      ),
    };
  }

  message(id: string) {
    if (!/^[a-fA-F0-9]{1,32}$/.test(id)) return Promise.reject(new ConnectorError("invalid_input"));
    if (this.config.selectedIds.length > 0 && !this.config.selectedIds.includes(id))
      return Promise.reject(new ConnectorError("out_of_scope"));
    return this.operation(async (get) => {
      const candidate = (await this.candidates(get)).find((m) => m.id === id);
      if (!candidate) throw new ConnectorError("out_of_scope");
      return this.readCandidate(get, id, candidate.threadId);
    });
  }

  thread(id: string) {
    if (!/^[a-fA-F0-9]{1,32}$/.test(id)) return Promise.reject(new ConnectorError("invalid_input"));
    return this.operation(async (get) => {
      const matches = (await this.candidates(get))
        .filter((m) => m.threadId === id)
        .slice(0, this.config.maxReads);
      if (!matches.length) throw new ConnectorError("out_of_scope");
      const messages = [];
      for (const m of matches) messages.push(await this.readCandidate(get, m.id, id));
      return { provider: "gmail", threadId: id, partial: true, untrusted: true, messages };
    });
  }
}
