/**
 * Jetons opaques : capacités de rencontre, identifiants et pseudonymes. Une capacité
 * n'est conservée que sous forme d'empreinte ; elle n'est jamais journalisée, jamais
 * livrée dans un message et jamais exposée au modèle par l'adaptateur MCP.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function opaque(prefix: string, bytes = 18): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function digest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const PSEUDONYM_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Pseudonyme de rencontre, sans lien avec une identité privée. */
export function pseudonym(prefix: "guide" | "agent"): string {
  const raw = randomBytes(6);
  let suffix = "";
  for (const byte of raw) suffix += PSEUDONYM_ALPHABET[byte % PSEUDONYM_ALPHABET.length] ?? "x";
  return `${prefix}-${suffix}`;
}
