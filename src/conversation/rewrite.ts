import type { CallMessage } from "./contracts.js";
import { parseObject } from "./messages.js";
import { assertSingleParagraphEdit } from "./edit-constraints.js";

export interface RewriteResult {
  messages: CallMessage[];
  improvements: string[];
  repository: { key: string; text: string; sources: string[] }[];
}
export function parseRewrite(text: string, original: readonly CallMessage[]): RewriteResult {
  const raw = parseObject(text),
    values = raw["messages"];
  if (!Array.isArray(values) || values.length !== original.length)
    throw Error("Rewrite must preserve the number of messages");
  const messages = values.map((value: unknown, index) => {
    if (!value || typeof value !== "object") throw Error("Invalid rewritten message");
    const m = value as Record<string, unknown>,
      before = original[index];
    if (!before) throw Error("Missing original message");
    if (m["role"] !== before.role || typeof m["content"] !== "string")
      throw Error("Rewrite changed message roles");
    if (before.role === "user" && m["content"] !== before.content)
      throw Error("Rewrite changed a human message");
    return { role: before.role, content: m["content"] };
  });
  assertSingleParagraphEdit(
    messages.flatMap((message, index) =>
      message.role === "assistant"
        ? [{ before: original[index]?.content ?? "", after: message.content }]
        : [],
    ),
  );
  const improvements = Array.isArray(raw["improvements"])
    ? raw["improvements"].filter((v): v is string => typeof v === "string")
    : [];
  const repository: RewriteResult["repository"] = [];
  for (const item of Array.isArray(raw["repository"]) ? raw["repository"] : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r["key"] !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(r["key"]) ||
      typeof r["text"] !== "string" ||
      !r["text"].trim()
    )
      continue;
    repository.push({
      key: r["key"],
      text: r["text"],
      sources: Array.isArray(r["sources"])
        ? r["sources"].filter((v): v is string => typeof v === "string")
        : [],
    });
  }
  return { messages, improvements, repository };
}
