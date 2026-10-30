import fs from "node:fs";
import path from "node:path";
import { readOwnerMessages } from "./owner-messages.js";

export interface RepoThreadMessage { id: string; at: string; from: "repo" | "wake" | "system"; text: string; }
export interface RepoConversation {
  id: string; repo: string; runtime: string; sessionId: string; transcript: string;
  messages: RepoThreadMessage[];
}
interface RepoRecord { thread: Omit<RepoConversation, "messages">; message: RepoThreadMessage; }
const FILE = "repo-conversations.jsonl";
export function appendRepoMessage(dataDir: string, record: RepoRecord): void {
  const file = path.join(dataDir, FILE);
  if (fs.existsSync(file)) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Invalid repo conversation store");
  }
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}
export function readRepoConversations(dataDir: string, includeOwnerReplies = true): RepoConversation[] {
  const file = path.join(dataDir, FILE);
  if (!fs.existsSync(file)) return [];
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Invalid repo conversation store");
  const threads = new Map<string, RepoConversation>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: RepoRecord;
    try { r = JSON.parse(line) as RepoRecord; } catch { continue; }
    if (!r.thread || !r.message || typeof r.thread.id !== "string" ||
        typeof r.thread.repo !== "string" || typeof r.message.id !== "string" ||
        typeof r.message.text !== "string" || typeof r.message.at !== "string" ||
        !["repo","wake","system"].includes(r.message.from)) continue;
    const thread = threads.get(r.thread.id) ?? { ...r.thread, messages: [] };
    // A retry may replay the initial placeholder; keep the resolved interlocutor.
    if(r.thread.sessionId || !thread.sessionId)Object.assign(thread,r.thread);
    if (!thread.messages.some(m => m.id === r.message.id)) thread.messages.push(r.message);
    threads.set(thread.id, thread);
  }
  const replies = includeOwnerReplies ? readOwnerMessages(dataDir) ?? [] : [];
  for (const thread of threads.values()) {
    // The explicit conversation token identifies replies from the real Wake channel.
    for (const r of replies) {
      if (r.text.includes(thread.id) && !thread.messages.some(m => m.id === r.id))
        thread.messages.push({ id: r.id, at: r.createdAt, from: "wake", text: r.text });
    }
    thread.messages.sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
  }
  return [...threads.values()].sort((a,b) =>
    (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? ""));
}
