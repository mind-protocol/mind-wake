import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nodeScriptArgs } from "../cli/script-entry.js";
import { readOwnerInboxHistory, type InboxMessage } from "./owner-inbox.js";
import { recordClaudePrincipalEdit, type PrincipalEditor } from "./principal-file-editor.js";
import { workspaceDirFor } from "../daemon/paths.js";

export interface HolderLiveInbox { dataDir: string; stateFile: string; sessionId: string; editor?: PrincipalEditor }

/** Read the human stream without claiming or consuming the principal's delivery queue. */
export function holderHumanMessages(dataDir: string): InboxMessage[] {
  const inbox = readOwnerInboxHistory(dataDir);
  const known = new Set(inbox.map(message => message.id));
  const messages = inbox.filter(message => !message.origin);
  const file = path.join(dataDir, "human-messages.jsonl");
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const item = JSON.parse(line) as Partial<InboxMessage>;
      if (typeof item.id !== "string" || typeof item.at !== "string" || typeof item.text !== "string" || known.has(item.id)) continue;
      known.add(item.id);
      if (!item.origin) messages.push({ id: item.id, at: item.at, text: item.text });
    } catch { /* A partial last line is retried on the next poll. */ }
  }
  return messages;
}

export function createHolderLiveInbox(dataDir: string, directory: string, initialIds: readonly string[], editor?: PrincipalEditor): HolderLiveInbox {
  const sessionId = randomUUID();
  fs.mkdirSync(directory, { recursive: true });
  const stateFile = path.join(directory, `inbox-${sessionId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(initialIds));
  return { dataDir, stateFile, sessionId, ...(editor ? { editor } : {}) };
}

/** The cursor belongs to one holder passage. Codex confirms only after a valid steer ack. */
export function prepareHolderLiveInbox(input: HolderLiveInbox): { context: string; confirm: () => void } | null {
  const seen = new Set(JSON.parse(fs.readFileSync(input.stateFile, "utf8")) as string[]);
  const fresh = holderHumanMessages(input.dataDir).filter(message => !seen.has(message.id));
  if (!fresh.length) return null;
  const context = "Nouveaux messages de ton humain, reçus pendant ce passage. Prends-les en compte maintenant dans ton travail sur les fichiers, sans publier de réponse.\n\n" +
    fresh.map(message => `[Humain — ${message.at} — ${message.id}]\n${message.text}`).join("\n\n");
  return { context, confirm: () => {
    const current = new Set(JSON.parse(fs.readFileSync(input.stateFile, "utf8")) as string[]);
    for (const message of fresh) current.add(message.id);
    fs.writeFileSync(input.stateFile, JSON.stringify([...current]));
  } };
}

export function holderLiveHook(input: HolderLiveInbox, event: unknown): object | null {
  if (!event || typeof event !== "object") return null;
  const frame = event as Record<string, unknown>;
  if (frame["session_id"] !== input.sessionId || frame["agent_id"] !== undefined) return null;
  if (input.editor) recordClaudePrincipalEdit(workspaceDirFor(input.dataDir), frame, input.editor);
  const name = frame["hook_event_name"];
  if (!["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop"].includes(String(name))) return null;
  const batch = prepareHolderLiveInbox(input);
  if (!batch) return null;
  batch.confirm();
  return name === "Stop" ? { decision: "block", reason: batch.context }
    : { hookSpecificOutput: { hookEventName: name, additionalContext: batch.context } };
}

export function holderLiveClaudeArgs(args: readonly string[], inbox: HolderLiveInbox): string[] {
  const compiled = fileURLToPath(new URL("./holder-live-inbox.js", import.meta.url));
  const script = nodeScriptArgs(compiled) ?? [compiled];
  const hook = { type: "command", command: process.execPath,
    args: [...script, "--holder-live-inbox", inbox.dataDir, inbox.stateFile, inbox.sessionId, ...(inbox.editor ? [JSON.stringify(inbox.editor)] : [])] };
  const next = [...args, "--session-id", inbox.sessionId];
  next[next.indexOf("--settings") + 1] = JSON.stringify({ disableAllHooks: false,
    hooks: Object.fromEntries(["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop"].map(name => [name, [{ hooks: [hook] }]])) });
  // Only the host injection hook is enabled, not hooks inherited from user/project settings.
  next[next.indexOf("--setting-sources") + 1] = "";
  return next;
}

if (process.argv.includes("--holder-live-inbox")) {
  try {
    const offset = process.argv.indexOf("--holder-live-inbox");
    const [dataDir, stateFile, sessionId, editorJson] = process.argv.slice(offset + 1);
    if (!dataDir || !stateFile || !sessionId) throw Error("Missing holder inbox arguments");
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const result = holderLiveHook({ dataDir, stateFile, sessionId, ...(editorJson ? { editor: JSON.parse(editorJson) as PrincipalEditor } : {}) }, JSON.parse(stdin) as unknown);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`Holder inbox injection failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
