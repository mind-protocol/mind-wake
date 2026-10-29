/**
 * Lecture du nom de serveur (SNI) dans le premier message TLS du client, sans déchiffrer
 * ni terminer TLS. Le relais exige que ce nom soit celui demandé par `CONNECT` : un tunnel
 * ouvert vers un hôte autorisé ne peut pas viser un autre site servi par la même adresse
 * (CDN partagé). L'en-tête HTTP `Host`, chiffré, reste hors de portée.
 */

export type ClientHelloParse =
  | { readonly kind: "incomplete" }
  | { readonly kind: "not_tls" }
  | { readonly kind: "no_sni" }
  | { readonly kind: "sni"; readonly name: string };

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const NAME_TYPE_HOST = 0x00;
/** Taille au-delà de laquelle un ClientHello est jugé anormal. */
export const MAX_CLIENT_HELLO_BYTES = 32 * 1024;

export function parseClientHello(data: Buffer): ClientHelloParse {
  // Réassemble le message de poignée de main, éventuellement réparti sur plusieurs records.
  const parts: Buffer[] = [];
  let collected = 0;
  let offset = 0;
  let needed: number | null = null;
  while (needed === null || collected < needed) {
    if (data.length < offset + 5) return { kind: "incomplete" };
    if (data[offset] !== RECORD_HANDSHAKE || data[offset + 1] !== 0x03) return { kind: "not_tls" };
    const length = data.readUInt16BE(offset + 3);
    if (length === 0 || length > 16_384 + 2_048) return { kind: "not_tls" };
    if (data.length < offset + 5 + length) return { kind: "incomplete" };
    parts.push(data.subarray(offset + 5, offset + 5 + length));
    collected += length;
    offset += 5 + length;
    if (needed === null) {
      const head = Buffer.concat(parts);
      if (head.length < 4) continue;
      if (head[0] !== HANDSHAKE_CLIENT_HELLO) return { kind: "not_tls" };
      needed = 4 + head.readUIntBE(1, 3);
      if (needed > MAX_CLIENT_HELLO_BYTES) return { kind: "not_tls" };
    }
  }
  const hello = Buffer.concat(parts).subarray(4, needed);
  return readServerName(hello);
}

function readServerName(hello: Buffer): ClientHelloParse {
  let p = 2 + 32; // version, aléa
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (hello.length < p + lengthBytes) return false;
    const n = lengthBytes === 1 ? hello.readUInt8(p) : hello.readUInt16BE(p);
    p += lengthBytes + n;
    return hello.length >= p;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return { kind: "not_tls" }; // session, suites, compression
  if (hello.length < p + 2) return { kind: "no_sni" };
  const end = p + 2 + hello.readUInt16BE(p);
  p += 2;
  if (end > hello.length) return { kind: "not_tls" };
  while (p + 4 <= end) {
    const type = hello.readUInt16BE(p);
    const length = hello.readUInt16BE(p + 2);
    const body = hello.subarray(p + 4, p + 4 + length);
    p += 4 + length;
    if (p > end) return { kind: "not_tls" };
    if (type !== EXT_SERVER_NAME) continue;
    let q = 2;
    while (q + 3 <= body.length) {
      const nameType = body.readUInt8(q);
      const nameLength = body.readUInt16BE(q + 1);
      const name = body.subarray(q + 3, q + 3 + nameLength);
      q += 3 + nameLength;
      if (q > body.length) return { kind: "not_tls" };
      if (nameType === NAME_TYPE_HOST) {
        return { kind: "sni", name: name.toString("ascii").toLowerCase().replace(/\.$/, "") };
      }
    }
    return { kind: "no_sni" };
  }
  return { kind: "no_sni" };
}
