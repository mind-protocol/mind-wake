#!/usr/bin/env node
// Local, read-only extraction of native Codex / Claude inter-agent exchanges.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export function extract(o, runtime, session) {
  const p = o.payload ?? o;
  const out = [];
  const add = (kind, text, recipient, id, sender = session) => {
    if (typeof text === "string" && text.trim())
      out.push({ kind, text, sender, recipient: recipient ?? null, eventId: id ?? null });
  };
  if (runtime === "codex" && o.type === "response_item") {
    const name = (p.name ?? "").split(".").at(-1);
    if (
      ["function_call", "custom_tool_call"].includes(p.type) &&
      ["send_message", "send_input", "followup_task", "spawn_agent"].includes(name)
    ) {
      let a;
      try {
        a = JSON.parse(p.arguments ?? p.input);
      } catch {
        return out;
      }
      add(
        name === "spawn_agent" ? "delegation" : "sent",
        a.message ?? a.task ?? (typeof a.input === "string" ? a.input : null),
        a.target ?? a.id ?? a.task_name,
        p.call_id,
      );
    }
    if (p.type === "message" && ["user", "developer"].includes(p.role)) {
      for (const b of p.content ?? []) {
        const text = b.text ?? "";
        if (/^\s*<subagent_notification\b/.test(text)) {
          const m = text.match(
            /^\s*<subagent_notification\b([^>]*)>([\s\S]*?)<\/subagent_notification>\s*$/,
          );
          if (m) {
            let body = m[2];
            try {
              const j = JSON.parse(body);
              body = j.result ?? j.message ?? body;
            } catch {}
            add(
              "received",
              body,
              session,
              p.id,
              m[1].match(/agent_id="([^"]+)"/)?.[1] ?? "subagent",
            );
          }
        } else if (/^\s*Message Type: (MESSAGE|FINAL_ANSWER)\s*\n/.test(text)) {
          add(
            "received",
            text
              .split(/\nPayload:\s*\n/)
              .slice(1)
              .join("\nPayload:\n"),
            session,
            p.id,
            text.match(/\nSender:\s*([^\n]+)/)?.[1] ?? "agent",
          );
        }
      }
    }
  }
  if (runtime === "claude") {
    if (o.type === "assistant")
      for (const b of o.message?.content ?? []) {
        if (b.type === "tool_use" && b.name === "SendMessage") {
          const a = b.input ?? {};
          add("sent", a.message ?? a.content, a.to ?? a.recipient, b.id);
        }
      }
    if (o.type === "user") {
      const content = o.message?.content;
      const blocks =
        typeof content === "string" ? [{ text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        const text = b.text ?? "";
        if (!/^\s*<teammate-message\b/.test(text)) continue;
        for (const m of text.matchAll(
          /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g,
        )) {
          // Idle/shutdown protocol notifications are not conversational messages.
          let body = m[2];
          try {
            const j = JSON.parse(body);
            if (j.type) continue;
          } catch {}
          add(
            "received",
            body,
            session,
            o.uuid,
            m[1].match(/teammate_id="([^"]+)"/)?.[1] ?? "teammate",
          );
        }
      }
    }
  }
  return out;
}

export function rankWindows(messages, windowMs) {
  const ranked = [];
  let end = 0;
  for (let start = 0; start < messages.length; start++) {
    while (end < messages.length && messages[end].time < messages[start].time + windowMs) end++;
    ranked.push({ start, end, count: end - start });
  }
  ranked.sort((a, b) => b.count - a.count || messages[b.start].time - messages[a.start].time);
  // Greedy selection of non-overlapping windows, highest message count first.
  const selected = [];
  for (const w of ranked)
    if (!selected.some((s) => w.start < s.end && s.start < w.end)) selected.push(w);
  return selected;
}

