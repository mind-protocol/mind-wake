/**
 * CLI des fils de l'humain (`services/mcp/owner-main.ts`), pont de l'application desktop :
 * vrai hub, vrai client MCP de l'agent, CLI en processus séparé. Fils, lecture dans les
 * deux sens, réponse lue sur l'entrée standard, idempotence, clé absente des sorties.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idem,
  MCP_DIR,
  minimalEnv,
  NODE_ARGS,
  startHarness,
  type Harness,
  type PartyClient,
} from "./harness.js";

const TIMEOUT = 60_000;
const OWNER_MAIN = join(MCP_DIR, "owner-main.ts");

let h: Harness;
let agent: PartyClient;
let ownerRef: string;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly json: Record<string, unknown> & { data?: Record<string, unknown> };
}

function owner(
  args: readonly string[],
  input = "",
  env: Record<string, string> | null = null,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, OWNER_MAIN, ...args, "--json"], {
      env: env ?? { ...minimalEnv(), MIND_MCP_HUB_PIPE: h.pipe, MIND_MCP_LINK_KEY: h.keys.guide },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, json: JSON.parse(stdout) as Run["json"] });
    });
    child.stdin.end(input);
  });
}

beforeAll(async () => {
  h = await startHarness();
  agent = await h.party("agent");
  ownerRef = String((await owner(["whoami"])).json.data?.["ref"]);
}, TIMEOUT);

afterAll(async () => {
  await h.close();
}, TIMEOUT);

describe("fils de l'humain par la CLI", { timeout: TIMEOUT }, () => {
  it("liste le fil ouvert par l'agent, le lit et y répond ; l'agent reçoit la réponse humaine", async () => {
    const sent = await agent.call("send_message", {
      to: ownerRef,
      subject: "Une idée pour ton jardin",
      text: "J'ai trouvé une autre façon de faire bouger les plantes. Je te montre ?",
      idempotency_key: idem(),
    });
    const threadId = String(sent.data["thread_id"]);

    const threads = await owner(["threads"]);
    expect(threads.json).toMatchObject({ schema: "mind.owner.cli", schemaVersion: 1, ok: true });
    const listed = (threads.json.data?.["threads"] as Record<string, unknown>[]).find(
      (t) => t["thread_id"] === threadId,
    );
    expect(listed).toMatchObject({
      subject: "Une idée pour ton jardin",
      received: 1,
      last_from_kind: "agent",
    });

    const thread = await owner(["thread", "--thread", threadId]);
    const messages = thread.json.data?.["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ trust: "untrusted_party_content", from_self: false });

    const key = idem("ui");
    const args = [
      "reply",
      "--thread",
      threadId,
      "--idempotency-key",
      key,
      "--in-reply-to",
      String(messages[0]?.["message_id"]),
    ];
    const replied = await owner(args, "Oui, montre-moi.\n");
    expect(replied.code).toBe(0);
    const again = await owner(args, "Oui, montre-moi.\n");
    expect(again.json.data).toMatchObject({
      duplicate: true,
      message_id: replied.json.data?.["message_id"],
    });

    const seen = await agent.call("read_inbox", { thread_id: threadId });
    const received = seen.data["messages"] as Record<string, unknown>[];
    expect(received.map((m) => m["text"])).toEqual([
      "J'ai trouvé une autre façon de faire bouger les plantes. Je te montre ?",
      "Oui, montre-moi.",
    ]);
    expect(received[1]).toMatchObject({ provenance: { kind: "human" } });
  });

  it("refus explicites : texte vide, fil inconnu, hub non configuré ; jamais de clé en sortie", async () => {
    const empty = await owner(
      ["reply", "--thread", "thr_inconnu123", "--idempotency-key", idem()],
      "  ",
    );
    expect(empty.code).toBe(2);
    expect(empty.json).toMatchObject({ ok: false, error: { code: "usage" } });

    const unknown = await owner(["thread", "--thread", "thr_inconnu123"]);
    expect(unknown.json).toMatchObject({ ok: false, error: { code: "unknown_reference" } });

    const bare = await owner(["threads"], "", minimalEnv());
    expect(bare.json).toMatchObject({ ok: false, error: { code: "not_configured" } });

    for (const run of [empty, unknown, bare]) expect(run.stdout).not.toContain(h.keys.guide);
  });
});
