import {engineChoice} from "../../daemon/agent-engine.js";
import { startFastReply } from "./fast-reply.js";
import { forkThread, storeThreadMessageId } from "../../communication/fast-reply-store.js";
import { FORK_IDS, discardPendingBeforeAssignment, forkDir, forkEnabled, readForks, runForks, sendNoticeToFork, sendToFork, setForkEnabled } from "../../daemon/forks.js";
import { clearForkAssignment, readForkAssignment, saveForkAssignment, setRoomDisplayName } from "../../daemon/fork-assignment.js";
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
        (policy.revision.groups.runtime.adapterId === "codex" || !!engineChoice(dataDir.path)) &&
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
  /** Causes lisibles d'un refus « stop », dans l'ordre des contrôles de `profile`. */
  const stopReasons = (engine: string): string[] =>
    withReadStore(ctx, dataDir, ({ uow }) => {
      if (uow === null) return ["profil Wake introuvable"];
      const reasons: string[] = [];
      const state = uow.profiles.get(DEFAULT_PROFILE_ID) ?? null;
      if (state === null) reasons.push("profil Wake introuvable");
      else if (state.emergencyStopLocked) reasons.push("arrêt d'urgence (Force-off) verrouillé, à lever par l'humain");
      else if (["stopped", "disabled"].includes(state.state)) reasons.push(`profil ${state.state}`);
      const policy = resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      if (policy.status !== "active") reasons.push("aucune policy active");
      else {
        const runtime = policy.revision.groups.runtime;
        if (runtime.hostUnsandboxedAcknowledged !== true) reasons.push("consentement au mode hôte absent");
        if (engine !== "claude" && runtime.nativeCapabilities !== true)
          reasons.push("room Codex : la policy n'active pas les capacités natives");
      }
      return reasons.length ? reasons : ["profil indisponible"];
    });
  /** Le worker démarre si au moins un fork activé peut tourner avec son moteur. */
  const workerProfile = () => {
    const states = FORK_IDS.filter((id) => forkEnabled(dataDir.path, id)).map(profileFor);
    return states.includes("run") ? "run" : states.includes("hold") ? "hold" : profile();
  };
  if (action === "run") {
    const model = withReadStore(ctx, dataDir, ({ uow }) => {
      const policy = uow === null ? null : resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      return policy?.status === "active" && policy.revision.groups.runtime.adapterId === "codex" ? policy.revision.groups.runtime.model : undefined;
    });
    await runForks({
      dataDir: dataDir.path,
      workspace,
      profile,
      claudeProfile,
      // Une ligne horodatée par événement : forks.log doit permettre de dater un incident.
      log: (line) => {
        ctx.stderr(`${new Date().toISOString()} ${line.replace(/\n+$/, "")}\n`);
      },
      ...(model === undefined ? {} : { model }),
    });
  } else if (["on", "off", "send", "assign", "unassign", "rename"].includes(action)) {
    const raw = JSON.parse((await ctx.readStdin?.()) ?? "{}") as { id?: unknown; text?: unknown; idempotency_key?: unknown; provenance?: unknown; voice_screen_refs?: unknown; notice_label?: unknown };
    if (typeof raw.id !== "number" || !FORK_IDS.includes(raw.id as (typeof FORK_IDS)[number]))
      throw Error("Room attendue : 2 à 8.");
    if (action === "rename") {
      // Nom affiché seulement (NLR, 18 nov. 2026) : identifiant, mentions, fichiers et jobs inchangés.
      // `name` vide ou null : retour au nom par défaut (affectation, signature, « Room N »).
      const named = raw as { name?: unknown; text?: unknown };
      const name = setRoomDisplayName(forkDir(dataDir.path, raw.id), named.name !== undefined ? named.name : (named.text ?? null));
      return {
        exitCode: 0,
        data: { id: raw.id, name: name ?? null, ...readForks(dataDir.path, workspace), dataDir: dataDir.path, profile: workerProfile() },
        human: () => (name ? `Room ${String(raw.id)} renommée « ${name} ».` : `Room ${String(raw.id)} : nom par défaut.`),
      };
    }
    if (action === "assign" || action === "unassign") {
      // Affecter ou désaffecter ne lance rien : Off/On, Pause et Force-off restent inchangés.
      const dir = forkDir(dataDir.path, raw.id);
      const assignment = action === "assign" ? saveForkAssignment(dir, raw as Record<string, unknown>) : null;
      if (action === "unassign") clearForkAssignment(dir);
      // Nouvelle affectation : la room n'hérite pas des messages en attente antérieurs.
      const discarded = assignment ? discardPendingBeforeAssignment(dataDir.path, raw.id, assignment.assignedAt) : [];
      return {
        exitCode: 0,
        data: { id: raw.id, assignment, discarded, ...readForks(dataDir.path, workspace), dataDir: dataDir.path, profile: workerProfile() },
        human: () => (assignment ? `Room ${String(raw.id)} affectée (${assignment.engine}) : ${assignment.instructions}` : `Room ${String(raw.id)} désaffectée.`),
      };
    }
    if (action === "on" && profileFor(raw.id) === "stop")
      throw Error(`Room indisponible : ${stopReasons(engineOf(raw.id)).join(" ; ")}.`);
    if (action === "send") {
      if (typeof raw.text !== "string") throw Error("Message manquant.");
      // Queue only: Off, Pause and Force-off remain untouched. No policy gate on send.
      if (raw.idempotency_key !== undefined && typeof raw.idempotency_key !== "string") throw Error("Invalid idempotency key");
      if (raw.provenance !== undefined && typeof raw.provenance !== "string") throw Error("Invalid provenance");
      if (typeof raw.provenance === "string" && raw.provenance.length > 20000) throw Error("Provenance too long");
      if (raw.notice_label !== undefined) {
        // Voix non humaine (ex. Vigie) : notice étiquetée, jamais présentée comme NLR.
        if (typeof raw.notice_label !== "string" || raw.notice_label.trim() === "" || raw.notice_label.length > 80)
          throw Error("notice_label : chaîne non vide de 80 caractères au plus.");
        if (typeof raw.idempotency_key !== "string") throw Error("notice_label exige idempotency_key.");
        if (raw.voice_screen_refs !== undefined) throw Error("notice_label n'accepte pas de partage écran.");
        const receipt = sendNoticeToFork(dataDir.path, raw.id, raw.text, raw.idempotency_key, raw.notice_label);
        return {exitCode:0, data:{...receipt, destination:`fork:${raw.id}`, reply:{id:raw.idempotency_key,text:raw.text}, provenance:raw.provenance ?? "", notice_label:raw.notice_label.trim()}, human:()=>"Notice queued for the selected fork."};
      }
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
