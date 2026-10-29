export interface RepoThread {
  id: string; repo: string; project: string; runtime: string; sessionId: string; transcript: string;
  messages: { id: string; at: string; from: "repo" | "wake"; text: string }[];
}
export function repoThreads(envelope: unknown): RepoThread[] {
  const e = envelope as {schema?:unknown;data?:{repoThreads?:unknown}} | null;
  if (e?.schema !== "mind-wake.cli" || !Array.isArray(e.data?.repoThreads)) return [];
  return e.data.repoThreads.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const t = raw as Record<string,unknown>;
    if (typeof t["id"] !== "string" || typeof t["repo"] !== "string" || !Array.isArray(t["messages"])) return [];
    const messages: RepoThread["messages"] = [];
    for (const r of t["messages"]) {
      if (!r || typeof r !== "object") continue;
      const m = r as Record<string,unknown>;
      if (typeof m["id"]==="string" && typeof m["at"]==="string" && typeof m["text"]==="string" && (m["from"]==="repo" || m["from"]==="wake"))
        messages.push({id:m["id"],at:m["at"],text:m["text"],from:m["from"]});
    }
    messages.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    return [{ id:t["id"], repo:t["repo"], project:t["repo"].split(/[\\/]/).filter(Boolean).at(-1) ?? t["repo"],
      runtime:typeof t["runtime"]==="string"?t["runtime"]:"", sessionId:typeof t["sessionId"]==="string"?t["sessionId"]:"",
      transcript:typeof t["transcript"]==="string"?t["transcript"]:"", messages }];
  });
}
