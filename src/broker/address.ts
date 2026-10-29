/**
 * Adresses que le relais ne joint jamais, même pour un hôte de l'allowlist : un DNS
 * hostile ou mal configuré ne doit pas ouvrir le loopback, le réseau privé, les
 * métadonnées d'instance ou un service local de l'hôte au conteneur.
 */

import net from "node:net";

const FORBIDDEN = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // « ce réseau »
  ["10.0.0.0", 8], // privé
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // lien local, métadonnées (169.254.169.254)
  ["172.16.0.0", 12], // privé
  ["192.0.0.0", 24], // affectations IETF
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // relais 6to4
  ["192.168.0.0", 16], // privé
  ["198.18.0.0", 15], // bancs d'essai
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // réservé, diffusion
] as const) {
  FORBIDDEN.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128], // non spécifiée
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 : peut viser une IPv4 privée
  ["64:ff9b:1::", 48],
  ["100::", 64], // rejet
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 : peut encapsuler une IPv4 privée
  ["fc00::", 7], // unique locale
  ["fe80::", 10], // lien local
  ["fec0::", 10], // site local (obsolète)
  ["ff00::", 8], // multicast
] as const) {
  FORBIDDEN.addSubnet(prefix, bits, "ipv6");
}

/** Vrai si l'adresse ne doit jamais être jointe par le relais (ou n'est pas une IP). */
export function isForbiddenAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 4) return FORBIDDEN.check(address, "ipv4");
  // IPv4 projetée (::ffff:a.b.c.d) : toujours refusée, un DNS sain rend l'IPv4. Hors de la
  // BlockList, qui appliquerait ce préfixe à toute adresse IPv4.
  if (/^::ffff:/i.test(address)) return true;
  return FORBIDDEN.check(address, "ipv6");
}

export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type TargetParse =
  | { readonly ok: true; readonly target: ConnectTarget }
  | { readonly ok: false; readonly reason: "malformed_target" | "ip_literal" };

/**
 * Analyse la cible d'un `CONNECT` (`hôte:port`). Seuls les noms DNS sont acceptés : une IP
 * littérale ne peut pas figurer dans l'allowlist et contournerait la vérification du nom.
 */
export function parseConnectTarget(raw: string | undefined): TargetParse {
  if (raw === undefined || raw.length > 300) return { ok: false, reason: "malformed_target" };
  if (raw.startsWith("[")) return { ok: false, reason: "ip_literal" };
  const match = /^([^:]+):(\d{1,5})$/.exec(raw);
  if (match?.[1] === undefined || match[2] === undefined) {
    return { ok: false, reason: "malformed_target" };
  }
  const host = match[1].toLowerCase().replace(/\.$/, "");
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return { ok: false, reason: "malformed_target" };
  if (net.isIP(host) !== 0 || /^[\d.]+$/.test(host)) return { ok: false, reason: "ip_literal" };
  if (!HOSTNAME.test(host)) return { ok: false, reason: "malformed_target" };
  return { ok: true, target: { host, port } };
}
