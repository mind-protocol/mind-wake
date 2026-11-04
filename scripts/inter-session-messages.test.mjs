import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extract, rankWindows, normalizeMessages } from "./inter-session-messages.mjs";

test("ignores human text and replayed Claude API request blobs", () => {
  assert.deepEqual(
    extract(
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ text: "Please use send_message" }] },
      },
      "codex",
      "a",
    ),
    [],
  );
  assert.deepEqual(
    extract(
      {
        type: "api-request-blob",
        message: {
          content: [{ type: "tool_use", name: "SendMessage", input: { message: "replayed" } }],
        },
      },
      "claude",
      "a",
    ),
    [],
  );
});
test("extracts native sends once when Claude stores both aliases", () => {
  const result = extract(
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "SendMessage",
            id: "x",
            input: { to: "b", message: "hello", content: "hello" },
          },
        ],
      },
    },
    "claude",
    "a",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "hello");
  assert.equal(result[0].recipient, "b");
});
test("recognizes namespaced Codex messages and initial delegation separately", () => {
  const call = (name, args) =>
    extract(
      {
        type: "response_item",
        payload: { type: "function_call", name, call_id: "x", arguments: JSON.stringify(args) },
      },
      "codex",
      "a",
    );
  assert.equal(
    call("collaboration.send_message", { target: "b", message: "hello" })[0].kind,
    "sent",
  );
  assert.equal(call("spawn_agent", { task_name: "b", message: "do this" })[0].kind, "delegation");
  assert.deepEqual(
    extract(
      {
        type: "response_item",
        payload: { type: "function_call", name: "send_input", arguments: "broken" },
      },
      "codex",
      "a",
    ),
    [],
  );
});
test("reads received teammate text but excludes protocol idle events", () => {
  const message = (body) =>
    extract(
      {
        type: "user",
        uuid: "x",
        message: { content: `<teammate-message teammate_id="a">${body}</teammate-message>` },
      },
      "claude",
      "b",
    );
  assert.equal(message("hello")[0].sender, "a");
  assert.deepEqual(message('{"type":"idle_notification"}'), []);
});
test("ranks actual sliding windows without counting any message twice", () => {
  const windows = rankWindows(
    [0, 1, 2, 50, 51].map((time) => ({ time })),
    10,
  );
  assert.equal(windows[0].count, 3);
  assert.equal(windows[1].count, 2);
  const selected = windows.flatMap((w) =>
    Array.from({ length: w.end - w.start }, (_, i) => w.start + i),
  );
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(rankWindows([], 10), []);
});
test("does not inflate counts when forks inherit parent events", () => {
  const base = {
    runtime: "codex",
    kind: "sent",
    text: "hello",
    eventId: "call-1",
    source: "parent",
    line: 1,
    time: 100,
  };
  const result = normalizeMessages([base, { ...base, source: "child", sender: "child" }]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(
    normalizeMessages([base, { ...base, eventId: "call-2", time: 200 }]).messages.length,
    2,
  );
});
test("identifies encrypted content and only collapses matching nearby deliveries", () => {
  const base = {
    runtime: "codex",
    kind: "sent",
    text: "hello",
    eventId: "x",
    source: "parent",
    line: 1,
    time: 100,
  };
  const result = normalizeMessages([
    base,
    { ...base, kind: "received", eventId: "y", time: 200 },
    { ...base, kind: "received", eventId: "z", time: 300000 },
  ]);
  assert.equal(result.messages.length, 2);
  assert.equal(
    normalizeMessages([{ ...base, text: "gAAAA" + "x".repeat(100) }]).messages[0].encrypted,
    true,
  );
});

test("CLI preserves sources, skips inherited history and produces separate readable exports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inter-session-test-"));
  try {
    const codex = path.join(dir, "codex"),
      claude = path.join(dir, "claude"),
      out = path.join(dir, "out");
    fs.mkdirSync(codex);
    fs.mkdirSync(claude);
    const at = "2026-01-01T12:00:00Z";
    const meta = { timestamp: at, type: "session_meta", payload: { id: "parent", timestamp: at } };
    const call = {
      timestamp: at,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "send_message",
        call_id: "x",
        arguments: JSON.stringify({ target: "b", message: "hello" }),
      },
    };
    const raw = [
      meta,
      call,
      {
        ...call,
        payload: {
          ...call.payload,
          call_id: "encrypted",
          arguments: JSON.stringify({ target: "b", message: "gAAAA" + "x".repeat(100) }),
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n");
    const source = path.join(codex, "parent.jsonl");
    fs.writeFileSync(source, raw);
    fs.writeFileSync(
      path.join(codex, "child.jsonl"),
      [{ ...meta, payload: { id: "child", timestamp: "2026-01-01T12:01:00Z" } }, call]
        .map(JSON.stringify)
        .join("\n"),
    );
    fs.writeFileSync(
      path.join(claude, "session.jsonl"),
      JSON.stringify({
        timestamp: at,
        type: "assistant",
        sessionId: "c",
        message: {
          content: [
            {
              type: "tool_use",
              name: "SendMessage",
              id: "y",
              input: { to: "d", message: "world" },
            },
          ],
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        new URL("./inter-session-messages.mjs", import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/,
          "$1",
        ),
        "--codex-root",
        codex,
        "--claude-root",
        claude,
        "--out",
        out,
        "--top",
        "2",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.equal(summary.total, 3);
    assert.equal(summary.encrypted, 1);
    assert.equal(summary.readableTop, 2);
    const readable = fs.readFileSync(path.join(out, "top-2-readable.jsonl"), "utf8");
    assert.match(readable, /hello/);
    assert.match(readable, /world/);
    assert.doesNotMatch(readable, /gAAAA/);
    assert.equal(fs.readFileSync(source, "utf8"), raw);
    assert.equal(fs.readFileSync(path.join(out, ".gitignore"), "utf8"), "*\n");
  } finally {
    // Only remove the exact test-owned directory returned by mkdtemp.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
