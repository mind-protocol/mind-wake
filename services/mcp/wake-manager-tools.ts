/** Workspace planning tools only: no model launch, new access or quota override. */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { WakeManager } from "../../src/daemon/wake-manager.js";
import { workspaceDirFor, controlDbPath } from "../../src/daemon/paths.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { resolvePolicy } from "../../src/policy/index.js";
import { StopFlag } from "../../src/runner/controls.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const text = z.string().trim().min(1).max(8000);
export function registerWakeManagerTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) return;
  const call = (mutate: boolean, action: (manager: WakeManager) => unknown) => {
    let manager: WakeManager | undefined;
    try {
      const control = openStoreReadOnly(controlDbPath(dataDir));
      try {
        const policy = resolvePolicy(control.uow.policies, DEFAULT_PROFILE_ID),
          profile = control.uow.profiles.get(DEFAULT_PROFILE_ID);
        if (policy.status !== "active" || !profile) throw Error("No active Wake profile");
        if (
          mutate &&
          (new StopFlag(dataDir).exists() ||
            profile.emergencyStopLocked ||
            ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state))
        )
          throw Error("Wake is paused or stopped; planning mutation refused");
      } finally {
        control.close();
      }
      manager = new WakeManager(workspaceDirFor(dataDir));
      return { content: [{ type: "text" as const, text: JSON.stringify(action(manager)) }] };
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
    } finally {
      manager?.close();
    }
  };
  server.registerTool(
    "get_next_wakes",
    {
      description:
        "Preview up to 500 principal wakes without consuming them. Logical days contain 50 wakes, project blocks contain 10, first wake prepares the block. Rotation carries across days. Paused/blocked projects are skipped without lifting their status. Includes current reservation when present.",
      inputSchema: z.strictObject({ count: z.number().int().min(1).max(500).default(50) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) =>
      call(false, (m) => {
        const state = m.status();
        return {
          rotation: state
            ? {
                enabled: state.enabled,
                revision: state.revision,
                used: state.used,
                projects: state.projects.map((p) => ({
                  id: p.id,
                  status: p.status,
                  reason: p.reason,
                  used: p.used,
                })),
              }
            : null,
          ...m.next(a.count),
        };
      }),
  );
  server.registerTool(
    "configure_wake_rotation",
    {
      description:
        "Enable or suspend the workspace's existing-project rotation: 50 wakes per logical day, 10 per project block. Imports the project registry; never starts a model, changes Wake mode or lifts Pause/Force-off.",
      inputSchema: z.strictObject({ enabled: z.boolean() }),
      annotations: { openWorldHint: false },
    },
    (a) => call(true, (m) => m.configure(a.enabled)),
  );
  server.registerTool(
    "get_wake_project",
    {
      description:
        "Retrieve a registered project's saved context, raw session handoff, sources, next actions and ten-wake plan. A raw handoff marked needsReview is not a validated summary.",
      inputSchema: z.strictObject({ project_id: id }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => call(false, (m) => m.project(a.project_id)),
  );
  server.registerTool(
    "save_wake_context",
    {
      description:
        "Save the project's current context in the workspace and its readable context.json mirror. Distinguish actual results from hypotheses, cite paths/sources, and keep concrete next actions. Required at the end of a ten-wake block.",
      inputSchema: z.strictObject({
        project_id: id,
        summary: text,
        next_actions: z.array(text).max(32),
        open_questions: z.array(text).max(32),
        sources: z.array(text).max(64),
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      call(true, (m) => {
        const project = m.saveContext(
          a.project_id,
          {
            summary: a.summary,
            nextActions: a.next_actions,
            openQuestions: a.open_questions,
            sources: a.sources,
          },
          env["MIND_WAKE_SESSION"] ?? null,
        );
        return { project, path: m.mirror(a.project_id) };
      }),
  );
  server.registerTool(
    "plan_wake_block",
    {
      description:
        "Save exactly ten wake intentions for a project. Wake1 retrieves context, checks improvements and prepares wakes2–10. Plans remain revisable; this call neither consumes wakes nor authorizes actions.",
      inputSchema: z.strictObject({
        project_id: id,
        steps: z
          .array(
            z.strictObject({
              wake: z.number().int().min(1).max(10),
              objective: text,
              expected: text,
            }),
          )
          .length(10),
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      call(true, (m) => ({ project: m.plan(a.project_id, a.steps), path: m.mirror(a.project_id) })),
  );
  server.registerTool(
    "set_wake_project_status",
    {
      description:
        "Pause, block or resume a registered project in the canonical workspace registry. Record the precise reason and what enables resumption. Does not resume Wake globally or grant permissions. A blocked project yields its slot to available work.",
      inputSchema: z.strictObject({
        project_id: id,
        status: z.enum(["active", "paused", "blocked"]),
        reason: text,
      }),
      annotations: { openWorldHint: false },
    },
    (a) => call(true, (m) => m.setStatus(a.project_id, a.status, a.reason)),
  );
}
