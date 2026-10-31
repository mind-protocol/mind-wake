import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConversationStore } from "./store.js";
import { inspectConversationRuntime } from "./role-runtime.js";
import { enableConversationMode, inspectConversationMode } from "./mode.js";
import { workerAlive } from "./worker.js";
import { processContext } from "../cli/context.js";
import { reactivate } from "../cli/commands/reactivate.js";
import { resume } from "../cli/commands/resume.js";
import { openStore } from "../cli/store/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";
import { decideActivation } from "../policy/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import { StopFlag } from "../runner/controls.js";
import type { UtcTimestamp } from "../contracts/index.js";

const ACTIONS = ["submit", "read", "edit", "stop", "resume", "activate", "events"];
export async function launchWorker(dataDir: string, conversationId: string): Promise<void> {
  if (await workerAlive(dataDir, conversationId)) return;
  const entry = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./owner.ts" : "./owner.js", import.meta.url),
  );
  const args = entry.endsWith(".ts")
    ? [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        pathToFileURL(
          fileURLToPath(new URL("../../test/fixtures/store-ledger/ts-hooks.ts", import.meta.url)),
        ).href,
        entry,
      ]
    : [entry];
  const log = fs.openSync(path.join(dataDir, "conversation-worker.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [...args, "--data-dir", dataDir, "--conversation", conversationId],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
        env: process.env,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

const required = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw Error(`Missing ${key}`);
  return value;
};
const number = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error(`Invalid ${key}`);
  return Number(value);
};
export async function conversationCommand(
  dataDir: string,
  action: string,
  input: Record<string, unknown>,
  options: {
    launch?: (dir: string, id: string) => Promise<void>;
    allow?: () => boolean;
    enableMode?: (dir: string) => Promise<unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  if (!ACTIONS.includes(action)) throw Error("Unknown conversation action");
  const conversationId =
    typeof input["conversationId"] === "string" ? input["conversationId"] : "main";
  const store = new ConversationStore(dataDir);
  try {
    store.createConversation(conversationId);
    const current = () => {
      const state = store.current(conversationId);
      if (!state) throw Error("Unknown conversation");
      return state;
    };
    const expected = number(input, "expectedRevision");
    if (action === "submit")
      store.submit(
        conversationId,
        required(input, "text"),
        required(input, "idempotencyKey"),
        expected,
      );
    if (action === "edit") {
      if (expected !== undefined && current().revision !== expected)
        throw Error("Conversation revision changed");
      if (typeof input["previewCallId"] === "string")
        store.editPreview(
          conversationId,
          input["previewCallId"],
          required(input, "text"),
          expected ?? -1,
        );
      else
        store.editMessage(
          conversationId,
          required(input, "messageId"),
          required(input, "text"),
          number(input, "expectedVersion") ?? 0,
        );
    }
    if (action === "stop") store.stopConversation(conversationId);
    if (action === "activate") {
      await (options.enableMode ?? enableConversationMode)(dataDir);
      // This branch is a dedicated, explicit human action. Submission/read never lift a stop.
      const ctx = processContext(),
        dir = { path: dataDir, source: "option" as const };
      const control = openStore(dataDir, "read");
      let profile;
      try {
        profile = control.uow.profiles.get(DEFAULT_PROFILE_ID);
      } finally {
        control.close();
      }
      if (!profile) throw Error("Profil absent : configurer le fournisseur avant activation.");
      if (profile.emergencyStopLocked || profile.state === "stopped") {
        const result = reactivate(ctx, dir);
        if (result.exitCode !== 0) throw Error(result.data.detail);
      } else if (profile.state === "paused") {
        const result = resume(ctx, dir);
        if (result.exitCode !== 0) throw Error(result.data.detail);
      } else if (profile.state === "blocked") {
        if (new StopFlag(dataDir).exists())
          throw Error("Un arrêt d’urgence est encore en attente de réconciliation.");
        const write = openStore(dataDir, "write");
        try {
          write.uow.transaction((tx) => {
            const p = tx.profiles.get(DEFAULT_PROFILE_ID);
            if (
              !p ||
              p.state !== "blocked" ||
              p.emergencyStopLocked ||
              tx.sessions.listOpen(p.id).length
            )
              throw Error("Le contrôle du profil a changé pendant l’activation.");
            const decision = decideActivation(tx.policies, p.id);
            if (decision.verdict !== "allow") throw Error(decision.detail);
            const at = new Date().toISOString() as UtcTimestamp,
              reason =
                "Activation humaine du mode conversation après arrêt vérifié de l’ancien moteur";
            tx.profiles.transition(p.id, { from: "blocked", to: "ready", at, reason });
            tx.profiles.setNextWake(p.id, null);
            tx.journal.append(
              prepareJournalEvent({
                type: "profile_state_changed",
                profileId: p.id,
                at,
                reason,
                metadata: { from: "blocked", to: "ready", mode: "conversation" },
              }),
            );
          });
        } finally {
          write.close();
        }
      }
    }
    if (action === "resume" || action === "activate") {
      if (action === "resume" && !options.allow) {
        const state = inspectConversationRuntime(dataDir);
        if (!state.allowed && state.reason === "profile_paused") {
          const result = resume(processContext(), { path: dataDir, source: "option" });
          if (result.exitCode !== 0) throw Error(result.data.detail);
        }
      }
      const gate = options.allow
        ? { allowed: options.allow() }
        : inspectConversationRuntime(dataDir);
      if (!gate.allowed)
        throw Error(
          "Le contrôle du profil refuse la reprise ; utiliser l’activation humaine explicite après un arrêt global.",
        );
      store.resumeConversation(conversationId, expected);
      store.appendEvent({
        conversationId,
        revision: current().revision,
        kind: "cycle_resume_requested",
        text: "Reprise explicitement demandée par l’humain.",
      });
    }
    const inspection = options.allow
      ? { allowed: options.allow() }
      : inspectConversationRuntime(dataDir);
    if (
      ["submit", "edit", "resume", "activate"].includes(action) &&
      inspection.allowed &&
      current().status === "active"
    ) {
      await (options.enableMode ?? enableConversationMode)(dataDir);
      await (options.launch ?? launchWorker)(dataDir, conversationId);
    }
    const snapshot = store.snapshot(conversationId);
    return {
      ...snapshot,
      mode: inspectConversationMode(dataDir),
      controls: inspection.allowed
        ? { allowed: true }
        : {
            allowed: false,
            reason: "reason" in inspection ? inspection.reason : "Runtime stopped",
          },
      workerRunning: await workerAlive(dataDir, conversationId),
      ...(action === "events"
        ? { events: store.events(conversationId, number(input, "after") ?? 0) }
        : {}),
    };
  } finally {
    store.close();
  }
}

export async function runConversationCli(argv: readonly string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { "data-dir": { type: "string" }, json: { type: "boolean" } },
    });
    if (!values["data-dir"] || !positionals[0])
      throw Error(
        "Usage: conversation <submit|read|edit|stop|resume|activate|events> --data-dir PATH --json ; JSON on stdin",
      );
    let raw = "";
    for await (const chunk of process.stdin) raw += String(chunk);
    const input: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("Expected an input object");
    const data = await conversationCommand(
      path.resolve(values["data-dir"]),
      positionals[0],
      input as Record<string, unknown>,
    );
    process.stdout.write(
      JSON.stringify({ schema: "mind.conversation", schemaVersion: 1, ok: true, data }) + "\n",
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        schema: "mind.conversation",
        schemaVersion: 1,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }) + "\n",
    );
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runConversationCli(process.argv.slice(2));
