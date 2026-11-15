import { startFastReply } from "./fast-reply.js";
import { forkThread, storeThreadMessageId } from "../../communication/fast-reply-store.js";
import { FORK_IDS, forkDir, forkEnabled, readForks, runForks, sendToFork, setForkEnabled } from "../../daemon/forks.js";
import { clearForkAssignment, readForkAssignment, saveForkAssignment } from "../../daemon/fork-assignment.js";
import { readVoiceScreenPayloads, voiceScreenReferences } from "../../communication/voice-screen-images.js";
import { workspaceDirFor } from "../../daemon/paths.js";
import { secondThreadProfileControl } from "./second-thread.js";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";
import { resolvePolicy } from "../../policy/index.js";
import { DEFAULT_PROFILE_ID } from "../context.js";

export async function forks(
  ctx: CliContext,
  dataDir: DataDir,
  action: string,
): Promise<CommandResult<unknown>> {
  const workspace = workspaceDirFor(dataDir.path);
  const profile = () => {
    const state = secondThreadProfileControl(ctx, dataDir);
    if (state === "stop") return state;
    return withReadStore(ctx, dataDir, ({ uow }) => {
      if (uow === null) return "stop" as const;
      const policy = resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      return policy.status === "active" &&
        policy.revision.groups.runtime.adapterId === "codex" &&
        policy.revision.groups.runtime.nativeCapabilities === true
        ? state
        : ("stop" as const);
    });
  };
  // Un fork affecté à Claude Code ne dépend pas du runtime du principal : consentement hôte,
  // profil actif, pause et Force-off suffisent (mêmes règles que le second fil Claude).
  const claudeProfile = () => secondThreadProfileControl(ctx, dataDir);
  const engineOf = (id: number) => {
    try { return readForkAssignment(forkDir(dataDir.path, id))?.engine ?? "codex"; }
    catch { return "codex" as const; }
  };
  const profileFor = (id: number) => (engineOf(id) === "claude" ? claudeProfile() : profile());
  /** Le worker démarre si au moins un fork activé peut tourner avec son moteur. */
  const workerProfile = () => {
    const states = FORK_IDS.filter((id) => forkEnabled(dataDir.path, id)).map(profileFor);
    return states.includes("run") ? "run" : states.includes("hold") ? "hold" : profile();
  };
  if (action === "run") {
    const model = withReadStore(ctx, dataDir, ({ uow }) => {
      const policy = uow === null ? null : resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      return policy?.status === "active" ? policy.revision.groups.runtime.model : undefined;
    });
    await runForks({
      dataDir: dataDir.path,
      workspace,
      profile,
      claudeProfile,
      log: ctx.stderr,
      ...(model === undefined ? {} : { model }),
    });
  } else if (["on", "off", "send", "assign", "unassign"].includes(action)) {
    const raw = JSON.parse((await ctx.readStdin?.()) ?? "{}") as { id?: unknown; text?: unknown; idempotency_key?: unknown; provenance?: unknown; voice_screen_refs?: unknown };
    if (typeof raw.id !== "number" || !FORK_IDS.includes(raw.id as (typeof FORK_IDS)[number]))
      throw Error("Fork attendu : 2 à 8.");
    if (action === "assign" || action === "unassign") {
      // Affecter ou désaffecter ne lance rien : Off/On, Pause et Force-off restent inchangés.
      const dir = forkDir(dataDir.path, raw.id);
      const assignment = action === "assign" ? saveForkAssignment(dir, raw as Record<string, unknown>) : null;
      if (action === "unassign") clearForkAssignment(dir);
      return {
        exitCode: 0,
        data: { id: raw.id, assignment, ...readForks(dataDir.path, workspace), dataDir: dataDir.path, profile: workerProfile() },
        human: () => (assignment ? `Fork ${String(raw.id)} affecté (${assignment.engine}) : ${assignment.instructions}` : `Fork ${String(raw.id)} désaffecté.`),
      };
    }
    if (action === "on" && profileFor(raw.id) === "stop")
      throw Error(
        "Fork indisponible : Wake nécessite un profil Codex natif actif et le consentement hôte.",
      );
    if (action === "send") {
      if (typeof raw.text !== "string") throw Error("Message manquant.");
      // Queue only: Off, Pause and Force-off remain untouched. No policy gate on send.
      if (raw.idempotency_key !== undefined && typeof raw.idempotency_key !== "string") throw Error("Invalid idempotency key");
      if (raw.provenance !== undefined && typeof raw.provenance !== "string") throw Error("Invalid provenance");
      if (typeof raw.provenance === "string" && raw.provenance.length > 20000) throw Error("Provenance too long");
      const screenRefs = voiceScreenReferences(raw.voice_screen_refs);
      if (screenRefs.length && (profileFor(raw.id) !== "run" || !forkEnabled(dataDir.path, raw.id)))
        throw Error("Partage écran indisponible : le fork est arrêté ou en pause.");
      const screen = readVoiceScreenPayloads(workspace, screenRefs);
      const receipt = sendToFork(dataDir.path, raw.id, raw.text, raw.idempotency_key, raw.provenance ?? "", undefined, screen);
      // Message humain direct : la réponse rapide commune à tous les fils y répond aussi.
      if (raw.idempotency_key === undefined && !raw.provenance)
        try { startFastReply(dataDir, storeThreadMessageId(forkThread(raw.id), receipt.entryId)); }
        catch { /* Le fork reçoit son message normalement. */ }
      return {exitCode:0, data:{...receipt, destination:`fork:${raw.id}`, reply:{id:raw.idempotency_key ?? null,text:raw.text}, provenance:raw.provenance ?? ""}, human:()=>"Message queued for the selected fork."};
    } else setForkEnabled(dataDir.path, raw.id, action === "on");
  } else if (action !== "status") throw Error("Action de fork inconnue.");
  return {
    exitCode: 0,
    data: { ...readForks(dataDir.path, workspace), dataDir: dataDir.path, profile: workerProfile() },
    human: () => "État des forks Codex.",
  };
}
