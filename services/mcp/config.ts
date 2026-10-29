/**
 * Configuration locale du hub, écrite par l'humain et jamais modifiable par un outil
 * MCP : parties connues, permissions accordées, profils de guide, enveloppes fictives
 * et limites de débit (AGENTS principe 7 : pas de message sans autorisation spécifique).
 *
 * Les identifiants privés (`privateId`) n'y figurent que pour être tenus à l'écart des
 * messages ; seules les empreintes sha256 des clés de liaison y sont.
 */

import { readFileSync } from "node:fs";
import * as z from "zod";
import { LIMITS, languageSchema } from "./protocol.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,8})$/);

export const partyConfigSchema = z.strictObject({
  /** Identifiant privé (adresse, nom de compte…) : jamais transmis à une autre partie. */
  privateId: z.string().min(3).max(200),
  kind: z.enum(["agent", "human"]),
  keyDigest: sha256Hex,
  permissions: z.strictObject({
    /** Envoyer des messages et répondre à des fils. */
    message: z.boolean(),
    /** Publier des demandes d'aide et inviter des guides. */
    requestHelp: z.boolean(),
    /** Recevoir des invitations et guider une séance. */
    guide: z.boolean(),
  }),
  guide: z
    .strictObject({
      topics: z.array(z.string().min(2).max(LIMITS.maxTopicChars)).min(1).max(20),
      languages: z.array(languageSchema).min(1).max(5),
      termsVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
    })
    .optional(),
  /** Enveloppe d'unités FICTIVES d'un agent qui demande de l'aide (SIMULÉ). */
  fictiveBudget: z
    .strictObject({
      funding: amount,
      unitPrice: amount,
      maxExchanges: z.int().min(1).max(LIMITS.maxExchanges),
    })
    .optional(),
});
export type PartyConfig = z.infer<typeof partyConfigSchema>;

export const hubConfigSchema = z.strictObject({
  parties: z.array(partyConfigSchema).min(1).max(200),
  rateLimit: z
    .strictObject({
      writesPerMinute: z.int().min(1).max(10_000),
      callsPerMinute: z.int().min(1).max(100_000),
    })
    .default({ writesPerMinute: 30, callsPerMinute: 300 }),
  /** Délai de grâce de clôture des séances (G1). */
  closeGraceMs: z.int().min(0).max(3_600_000).default(60_000),
});
export type HubConfig = z.infer<typeof hubConfigSchema>;

export function loadHubConfig(path: string): HubConfig {
  return parseHubConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseHubConfig(raw: unknown): HubConfig {
  const config = hubConfigSchema.parse(raw);
  const ids = new Set<string>();
  for (const party of config.parties) {
    if (ids.has(party.privateId)) throw new Error("identifiant privé configuré deux fois");
    ids.add(party.privateId);
    if (party.permissions.guide && party.guide === undefined) {
      throw new Error("permission guide sans profil de guide");
    }
  }
  return config;
}
