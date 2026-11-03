import * as z from "zod";

type Env = Readonly<Record<string, string | undefined>>;
const subreddit = z.string().regex(/^[A-Za-z0-9_]{2,21}$/);
const fullname = z.string().regex(/^t[13]_[a-z0-9]+$/);
const cursor = z
  .string()
  .regex(/^t3_[a-z0-9]+$/)
  .optional();
const limit = z.int().min(1).max(100).default(25);
const time = z.enum(["hour", "day", "week", "month", "year", "all"]).default("all");
export const feedInput = z.strictObject({
  subreddit,
  sort: z.enum(["hot", "new", "top", "rising", "controversial"]).default("hot"),
  time,
  limit,
  after: cursor,
});
export const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(512),
  subreddit: subreddit.optional(),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance"),
  time,
  limit,
  after: cursor,
});
export const threadInput = z.strictObject({
  post_id: z.string().regex(/^(?:t3_)?[a-z0-9]+$/),
  sort: z.enum(["confidence", "top", "new", "controversial", "old", "qa"]).default("confidence"),
  limit,
  depth: z.int().min(1).max(10).default(5),
});
export const submitInput = z.strictObject({
  subreddit,
  title: z.string().trim().min(1).max(300),
  text: z.string().max(40000),
  flair_id: z.string().max(100).optional(),
});
export const commentInput = z.strictObject({
  parent_id: fullname,
  text: z.string().trim().min(1).max(10000),
});

export class RedditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const thingSchema = z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()) });
const listingSchema = z.object({
  data: z.object({
    after: z.string().nullable().optional(),
    children: z.array(thingSchema),
  }),
});
const postFields = [
  "name",
  "id",
  "subreddit",
  "author",
  "title",
  "selftext",
  "url",
  "permalink",
  "score",
  "num_comments",
  "created_utc",
  "over_18",
  "locked",
  "removed_by_category",
];
const commentFields = [
  "name",
  "id",
  "parent_id",
  "link_id",
  "subreddit",
  "author",
  "body",
  "permalink",
  "score",
  "created_utc",
];
function select(data: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.filter((k) => k in data).map((k) => [k, data[k]]));
}
function listing(value: unknown) {
  const parsed = listingSchema.parse(value);
  return {
    after: parsed.data.after ?? null,
    posts: parsed.data.children
      .filter((t) => t.kind === "t3")
      .map((t) => select(t.data, postFields)),
  };
}
function comments(value: unknown, depth: number): unknown[] {
  if (depth <= 0) return [];
  return listingSchema
    .parse(value)
    .data.children.map((t) => {
      if (t.kind === "more")
        return { kind: "more", ...select(t.data, ["id", "parent_id", "count", "children"]) };
      if (t.kind !== "t1") return null;
      return {
        ...select(t.data, commentFields),
        replies: t.data["replies"] ? comments(t.data["replies"], depth - 1) : [],
      };
    })
    .filter((t) => t !== null);
}

