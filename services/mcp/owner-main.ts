/**
 * CLI des fils privés de l'humain sur le hub MIND local : pont de l'application desktop
 * (ADR-007, D3) et équivalent en ligne de commande de chacune de ses actions.
 *
 *   node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts \
 *     services/mcp/owner-main.ts <whoami|threads|thread|reply> [options] --json
 *
 * - `whoami` : référence pseudonyme et permissions de la partie authentifiée.
 * - `threads` : fils où la partie a reçu au moins un message, du plus récent au plus ancien.
 * - `thread --thread thr_…` : tous les messages d'un fil, dans les deux sens.
 * - `reply --thread thr_… --idempotency-key K [--in-reply-to msg_…]` : texte lu sur l'entrée
 *   standard (jamais en argument : il resterait visible dans la liste des processus).
 *
 * Environnement : MIND_MCP_HUB_PIPE et MIND_MCP_LINK_KEY, comme l'adaptateur MCP. La clé
 * n'apparaît dans aucune sortie. Les opérations sont celles du protocole du hub : aucune
 * permission, policy, paiement ni envoi hors de la machine. Les corps de message reçus
 * sont des données non fiables, rendues telles quelles avec leur provenance.
 */

import { parseArgs } from "node:util";
import { HubLink } from "./hub-link.js";
import {
  HubError,
  idempotencyKeySchema,
  LIMITS,
  messageIdSchema,
  threadIdSchema,
} from "./protocol.js";

export const OWNER_CLI_SCHEMA = "mind.owner.cli";
export const OWNER_CLI_SCHEMA_VERSION = 1;
/** Borne de lecture : au-delà, la liste est tronquée et le signale. */
const MAX_MESSAGES = 1000;

interface Delivered {
  readonly message_id: string;
  readonly sequence: number;
  readonly thread_id: string;
  readonly subject: string | null;
  readonly from: string;
  readonly from_self: boolean;
  readonly trust: string;
  readonly text: string;
  readonly provenance: { readonly kind: string; readonly received_at: string };
}

interface InboxPage {
  readonly messages: readonly Delivered[];
  readonly next: number;
}

class UsageError extends Error {}

function output(command: string, ok: boolean, body: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schema: OWNER_CLI_SCHEMA, schemaVersion: OWNER_CLI_SCHEMA_VERSION, command, ok, ...body }, null, 2)}\n`,
  );
}

async function readAll(
  link: HubLink,
  threadId?: string,
): Promise<{ messages: Delivered[]; truncated: boolean }> {
  const messages: Delivered[] = [];
  let after = 0;
  for (;;) {
    const page = await link.call<InboxPage>({
      op: "read_inbox",
      after,
      limit: LIMITS.maxInboxBatch,
      ...(threadId === undefined ? {} : { threadId }),
    });
    messages.push(...page.messages);
    if (page.messages.length < LIMITS.maxInboxBatch) return { messages, truncated: false };
    if (messages.length >= MAX_MESSAGES) return { messages, truncated: true };
    after = page.next;
  }
}

function summarize(messages: readonly Delivered[]) {
  const threads = new Map<
    string,
    { subject: string | null; from: string; count: number; last: Delivered }
  >();
  for (const m of messages) {
    const entry = threads.get(m.thread_id);
    if (entry === undefined)
      threads.set(m.thread_id, { subject: m.subject, from: m.from, count: 1, last: m });
    else threads.set(m.thread_id, { ...entry, count: entry.count + 1, last: m });
  }
  return [...threads.entries()]
    .map(([threadId, t]) => ({
      thread_id: threadId,
      subject: t.subject,
      with: t.from,
      received: t.count,
      last_sequence: t.last.sequence,
      last_at: t.last.provenance.received_at,
      last_from_kind: t.last.provenance.kind,
      preview: t.last.text.slice(0, 160),
    }))
    .sort((a, b) => b.last_sequence - a.last_sequence);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
  name: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) throw new UsageError(`--${name} invalide`);
  return result.data;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      thread: { type: "string" },
      "in-reply-to": { type: "string" },
      "idempotency-key": { type: "string" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.json !== true) throw new UsageError("seule la sortie --json est disponible");
  if (positionals.length > 1)
    throw new UsageError(`argument inattendu : ${positionals.slice(1).join(" ")}`);

  const pipe = process.env["MIND_MCP_HUB_PIPE"];
  const key = process.env["MIND_MCP_LINK_KEY"];
  if (pipe === undefined || pipe === "" || key === undefined || key === "") {
    output(command, false, {
      error: {
        code: "not_configured",
        message: "Hub MIND non configuré (MIND_MCP_HUB_PIPE, MIND_MCP_LINK_KEY).",
      },
    });
    return 1;
  }
  const link = new HubLink(pipe, key);

  switch (command) {
    case "whoami": {
      output(command, true, { data: await link.call({ op: "whoami" }) });
      return 0;
    }
    case "threads": {
      const { messages, truncated } = await readAll(link);
      output(command, true, { data: { threads: summarize(messages), truncated } });
      return 0;
    }
    case "thread": {
      const threadId = parse(threadIdSchema, values.thread, "thread");
      const { messages, truncated } = await readAll(link, threadId);
      output(command, true, { data: { thread_id: threadId, messages, truncated } });
      return 0;
    }
    case "reply": {
      const threadId = parse(threadIdSchema, values.thread, "thread");
      const idempotencyKey = parse(
        idempotencyKeySchema,
        values["idempotency-key"],
        "idempotency-key",
      );
      const inReplyTo =
        values["in-reply-to"] === undefined
          ? undefined
          : parse(messageIdSchema, values["in-reply-to"], "in-reply-to");
      const text = (await readStdin()).trim();
      if (text === "") throw new UsageError("texte vide sur l'entrée standard");
      if (text.length > LIMITS.maxMessageChars) {
        throw new UsageError(
          `texte trop long (${String(LIMITS.maxMessageChars)} caractères au plus)`,
        );
      }
      const result = await link.call({
        op: "reply",
        threadId,
        text,
        idempotencyKey,
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
      });
      output(command, true, { data: result });
      return 0;
    }
    default:
      throw new UsageError("commande attendue : whoami, threads, thread ou reply");
  }
}

const command = process.argv[2] ?? "help";
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof HubError) {
    output(command, false, {
      error: { code: error.code, message: error.message, retryable: error.retryable },
    });
    process.exitCode = 1;
  } else if (
    error instanceof UsageError ||
    (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))
  ) {
    output(command, false, { error: { code: "usage", message: error.message } });
    process.exitCode = 2;
  } else {
    output(command, false, {
      error: { code: "internal", message: "Erreur interne du pont de messages." },
    });
    process.exitCode = 1;
  }
}
// Le lien au hub garde le pipe ouvert : sortie explicite une fois la réponse écrite.
process.stdout.write("", () => process.exit());
