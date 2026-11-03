import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { coachEnabled, readCoachState } from "./coach.js";
import { WakeManager } from "./wake-manager.js";
import { workspaceDirFor, controlDbPath } from "./paths.js";
import { openStoreReadOnly } from "../store/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";
import { resolvePolicy } from "../policy/index.js";
import { StopFlag } from "../runner/controls.js";
import { publishCoachMessage } from "./coach-messages.js";

export function registerCoachTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"],
    token = env["MIND_WAKE_COACH_SESSION"];
  if (!dataDir || !token) throw Error("Coach session missing");
  const call = (action: (manager: WakeManager, threadId: string) => unknown) => {
    let manager: WakeManager | undefined;
    try {
      const session = JSON.parse(
        fs.readFileSync(path.join(dataDir, "coach-session.json"), "utf8"),
      ) as { token?: unknown };
      if (session.token !== token || !coachEnabled(dataDir)) throw Error("Coach session revoked");
      const control = openStoreReadOnly(controlDbPath(dataDir));
      try {
        const profile = control.uow.profiles.get(DEFAULT_PROFILE_ID),
          policy = resolvePolicy(control.uow.policies, DEFAULT_PROFILE_ID);
        if (
          !profile ||
          profile.emergencyStopLocked ||
          ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state) ||
          new StopFlag(dataDir).exists() ||
          policy.status !== "active" ||
          policy.revision.groups.runtime.adapterId !== "codex" ||
          policy.revision.groups.runtime.nativeCapabilities !== true ||
          policy.revision.groups.runtime.hostUnsandboxedAcknowledged !== true
        )
          throw Error("Wake controls prevent coaching");
      } finally {
        control.close();
      }
      const threadId = readCoachState(dataDir).threadId;
      if (!threadId) throw Error("Coach thread unavailable");
      manager = new WakeManager(workspaceDirFor(dataDir));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(action(manager, threadId)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: String(error) }) }],
      };
    } finally {
      manager?.close();
    }
  };
  const text = z.string().trim().min(1).max(8000);
  server.registerTool(
    "get_coaching_objectives",
    {
      description:
        "Read current and upcoming principal objectives, their canonical planning revision and project context before coaching changes. Does not consume wakes.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      call((m) => {
        const state = m.status(),
          next = m.next(20);
        return {
          revision: state?.revision,
          ...next,
          projects: state?.projects.map((p) => m.project(p.id)),
        };
      }),
  );
  server.registerTool(
    "set_coached_objective",
    {
      description:
        "Set or reformulate the current or an upcoming objective and its expected result in the canonical plan. Requires the freshly read revision, wake number and project. Preserves counters, project assignment and controls. Sends the changed objective and reason to the principal immediately. An imported passage is scoped to that passage; legacy projects share their ten-step plan across returns.",
      inputSchema: z.strictObject({
        number: z.number().int().positive(),
        project_id: z.string(),
        expected_revision: z.number().int().nonnegative(),
        objective: text,
        expected: text,
        reason: text,
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      call((m, threadId) => {
        const changed = m.reviseObjective({
          number: a.number,
          projectId: a.project_id,
          expectedRevision: a.expected_revision,
          objective: a.objective,
          expected: a.expected,
          reason: a.reason,
        });
        const messageId = `coach:objective:${String(changed.revision)}`;
        publishCoachMessage(
          dataDir,
          threadId,
          messageId,
          `Objectif du wake ${String(changed.number)} mis à jour par le coach : ${changed.step.objective}\nRésultat attendu : ${changed.step.expected}\nInstruction et raison : ${a.reason}`,
          token,
        );
        return { ...changed, messageId };
      }),
  );
  server.registerTool(
    "send_coaching_instruction",
    {
      description:
        "Send an instruction or improvement to the principal now through Wake's existing peer inbox. It remains attributed to the coach; it does not override human decisions or controls. Reuse an idempotency key when retrying the same message.",
      inputSchema: z.strictObject({
        text,
        idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      call((_m, threadId) => {
        const messageId = `coach:instruction:${token}:${a.idempotency_key}`;
        publishCoachMessage(dataDir, threadId, messageId, a.text, token);
        return { messageId, queued: true };
      }),
  );
}
