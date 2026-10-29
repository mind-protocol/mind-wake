/**
 * `policy show` : révision active, consentement et révocations. Lecture seule ;
 * n'active, ne valide et ne modifie rien.
 */

import type { PolicyGroups } from "../../contracts/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";

export interface PolicyShowData {
  readonly profileId: string | null;
  readonly hint: string | null;
  readonly revisionCount: number;
  readonly active: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly createdAt: string;
    readonly previousRevisionId: string | null;
    readonly consent: { readonly grantedAt: string; readonly channel: string } | null;
    readonly revocations: readonly { readonly revokedAt: string; readonly reason: string }[];
    readonly groups: PolicyGroups;
  } | null;
}

export function policyShow(ctx: CliContext, dataDir: DataDir): CommandResult<PolicyShowData> {
  const data = withReadStore(ctx, dataDir, ({ uow }): PolicyShowData => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    if (uow === null || profile === null) {
      return { profileId: null, hint: NO_PROFILE_HINT, revisionCount: 0, active: null };
    }
    const revisionCount = uow.policies.listRevisions(profile.id).length;
    const revision =
      profile.activePolicyRevisionId === null
        ? null
        : uow.policies.getRevision(profile.activePolicyRevisionId);
    if (revision === null)
      return { profileId: profile.id, hint: null, revisionCount, active: null };
    const consent = uow.policies.getConsent(revision.id);
    return {
      profileId: profile.id,
      hint: null,
      revisionCount,
      active: {
        id: revision.id,
        schemaVersion: revision.schemaVersion,
        createdAt: revision.createdAt,
        previousRevisionId: revision.previousRevisionId,
        consent:
          consent === null ? null : { grantedAt: consent.grantedAt, channel: consent.channel },
        revocations: uow.policies
          .listRevocations(revision.id)
          .map((r) => ({ revokedAt: r.revokedAt, reason: r.reason })),
        groups: revision.groups,
      },
    };
  });
  return { exitCode: EXIT_OK, data, human: formatPolicy };
}

function formatPolicy(data: PolicyShowData): string {
  if (data.profileId === null) return `Policy : ${data.hint ?? "—"}`;
  if (data.active === null) {
    return [
      "Aucune policy active : aucun budget, aucune permission, exploration désactivée.",
      `Révisions enregistrées : ${String(data.revisionCount)}`,
    ].join("\n");
  }
  const a = data.active;
  const lines = [
    `Révision active : ${a.id} (schéma v${String(a.schemaVersion)}, créée le ${a.createdAt})`,
    `Révision précédente : ${a.previousRevisionId ?? "—"}`,
    `Consentement : ${a.consent === null ? "absent" : `${a.consent.grantedAt} via ${a.consent.channel}`}`,
    `Révocations : ${a.revocations.length === 0 ? "aucune" : a.revocations.map((r) => `${r.revokedAt} (${r.reason})`).join(", ")}`,
    `Révisions enregistrées : ${String(data.revisionCount)}`,
  ];
  for (const [group, values] of Object.entries(a.groups)) {
    lines.push(`[${group}]`);
    for (const [field, value] of Object.entries(values as Record<string, unknown>)) {
      lines.push(`  ${field} : ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}
