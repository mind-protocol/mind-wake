/**
 * `policy configure <fichier.json>` : prépare une révision de policy depuis un fichier
 * fourni par l'humain, validée par `src/policy/`. La révision proposée n'a aucun effet
 * tant que `enable` ne l'a pas fait confirmer par l'humain.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PolicyRevisionId } from "../../contracts/index.js";
import { toUtcTimestamp } from "../../journal/index.js";
import { proposeRevision, type ValidationIssue } from "../../policy/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT } from "./read.js";

/** Taille maximale du fichier de brouillon. */
export const MAX_DRAFT_BYTES = 1024 * 1024;

/** Code à taper pour confirmer une révision : début de son empreinte SHA-256. */
export function confirmationCode(digest: string): string {
  return digest.slice(0, 12);
}

export interface PolicyConfigureData {
  readonly status: "proposed" | "rejected";
  readonly revisionId: string | null;
  readonly digest: string | null;
  readonly confirmationCode: string | null;
  readonly change: {
    readonly kind: string;
    readonly widened: readonly string[];
    readonly restricted: readonly string[];
  } | null;
  readonly issues: readonly ValidationIssue[];
  readonly note: string;
}

const NOTE =
  "révision proposée sans effet : aucune permission ni budget tant que l'humain ne l'a pas confirmée avec `mind-wake enable`";

function rejected(issues: readonly ValidationIssue[]): CommandResult<PolicyConfigureData> {
  return {
    exitCode: EXIT_FAILURE,
    data: {
      status: "rejected",
      revisionId: null,
      digest: null,
      confirmationCode: null,
      change: null,
      issues,
      note: NOTE,
    },
    human: formatConfigure,
  };
}

function readDraft(file: string): { ok: true; draft: unknown } | { ok: false; detail: string } {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return { ok: false, detail: "fichier introuvable" };
  }
  if (!stats.isFile()) return { ok: false, detail: "le chemin n'est pas un fichier" };
  if (stats.size > MAX_DRAFT_BYTES) {
    return { ok: false, detail: `fichier trop volumineux (> ${String(MAX_DRAFT_BYTES)} octets)` };
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    // Marque d'ordre des octets (U+FEFF) ajoutée par certains éditeurs Windows.
    return { ok: true, draft: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch {
    return { ok: false, detail: "JSON invalide" };
  }
}

export function policyConfigure(
  ctx: CliContext,
  dataDir: DataDir,
  fileArg: string,
): CommandResult<PolicyConfigureData> {
  const read = readDraft(path.resolve(ctx.cwd, fileArg));
  if (!read.ok) return rejected([{ field: "", code: "invalid", detail: read.detail }]);
  if (!fs.existsSync(dataDir.path)) {
    return rejected([{ field: "", code: "invalid", detail: NO_PROFILE_HINT }]);
  }
  const store = ctx.openStore(dataDir.path, "write");
  try {
    return store.uow.transaction((tx) => {
      const profile = tx.profiles.get(DEFAULT_PROFILE_ID);
      if (profile === null) {
        return rejected([{ field: "", code: "invalid", detail: NO_PROFILE_HINT }]);
      }
      const latest = tx.policies.listRevisions(profile.id).at(-1);
      if (latest !== undefined && tx.policies.getConsent(latest.id) === null) {
        return rejected([
          {
            field: "",
            code: "inconsistent",
            detail: `une révision attend déjà la confirmation humaine (${latest.id}) : la confirmer avec \`mind-wake enable\` avant d'en proposer une autre`,
          },
        ]);
      }
      const draft =
        typeof read.draft === "object" &&
        read.draft !== null &&
        !Array.isArray(read.draft) &&
        !("identity" in read.draft)
          ? { ...read.draft, identity: { profileId: profile.id, agentId: profile.agentId } }
          : read.draft;
      const proposed = proposeRevision(tx, {
        revisionId: `rev-${randomUUID()}` as PolicyRevisionId,
        profileId: profile.id,
        at: toUtcTimestamp(ctx.now()),
        draft,
      });
      if (proposed.status === "rejected") return rejected(proposed.issues);
      return {
        exitCode: EXIT_OK,
        data: {
          status: "proposed",
          revisionId: proposed.revision.id,
          digest: proposed.digest,
          confirmationCode: confirmationCode(proposed.digest),
          change: {
            kind: proposed.change.kind,
            widened: [...proposed.change.widened],
            restricted: [...proposed.change.restricted],
          },
          issues: [],
          note: NOTE,
        },
        human: formatConfigure,
      };
    });
  } finally {
    store.close();
  }
}

function formatConfigure(data: PolicyConfigureData): string {
  if (data.status === "rejected") {
    return [
      "Brouillon refusé : aucune révision créée.",
      ...data.issues.map(
        (i) => `  ${i.field === "" ? "(brouillon)" : i.field} [${i.code}] ${i.detail}`,
      ),
    ].join("\n");
  }
  const change = data.change;
  return [
    `Révision proposée : ${data.revisionId ?? "—"}`,
    `Empreinte : ${data.digest ?? "—"}`,
    `Nature : ${change?.kind ?? "—"} ; élargit : ${change?.widened.join(", ") || "rien"} ; restreint : ${change?.restricted.join(", ") || "rien"}`,
    `Relire le brouillon, puis l'humain confirme avec \`mind-wake enable\` (code ${data.confirmationCode ?? "—"}).`,
    data.note,
  ].join("\n");
}
