import { setTimeout as delay } from "node:timers/promises";
import { NOTION_API_VERSION, NotionError, notionFetch } from "./transport.js";
import type { NotionRequest, NotionTransport } from "./transport.js";
import type {
  NotionGrant,
  NotionHost,
  NotionKind,
  NotionList,
  NotionPath,
  NotionResult,
  NotionTarget,
} from "./types.js";

export function notionId(value: string): string {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new NotionError("invalid_id");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NotionError("invalid_response");
  return value as Record<string, unknown>;
}

function objectId(value: Record<string, unknown>): string {
  if (typeof value["id"] !== "string") throw new NotionError("invalid_response");
  return notionId(value["id"]);
}

const plural: Record<NotionKind, string> = {
  page: "pages",
  block: "blocks",
  database: "databases",
  data_source: "data_sources",
};
const pageSize = 25;
const maxPages = 4;

/** No persistence, setup, grants or state machine here. Construct only inside the trusted host. */
export class NotionReadonly {
  constructor(
    private readonly host: NotionHost,
    private readonly transport: NotionTransport = notionFetch,
  ) {}

  private begin(): NotionGrant {
    const grant = this.host.currentGrant();
    if (
      !grant ||
      grant.mode !== "internal" ||
      !grant.readContent ||
      !grant.generation ||
      !grant.accountId ||
      !grant.workspaceId ||
      !grant.credentialRef ||
      grant.rootPageIds.length === 0
    )
      throw new NotionError("not_authorized");
    grant.rootPageIds.forEach(notionId);
    this.check(grant);
    // Copy scope to prevent a host mutating the same grant object during an operation.
    return { ...grant, rootPageIds: [...grant.rootPageIds] };
  }

  private check(grant: NotionGrant): void {
    const current = this.host.currentGrant();
    if (grant.signal.aborted) throw new NotionError("cancelled");
    if (
      !current ||
      current.signal.aborted ||
      current.signal !== grant.signal ||
      current.generation !== grant.generation ||
      current.mode !== "internal" ||
      !current.readContent ||
      current.accountId !== grant.accountId ||
      current.workspaceId !== grant.workspaceId ||
      current.credentialRef !== grant.credentialRef ||
      current.includeDescendants !== grant.includeDescendants ||
      JSON.stringify(current.rootPageIds) !== JSON.stringify(grant.rootPageIds)
    )
      throw new NotionError("grant_changed");
  }

  private async call(grant: NotionGrant, request: NotionRequest): Promise<Record<string, unknown>> {
    for (let retry = 0; retry <= 2; retry++) {
      this.check(grant);
      try {
        const response = await this.host.withCredential(grant, async (token) => {
          this.check(grant);
          return this.transport(request, token, grant.signal);
        });
        this.check(grant);
        if (response.status === 429) {
          const seconds = Number(response.retryAfter);
          if (
            retry === 2 ||
            !response.retryAfter ||
            !Number.isFinite(seconds) ||
            seconds < 0 ||
            seconds > 5
          )
            throw new NotionError("rate_limited");
          await delay(Math.max(1, seconds * 1000), undefined, { signal: grant.signal });
          continue;
        }
        if (response.status !== 200)
          throw new NotionError(
            response.status === 401
              ? "invalid_token"
              : response.status === 403
                ? "read_content_or_share_required"
                : response.status === 404
                  ? "not_shared_or_missing"
                  : "provider_failed",
          );
        return record(response.data);
      } catch (error) {
        if (grant.signal.aborted) throw new NotionError("cancelled");
        if (error instanceof NotionError) throw error;
        throw new NotionError("request_failed");
      }
    }
    throw new NotionError("rate_limited");
  }

  private result(grant: NotionGrant, value: Record<string, unknown>): NotionResult {
    this.check(grant);
    const id = objectId(value);
    return {
      trust: "untrusted_source_content",
      provenance: {
        provider: "notion",
        apiVersion: NOTION_API_VERSION,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id,
        // Do not trust a provider/user supplied URL to become an authenticated fetch target.
        url: `https://www.notion.so/${id.replaceAll("-", "")}`,
        readAt: new Date().toISOString(),
        sourceCreatedAt: typeof value["created_time"] === "string" ? value["created_time"] : null,
        sourceEditedAt:
          typeof value["last_edited_time"] === "string" ? value["last_edited_time"] : null,
      },
      content: value,
    };
  }