/** OAuth only. No persisted content or credentials, no automatic replay of writes. */
export class RedditClient {
  private token: string | undefined;
  private expiresAt = 0;
  private refreshing: Promise<string> | undefined;
  private blockedUntil = 0;
  // Serialize requests so the next call observes the preceding rate-limit headers.
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.token = env["MIND_REDDIT_ACCESS_TOKEN"];
    if (this.token) this.expiresAt = Infinity;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.expiresAt > this.now() + 30_000) return this.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private userAgent(): string {
    const agent = this.env["MIND_REDDIT_USER_AGENT"];
    if (!agent || /[\r\n]/.test(agent))
      throw new RedditError(
        "configuration",
        "MIND_REDDIT_USER_AGENT requis (plateforme:application:version, contact Reddit).",
      );
    return agent;
  }

  private async refresh(): Promise<string> {
    const id = this.env["MIND_REDDIT_CLIENT_ID"];
    const refresh = this.env["MIND_REDDIT_REFRESH_TOKEN"];
    if (!id || !refresh)
      throw new RedditError(
        "configuration",
        "Configurer un access token ou CLIENT_ID + REFRESH_TOKEN Reddit.",
      );
    const response = await this.send("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent(),
        Authorization: `Basic ${Buffer.from(`${id}:${this.env["MIND_REDDIT_CLIENT_SECRET"] ?? ""}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    const result = tokenSchema.safeParse(await this.json(response));
    if (!result.success)
      throw new RedditError(
        "authentication",
        "Réponse OAuth invalide ; vérifier les identifiants et l’autorisation Reddit.",
      );
    this.token = result.data.access_token;
    this.expiresAt = this.now() + result.data.expires_in * 1000;
    return this.token;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new RedditError(
        "network",
        "Requête Reddit interrompue. Une écriture peut avoir abouti : vérifier avant de réessayer.",
      );
    }
    const retry = response.headers.get("retry-after");
    const seconds =
      retry === null
        ? NaN
        : /^\d+(?:\.\d+)?$/.test(retry)
          ? Number(retry)
          : (Date.parse(retry) - this.now()) / 1000;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (response.status === 429 || (remaining !== null && Number(remaining) <= 0)) {
      const wait = Math.max(
        1,
        Number.isFinite(seconds) ? seconds : Number.isFinite(reset) && reset > 0 ? reset : 60,
      );
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.ceil(wait) * 1000);
    }
    if (!response.ok) {
      // Never echo response bodies: they can contain submitted text or secrets.
      throw new RedditError(
        response.status === 429
          ? "rate_limited"
          : response.status === 401
            ? "authentication"
            : response.status === 403
              ? "forbidden"
              : "http_error",
        `Reddit HTTP ${String(response.status)}.`,
        response.status === 429 ? Math.ceil((this.blockedUntil - this.now()) / 1000) : undefined,
      );
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new RedditError("invalid_response", "Réponse JSON Reddit invalide.");
    }
  }

  private request(path: string, params: Record<string, string>, write = false): Promise<unknown> {
    if (write && this.env["MIND_REDDIT_ALLOW_WRITE"] !== "1")
      return Promise.reject(
        new RedditError(
          "write_disabled",
          "Publications Reddit désactivées : MIND_REDDIT_ALLOW_WRITE=1 requis après autorisation humaine.",
        ),
      );
    const work = async () => {
      if (this.blockedUntil > this.now())
        throw new RedditError(
          "rate_limited",
          "Attendre la fin de la limite Reddit.",
          Math.ceil((this.blockedUntil - this.now()) / 1000),
        );
      const token = await this.accessToken();
      if (this.blockedUntil > this.now())
        throw new RedditError(
          "rate_limited",
          "Attendre la fin de la limite Reddit.",
          Math.ceil((this.blockedUntil - this.now()) / 1000),
        );
      const query = new URLSearchParams({ ...params, raw_json: "1" });
      const url = `https://oauth.reddit.com${path}${write ? "" : `?${query.toString()}`}`;
      try {
        return await this.json(
          await this.send(url, {
            method: write ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": this.userAgent(),
              ...(write ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            ...(write ? { body: query } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof RedditError && error.code === "authentication") {
          this.token = undefined;
          this.expiresAt = 0;
        }
        throw error;
      }
    };
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async me() {
    const value = z.record(z.string(), z.unknown()).parse(await this.request("/api/v1/me", {}));
    return select(value, ["name", "id", "created_utc", "link_karma", "comment_karma"]);
  }
  async incoming(kind: "comments" | "selfreply", after?: string) {
    const folder = z.enum(["comments", "selfreply"]).parse(kind);
    if (after !== undefined)
      z.string()
        .regex(/^t[134]_[a-z0-9]+$/)
        .parse(after);
    const result = listingSchema.parse(
      await this.request(`/message/${folder}`, {
        mark: "false",
        limit: "100",
        ...(after ? { after } : {}),
      }),
    );
    return {
      after: result.data.after ?? null,
      posts: result.data.children
        .filter((t) => t.kind === "t1" && typeof t.data["subreddit"] === "string")
        .map((t) => select(t.data, [...commentFields, "context", "link_title"])),
    };
  }
  async feed(input: z.input<typeof feedInput>) {
    const a = feedInput.parse(input);
    return listing(
      await this.request(`/r/${a.subreddit}/${a.sort}`, {
        limit: String(a.limit),
        t: a.time,
        ...(a.after ? { after: a.after } : {}),
      }),
    );
  }
  async search(input: z.input<typeof searchInput>) {
    const a = searchInput.parse(input);
    return listing(
      await this.request(a.subreddit ? `/r/${a.subreddit}/search` : "/search", {
        q: a.query,
        type: "link",
        sort: a.sort,
        t: a.time,
        limit: String(a.limit),
        ...(a.subreddit ? { restrict_sr: "on" } : {}),
        ...(a.after ? { after: a.after } : {}),
      }),
    );
  }
  async thread(input: z.input<typeof threadInput>) {
    const a = threadInput.parse(input);
    const result = z
      .array(z.unknown())
      .length(2)
      .parse(
        await this.request(`/comments/${a.post_id.replace(/^t3_/, "")}`, {
          sort: a.sort,
          limit: String(a.limit),
          depth: String(a.depth),
        }),
      );
    return {
      post: listing(result[0]).posts[0] ?? null,
      comments: comments(result[1], a.depth),
      notice: "Arbre partiel : les entrées more et la profondeur peuvent masquer des réponses.",
    };
  }
  private async write(path: string, params: Record<string, string>) {
    const result = z
      .object({
        json: z.object({ errors: z.array(z.array(z.unknown())), data: z.unknown().optional() }),
      })
      .parse(await this.request(path, { ...params, api_type: "json" }, true));
    if (result.json.errors.length) {
      const rateLimited = result.json.errors.some((e) => e[0] === "RATELIMIT");
      if (rateLimited) this.blockedUntil = Math.max(this.blockedUntil, this.now() + 60_000);
      throw new RedditError(
        rateLimited ? "rate_limited" : "reddit_rejected",
        "Reddit a refusé la publication (règles, flair, scope ou limite). Vérifier avant de réessayer.",
        rateLimited ? 60 : undefined,
      );
    }
    return result.json.data ?? null;
  }
  submit(input: z.input<typeof submitInput>) {
    const a = submitInput.parse(input);
    return this.write("/api/submit", {
      sr: a.subreddit,
      kind: "self",
      title: a.title,
      text: a.text,
      ...(a.flair_id ? { flair_id: a.flair_id } : {}),
      resubmit: "false",
    });
  }
  comment(input: z.input<typeof commentInput>) {
    const a = commentInput.parse(input);
    return this.write("/api/comment", { thing_id: a.parent_id, text: a.text });
  }
}
