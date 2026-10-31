export const NOTION_API_VERSION = "2026-03-11" as const;

export interface NotionRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

export class NotionError extends Error {
  constructor(readonly code: string) {
    super(`notion.${code}`);
    this.name = "NotionError";
  }
}

export interface NotionResponse {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly data: unknown;
}

export type NotionTransport = (
  request: NotionRequest,
  token: string,
  signal: AbortSignal,
) => Promise<NotionResponse>;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const readGet = new RegExp(
  `^/(?:pages/${uuid}(?:/properties/[A-Za-z0-9%_.~-]{1,256})?|blocks/${uuid}(?:/children)?|databases/${uuid}|data_sources/${uuid})$`,
);
const readPost = new RegExp(`^/(?:search|data_sources/${uuid}/query)$`);

function endpointAllowed(method: string, path: string): boolean {
  return (
    (method === "GET" && (readGet.test(path) || path === "/users/me")) ||
    (method === "POST" && readPost.test(path))
  );
}

/** Fixed origin, exact endpoint/method allowlist, redirects rejected. No arbitrary proxy. */
export const notionFetch: NotionTransport = async (request, token, signal) => {
  const url = new URL(`https://api.notion.com/v1${request.path}`);
  if (
    url.origin !== "https://api.notion.com" ||
    !endpointAllowed(request.method, url.pathname.slice(3))
  ) {
    throw new NotionError("endpoint_denied");
  }
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      redirect: "error",
      signal,
    });
    // Provider error bodies may contain private content; never parse or propagate them.
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        data: null,
      };
    }
    // Bound the actual stream, not only Content-Length (which is untrusted/optional).
    const reader = response.body?.getReader();
    if (!reader) throw new NotionError("invalid_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw new NotionError("response_limit");
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    return {
      status: response.status,
      retryAfter: null,
      data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  } catch (error) {
    if (error instanceof NotionError) throw error;
    throw new NotionError(signal.aborted ? "cancelled" : "transport_failed");
  }
};
