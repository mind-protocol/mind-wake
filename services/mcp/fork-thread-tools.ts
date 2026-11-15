/**
 * Envoi explicite d'un message signé dans le fil d'un fork (demande NLR du 6 novembre 2026).
 * Rien ne part automatiquement : seul un appel à `post_to_fork_thread` ajoute un message.
 * Le message entre dans le fil comme message entrant étiqueté (notice) : visible à l'écran
 * sous sa signature, et lu par le fork à son prochain tour, ou en cours de tour.
 */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { forkDir } from "../../src/daemon/forks.js";
import { SecondThreadStore } from "../../src/daemon/second-thread.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { controlDbPath } from "../../src/daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";

export const FORK_THREAD_SIGNATURES = ["Principal", "Simulation NLR"] as const;
export type ForkThreadSignature = (typeof FORK_THREAD_SIGNATURES)[number];

/** Écrit le message signé ; une même clé ne crée qu'un message. */
export function postToForkThread(
  dataDir: string,
  input: { fork: number; text: string; signature: ForkThreadSignature; idempotencyKey: string },
): { status: "recorded" | "duplicate"; entryId: number; fork: number; label: string } {
  const text = input.text.trim();
  if (text === "" || text.length > 4000) throw Error("Message vide ou trop long (4000 caractères au plus).");
  const dir = forkDir(dataDir, input.fork);
  if (!fs.existsSync(dir)) throw Error(`Fork ${String(input.fork)} introuvable.`);
  const control = openStoreReadOnly(controlDbPath(dataDir));
  try {
    const profile = control.uow.profiles.get(DEFAULT_PROFILE_ID);
    if (!profile || profile.emergencyStopLocked || ["paused", "stopped", "disabled"].includes(profile.state))
      throw Error("Wake est en pause ou arrêté : aucun message n'est envoyé.");
  } finally {
    control.close();
  }
  const store = new SecondThreadStore(dir);
  try {
    const key = `post:${input.signature === "Principal" ? "principal" : "nlr"}:${input.idempotencyKey}`;
    const result = store.addNoticeOnce(key, text, input.signature);
    return { ...result, fork: input.fork, label: input.signature };
  } finally {
    store.close();
  }
}

export function registerForkThreadTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) return;
  server.registerTool(
    "post_to_fork_thread",
    {
      description:
        "Post one signed message into a fork's thread (e.g. Fork 7 / VOX). Nothing you write elsewhere is sent automatically: only this call adds a message. It appears on screen under your signature and the fork reads it as an incoming message on its next turn. Use a stable idempotency_key so a retry does not post twice. Not for the human's main thread.",
      inputSchema: z.strictObject({
        fork: z.number().int().min(2).max(8),
        text: z.string().min(1).max(4000),
        signature: z.enum(FORK_THREAD_SIGNATURES),
        idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/),
      }),
      annotations: { openWorldHint: false },
    },
    (a) => {
      try {
        const result = postToForkThread(dataDir, {
          fork: a.fork,
          text: a.text,
          signature: a.signature,
          idempotencyKey: a.idempotency_key,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            },
          ],
        };
      }
    },
  );
}