  private async paged(
    grant: NotionGrant,
    request: NotionRequest,
  ): Promise<{ values: Record<string, unknown>[]; truncated: boolean }> {
    const values: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params = { page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) };
      const response = await this.call(
        grant,
        request.method === "POST"
          ? { ...request, body: { ...request.body, ...params } }
          : {
              ...request,
              path: `${request.path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`,
            },
      );
      if (
        !Array.isArray(response["results"]) ||
        response["results"].length > pageSize ||
        typeof response["has_more"] !== "boolean"
      )
        throw new NotionError("invalid_response");
      values.push(...response["results"].map(record));
      if (!response["has_more"]) return { values, truncated: false };
      const next = response["next_cursor"];
      if (typeof next !== "string" || !next || next.length > 4096 || seen.has(next))
        throw new NotionError("pagination_cycle");
      seen.add(next);
      cursor = next;
    }
    return { values, truncated: true };
  }

  private parentMatches(value: Record<string, unknown>, parent: NotionTarget): boolean {
    const raw = value["parent"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const p = record(raw);
    const field = `${parent.kind}_id`;
    try {
      return typeof p[field] === "string" && notionId(p[field]) === parent.id;
    } catch {
      return false;
    }
  }

  private async children(
    grant: NotionGrant,
    target: NotionTarget,
    content: Record<string, unknown>,
  ) {
    if (!grant.includeDescendants) throw new NotionError("descendants_not_authorized");
    if (target.kind === "block" && content["type"] === "synced_block") {
      const synced = record(content["synced_block"]);
      if (synced["synced_from"] !== null) throw new NotionError("external_synced_block");
    }
    if (target.kind === "database") {
      if (!Array.isArray(content["data_sources"]) || content["data_sources"].length > 100)
        throw new NotionError("invalid_response");
      return {
        values: content["data_sources"].map((value) => ({
          ...record(value),
          object: "data_source",
        })),
        truncated: false,
      };
    }
    const request: NotionRequest =
      target.kind === "data_source"
        ? { method: "POST", path: `/data_sources/${target.id}/query` }
        : { method: "GET", path: `/blocks/${target.id}/children` };
    const list = await this.paged(grant, request);
    for (const value of list.values) {
      if (!this.parentMatches(value, target)) throw new NotionError("parent_mismatch");
    }
    return list;
  }

  private matches(value: Record<string, unknown>, target: NotionTarget): boolean {
    return (
      objectId(value) === target.id &&
      (value["object"] === target.kind ||
        (value["object"] === "block" &&
          ((target.kind === "page" && value["type"] === "child_page") ||
            (target.kind === "database" && value["type"] === "child_database"))))
    );
  }

  private async resolve(
    grant: NotionGrant,
    path: NotionPath,
  ): Promise<{ target: NotionTarget; content: Record<string, unknown> }> {
    if (!path.length || path.length > 8) throw new NotionError("invalid_path");
    const normalized = path.map((target) => ({ ...target, id: notionId(target.id) }));
    const first = normalized[0];
    if (!first || first.kind !== "page" || !grant.rootPageIds.map(notionId).includes(first.id))
      throw new NotionError("outside_scope");
    if (new Set(normalized.map((x) => x.id)).size !== normalized.length)
      throw new NotionError("path_cycle");
    let target = first;
    let content = await this.call(grant, { method: "GET", path: `/pages/${target.id}` });
    if (!this.matches(content, target)) throw new NotionError("identity_mismatch");
    for (const next of normalized.slice(1)) {
      const list = await this.children(grant, target, content);
      if (!list.values.some((value) => this.matches(value, next)))
        throw new NotionError("outside_scope");
      const fetched = await this.call(grant, {
        method: "GET",
        path: `/${plural[next.kind]}/${next.id}`,
      });
      if (!this.matches(fetched, next) || !this.parentMatches(fetched, target))
        throw new NotionError("parent_mismatch");
      target = next;
      content = fetched;
    }
    return { target, content };
  }

  async get(path: NotionPath): Promise<NotionResult> {
    const grant = this.begin();
    const { content } = await this.resolve(grant, path);
    return this.result(grant, content);
  }

  async list(path: NotionPath): Promise<NotionList> {
    const grant = this.begin();
    const { target, content } = await this.resolve(grant, path);
    const list = await this.children(grant, target, content);
    return {
      items: list.values.map((value) => this.result(grant, value)),
      truncated: list.truncated,
    };
  }

  /** Search discovery is deliberately limited to granted root pages. Use explicit paths to list descendants. */
  async search(query: string): Promise<NotionList> {
    const grant = this.begin();
    if (!query.trim() || query.length > 200) throw new NotionError("invalid_query");
    const list = await this.paged(grant, {
      method: "POST",
      path: "/search",
      body: { query, filter: { property: "object", value: "page" } },
    });
    const roots = grant.rootPageIds.map(notionId);
    const items: NotionResult[] = [];
    for (const value of list.values) {
      const id = objectId(value);
      if (value["object"] !== "page" || !roots.includes(id)) continue;
      // Search is not an authorization cache. Re-fetch even a root hit before returning content.
      const { content } = await this.resolve(grant, [{ kind: "page", id }]);
      items.push(this.result(grant, content));
    }
    return { items, truncated: list.truncated };
  }

  async property(path: NotionPath, propertyId: string): Promise<NotionList> {
    const grant = this.begin();
    // Notion returns URL-encoded IDs. Preserve them; never double-encode.
    if (
      !propertyId ||
      propertyId.length > 256 ||
      !/^(?:[A-Za-z0-9_.~-]|%[0-9a-fA-F]{2})+$/.test(propertyId) ||
      propertyId === "." ||
      propertyId === ".."
    )
      throw new NotionError("invalid_property");
    const { target, content } = await this.resolve(grant, path);
    if (target.kind !== "page") throw new NotionError("invalid_path");
    const response = await this.call(grant, {
      method: "GET",
      path: `/pages/${target.id}/properties/${propertyId}`,
    });
    // Property IDs are short opaque IDs, not record UUIDs. Attach the verified page provenance.
    if (response["object"] === "list") {
      // Paginated property payloads are intentionally not expanded in this tranche.
      if (!Array.isArray(response["results"]) || response["results"].length > 100)
        throw new NotionError("invalid_response");
      return {
        items: response["results"].map((value) => ({
          ...this.result(grant, content),
          content: record(value),
        })),
        truncated: response["has_more"] !== false,
      };
    }
    return { items: [{ ...this.result(grant, content), content: response }], truncated: false };
  }
}