export function normalizeMessages(messages) {
  const seen = new Set();
  let duplicates = 0;
  const deduped = messages
    .filter((m) => {
      const key = JSON.stringify([m.runtime, m.eventId ?? [m.source, m.line], m.kind, m.text]);
      if (seen.has(key)) {
        duplicates++;
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((m) => ({ ...m, encrypted: /^gAAAA[A-Za-z0-9_=-]{40,}$/.test(m.text.trim()) }));
  deduped.sort((a, b) => a.time - b.time || a.source.localeCompare(b.source) || a.line - b.line);
  const sends = new Map();
  for (const m of deduped)
    if (m.kind !== "received") {
      const key = m.runtime + "\0" + m.text.trim();
      if (!sends.has(key)) sends.set(key, []);
      sends.get(key).push(m.time);
    }
  const unique = deduped.filter((m) => {
    const duplicate =
      m.kind === "received" &&
      sends.get(m.runtime + "\0" + m.text.trim())?.some((t) => Math.abs(t - m.time) <= 120000);
    if (duplicate) duplicates++;
    return !duplicate;
  });
  return { messages: unique, duplicates };
}

async function* walk(root) {
  if (!fs.existsSync(root)) return;
  for (const e of await fs.promises.readdir(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(f);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield f;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const top = Number(option("--top", "500"));
  const minutes = Number(option("--window-minutes", "15"));
  if (!Number.isInteger(top) || top < 1 || !Number.isFinite(minutes) || minutes <= 0)
    throw Error("Invalid --top / --window-minutes");
  const output = path.resolve(option("--out", "artifacts/inter-session-messages"));
  const roots = [
    ["codex", option("--codex-root", path.join(os.homedir(), ".codex", "sessions"))],
    ["claude", option("--claude-root", path.join(os.homedir(), ".claude", "projects"))],
  ];
  if (!args.includes("--codex-root"))
    roots.push(["codex", path.join(os.homedir(), ".codex", "archived_sessions")]);
  const messages = [];
  const stats = {
    files: 0,
    lines: 0,
    candidates: 0,
    malformed: 0,
    invalidDates: 0,
    duplicates: 0,
    roots,
  };
  const cached = option("--from", null);
  if (cached) {
    stats.cachedFrom = path.resolve(cached);
    for await (const line of readline.createInterface({
      input: fs.createReadStream(cached),
      crlfDelay: Infinity,
    })) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
    stats.inputEvents = messages.length;
  } else
    for (const [runtime, root] of roots) {
      for await (const file of walk(root)) {
        stats.files++;
        let lineNumber = 0;
        let session = path.basename(file, ".jsonl");
        let createdAt = -Infinity;
        const size = (await fs.promises.stat(file)).size;
        if (!size) continue;
        // Bound each read: an active session may append while this scan runs.
        for await (const line of readline.createInterface({
          input: fs.createReadStream(file, { end: size - 1 }),
          crlfDelay: Infinity,
        })) {
          lineNumber++;
          stats.lines++;
          if (runtime === "codex" && lineNumber === 1) {
            try {
              const meta = JSON.parse(line);
              session = meta.payload?.id ?? session;
              const start = Date.parse(meta.payload?.timestamp ?? meta.timestamp);
              if (Number.isFinite(start)) createdAt = start;
            } catch {}
          }
          if (
            !/send_message|send_input|followup_task|spawn_agent|SendMessage|teammate-message|subagent_notification|Message Type: (?:MESSAGE|FINAL_ANSWER)/.test(
              line,
            )
          )
            continue;
          stats.candidates++;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            stats.malformed++;
            continue;
          }
          const time = Date.parse(o.timestamp ?? o.at ?? "");
          // A child's inherited parent history is evidence of the parent's events.
          // Its original file owns the attribution; do not label it as child work.
          if (runtime === "codex" && Number.isFinite(time) && time < createdAt) continue;
          for (const m of extract(o, runtime, o.sessionId ?? session)) {
            if (!Number.isFinite(time)) {
              stats.invalidDates++;
              continue;
            }
            messages.push({
              ...m,
              runtime,
              time,
              at: new Date(time).toISOString(),
              source: file,
              line: lineNumber,
            });
          }
        }
        if (stats.files % 500 === 0)
          console.error(`${stats.files} files; ${messages.length} messages`);
      }
    }
  const normalized = normalizeMessages(messages);
  const unique = normalized.messages;
  stats.duplicates += normalized.duplicates;
  const windows = rankWindows(unique, minutes * 60000);
  const clusters = windows.map((w, i) => ({
    rank: i + 1,
    count: w.count,
    readable: unique.slice(w.start, w.end).filter((m) => !m.encrypted).length,
    start: unique[w.start].at,
    end: unique[w.end - 1].at,
    perMinute: +(w.count / minutes).toFixed(2),
    runtimes: [...new Set(unique.slice(w.start, w.end).map((m) => m.runtime))],
  }));
  const chosen = [];
  for (let i = 0; i < windows.length && chosen.length < top; i++)
    for (const m of unique.slice(windows[i].start, windows[i].end)) {
      if (chosen.length >= top) break;
      chosen.push({ ...m, clusterRank: i + 1 });
    }
  const readable = [];
  for (let i = 0; i < windows.length && readable.length < top; i++)
    for (const m of unique.slice(windows[i].start, windows[i].end)) {
      if (readable.length >= top) break;
      if (!m.encrypted) readable.push({ ...m, clusterRank: i + 1 });
    }
  const counts = {};
  for (const m of unique) {
    const k = m.runtime + ":" + m.kind;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const summary = {
    ...stats,
    total: unique.length,
    counts,
    encrypted: unique.filter((m) => m.encrypted).length,
    top: chosen.length,
    topEncrypted: chosen.filter((m) => m.encrypted).length,
    readableTop: readable.length,
    windowMinutes: minutes,
    selection:
      "Non-overlapping rolling windows ranked by message count, then most recent. Messages chronological within each window. Delegation included; ordinary user/assistant messages excluded. Event IDs deduplicated across forks; exact send/delivery duplicates within 120s removed; semantic duplicates may remain.",
    generatedAt: new Date().toISOString(),
    clusters: clusters.length,
  };
  await fs.promises.mkdir(output, { recursive: true });
  // Conversation exports stay local even if the surrounding checkout is published.
  await fs.promises.writeFile(path.join(output, ".gitignore"), "*\n");
  const jsonl = (xs) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const topName = `top-${top}`;
  await fs.promises.writeFile(path.join(output, "messages.jsonl"), jsonl(unique));
  await fs.promises.writeFile(path.join(output, `${topName}.jsonl`), jsonl(chosen));
  await fs.promises.writeFile(path.join(output, `${topName}-readable.jsonl`), jsonl(readable));
  await fs.promises.writeFile(
    path.join(output, "clusters.json"),
    JSON.stringify(clusters, null, 2),
  );
  await fs.promises.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  const markdown = (xs) =>
    xs
      .map(
        (m, i) =>
          `## ${i + 1}. ${m.at} — ${m.runtime} — cluster ${m.clusterRank}\n\n${m.kind}: ${m.sender} → ${m.recipient ?? "?"}\n\n${m.encrypted ? "[Corps chiffré dans le journal local ; contenu non lu.]" : m.text}\n\nSource: ${m.source}:${m.line}\n`,
      )
      .join("\n");
  await fs.promises.writeFile(
    path.join(output, `${topName}.md`),
    "# Messages intersessions — périodes les plus actives\n\n" +
      summary.selection +
      "\n\n" +
      markdown(chosen),
  );
  await fs.promises.writeFile(
    path.join(output, `${topName}-readable.md`),
    "# Messages intersessions lisibles — périodes les plus actives\n\nMême classement des périodes, en sautant les corps chiffrés.\n\n" +
      markdown(readable),
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(clusters.slice(0, 10), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
