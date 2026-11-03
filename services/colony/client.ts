import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod";

const connectionSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  apiKey: z.string().regex(/^col_[A-Za-z0-9_-]{20,200}$/),
  syncReplies: z.boolean().default(false),
});

/** Credentials belong to this installation, never to the repository or another profile. */
export function colonyConnection(env: Readonly<Record<string, string | undefined>>) {
  const file =
    env["MIND_COLONY_CONFIG_FILE"] ||
    (env["MIND_WAKE_DATA_DIR"] ? path.join(env["MIND_WAKE_DATA_DIR"], "colony.json") : undefined);
  if (!file) return undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      throw Error("Invalid connection file");
    const config = connectionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return config.enabled ? config : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      process.stderr.write("MIND Colony: connexion invalide ; intégration désactivée.\n");
    return undefined;
  }
}

/** The API key is exchanged only at the fixed auth origin; JWTs stay in memory. */
export class ColonyTokens {
  private jwt: string | undefined;
  private expiresAt = 0;
  private pending: Promise<string> | undefined;
  constructor(
    private readonly apiKey: string,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate() {
    this.jwt = undefined;
    this.expiresAt = 0;
  }

  async token(): Promise<string> {
    if (this.jwt && this.now() < this.expiresAt) return this.jwt;
    if (!this.pending)
      this.pending = this.mint().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async mint() {
    const response = await this.http("https://thecolony.ai/api/v1/auth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey }),
    });
    if (!response.ok) throw Error(`Colony authentication HTTP ${String(response.status)}`);
    const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token.trim())
      throw Error("Invalid Colony token response");
    let seconds = 24 * 60 * 60;
    if (
      typeof data.expires_in === "number" &&
      Number.isFinite(data.expires_in) &&
      data.expires_in > 0
    )
      seconds = Math.min(seconds, data.expires_in);
    try {
      const payload = z
        .object({ exp: z.number().optional() })
        .parse(
          JSON.parse(Buffer.from(data.access_token.split(".")[1] ?? "", "base64url").toString()),
        );
      if (typeof payload.exp === "number" && Number.isFinite(payload.exp))
        seconds = Math.min(seconds, payload.exp - this.now() / 1000);
    } catch {
      /* Opaque access tokens use the documented lifetime. */
    }
    this.jwt = data.access_token;
    this.expiresAt = this.now() + Math.max(0, seconds - 60) * 1000;
    return this.jwt;
  }
}

export class ColonyClient {
  private pending: Promise<Client> | undefined;
  private readonly tokens: ColonyTokens;
  constructor(apiKey: string) {
    this.tokens = new ColonyTokens(apiKey);
  }

  /** GET only; the notification collector never marks remote items read. */
  async readApi(route: string) {
    if (!/^\/(users\/me|notifications\?(?:[a-z_]+=[a-z0-9]+&?)+)$/.test(route))
      throw Error("Unsupported Colony read route");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`https://thecolony.ai/api/v1${route}`, {
        headers: { Authorization: `Bearer ${await this.tokens.token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.tokens.invalidate();
        continue;
      }
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const seconds =
          raw && /^\d+$/.test(raw)
            ? Number(raw)
            : raw
              ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
              : 60;
        await response.body?.cancel();
        throw new ColonyRateLimit(Number.isFinite(seconds) ? Math.max(60, seconds) : 60);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("Colony read failed");
      }
      return (await response.json()) as unknown;
    }
    throw Error("Colony authentication failed");
  }

  async me() {
    return this.readApi("/users/me");
  }
  async notifications(offset: number) {
    return this.readApi(`/notifications?unread_only=false&limit=100&offset=${String(offset)}`);
  }

  private connect(): Promise<Client> {
    if (!this.pending) {
      const client = new Client({ name: "mind-wake-colony", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL("https://thecolony.ai/mcp/"), {
        authProvider: {
          token: () => this.tokens.token(),
          onUnauthorized: async () => {
            this.tokens.invalidate();
            await this.tokens.token();
          },
        },
        requestInit: { redirect: "error" },
      });
      this.pending = client
        .connect(transport)
        .then(() => client)
        .catch(async () => {
          this.pending = undefined;
          await transport.close().catch(() => {});
          throw Error("Colony MCP connection failed");
        });
    }
    return this.pending;
  }

  async listTools(cursor?: string) {
    return (await this.connect()).listTools(cursor ? { cursor } : {});
  }
  async callTool(name: string, args: Record<string, unknown>) {
    return (await this.connect()).callTool({ name, arguments: args });
  }
  async close() {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) await pending.then((c) => c.close()).catch(() => {});
  }
}

export class ColonyRateLimit extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Colony rate limited");
  }
}
