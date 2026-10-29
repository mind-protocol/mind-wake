/**
 * Certificat X.509 auto-signé (ECDSA P-256) construit en mémoire pour un serveur HTTPS
 * local de test : aucune clé privée versionnée, aucun outil externe (openssl). Le client
 * de test l'utilise comme seule ancre de confiance (`ca`, `NODE_EXTRA_CA_CERTS`).
 */

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const der = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  const n = body.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...c: Buffer[]): Buffer => der(0x30, ...c);
const oid = (bytes: readonly number[]): Buffer => der(0x06, Buffer.from(bytes));
const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, "utf8"));
const time = (d: Date): Buffer =>
  der(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z", "ascii"));

const ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const COMMON_NAME = [0x55, 0x04, 0x03];
const SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];

export interface TestCertificate {
  readonly cert: string;
  readonly key: string;
}

export function selfSignedCertificate(dnsName: string): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = seq(der(0x31, seq(oid(COMMON_NAME), utf8(dnsName))));
  const algorithm = seq(oid(ECDSA_SHA256));
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const now = Date.now();
  const extensions = der(
    0xa3,
    seq(
      seq(
        oid(BASIC_CONSTRAINTS),
        der(0x01, Buffer.from([0xff])),
        der(0x04, seq(der(0x01, Buffer.from([0xff])))),
      ),
      seq(oid(SUBJECT_ALT_NAME), der(0x04, seq(der(0x82, Buffer.from(dnsName, "ascii"))))),
    ),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([0x02]))), // v3
    der(0x02, serial),
    algorithm,
    name,
    seq(time(new Date(now - 60_000)), time(new Date(now + 24 * 3_600_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const certDer = seq(tbs, algorithm, der(0x03, Buffer.from([0x00]), signature));
  const base64 = certDer.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
