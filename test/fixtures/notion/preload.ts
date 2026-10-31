/** Explicit test-only preload. Production has no flag/env mechanism to load this seam. */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticNotion } from "./provider.js";
const directory = process.env["NOTION_TEST_DIRECTORY"] ?? "";
const mode = process.env["NOTION_TEST_MODE"] ?? "normal";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin !== "https://api.notion.com") throw Error("fixture origin refused");
  fs.appendFileSync(
    path.join(directory, "requests.txt"),
    `${init?.method ?? "GET"} ${url.pathname}\n`,
  );
  if (url.pathname.endsWith("/search") && mode !== "normal") {
    fs.writeFileSync(path.join(directory, "entered"), "synthetic");
    if (mode === "retry")
      return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
    await delay(250, undefined, { signal: init?.signal ?? undefined });
  }
  const response = await syntheticNotion(
    { method: init?.method === "POST" ? "POST" : "GET", path: url.pathname.slice(3) },
    "synthetic-not-used",
    init?.signal ?? new AbortController().signal,
  );
  if (mode === "pagination" && url.pathname.endsWith("/search"))
    return new Response(
      JSON.stringify({ results: [], has_more: true, next_cursor: "synthetic-next-page" }),
    );
  return new Response(JSON.stringify(response.data), { status: response.status });
};
