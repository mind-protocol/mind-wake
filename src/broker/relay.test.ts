/**
 * Relais fournisseur sur un vrai serveur HTTPS local (aucun fournisseur réel) : tunnel
 * autorisé, refus de cible, de port, d'IP littérale, de méthode, d'adresse interdite,
 * de SNI non conforme et de flux non TLS ; journal expurgé.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectVia } from "../../test/support/connect-client.js";
import { selfSignedCertificate } from "../../test/support/self-signed-cert.js";
import {
  isForbiddenAddress,
  parseConnectTarget,
  PROVIDER_DESTINATIONS,
  providerAllowlist,
  ProviderRelay,
  type RelayEvent,
  type RelayUpstream,
} from "./index.js";

const HOST = "provider.mindwake.test";
const cert = selfSignedCertificate(HOST);

describe("relais CONNECT", () => {
  let server: https.Server;
  let serverPort = 0;
  let upstreamConnections = 0;
  const events: RelayEvent[] = [];
  let relay: ProviderRelay;

  /** Test seulement : le nom autorisé pointe vers le serveur HTTPS local. */
  const localUpstream = (connect: (port: number) => net.Socket): RelayUpstream => ({
    lookup: (host) => Promise.resolve(host === HOST ? ["127.0.0.1"] : []),
    isForbidden: (address) => address !== "127.0.0.1",
    connect: () => connect(serverPort),
  });

  beforeAll(async () => {
    server = https.createServer({ cert: cert.cert, key: cert.key }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "4" });
      res.end("pong");
    });
    server.on("connection", () => (upstreamConnections += 1));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    serverPort = typeof address === "object" && address !== null ? address.port : 0;
    relay = new ProviderRelay({
      runtime: "claude",
      destinations: [{ host: HOST, ports: [443], purpose: "test" }],
      journal: (event) => events.push(event),
      upstream: localUpstream((port) => net.connect({ host: "127.0.0.1", port })),
      clientHelloTimeoutMs: 1_000,
    });
    await relay.listen();
  });

  afterAll(async () => {
    await relay.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it("ouvre un tunnel TLS vers une destination autorisée et le journalise", async () => {
    const before = upstreamConnections;
    const outcome = await connectVia({
      relayPort: relay.port,
      target: `${HOST}:443`,
      ca: cert.cert,
    });
    expect(outcome).toMatchObject({ status: 200, body: "pong" });
    expect(upstreamConnections).toBe(before + 1);
    await waitFor(() => events.some((e) => e.kind === "tunnel_closed"));
    const closed = events.find((e) => e.kind === "tunnel_closed");
    expect(closed).toMatchObject({
      host: HOST,
      port: 443,
      address: "127.0.0.1",
      runtime: "claude",
    });
    expect(closed?.bytesUp).toBeGreaterThan(100);
    expect(closed?.bytesDown).toBeGreaterThan(100);
    const stats = relay.stats();
    expect(stats.tunnelsOpened).toBeGreaterThanOrEqual(1);
    expect(stats.byHost[HOST]?.tunnels).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["destination hors allowlist", "evil.mindwake.test:443", "destination_not_allowed", 403],
    ["port non autorisé", `${HOST}:80`, "port_not_allowed", 403],
    ["IPv4 littérale (loopback)", "127.0.0.1:443", "ip_literal", 403],
    ["IPv4 littérale (métadonnées)", "169.254.169.254:80", "ip_literal", 403],
    ["IPv6 littérale", "[::1]:443", "ip_literal", 403],
    ["cible mal formée", "provider.mindwake.test", "malformed_target", 400],
  ])("refuse : %s", async (_label, target, reason, status) => {
    const before = upstreamConnections;
    const outcome = await connectVia({ relayPort: relay.port, target });
    expect(outcome.status).toBe(status);
    expect(upstreamConnections).toBe(before);
    expect(events.at(-1)).toMatchObject({ kind: "refused", reason });
  });

  it("n'écrit dans le journal ni le nom refusé, ni les en-têtes du client", async () => {
    const secretish = "c2VjcmV0LXRva2VuLWZhY3RpY2U.exfil.mindwake.test";
    await connectVia({
      relayPort: relay.port,
      target: `${secretish}:443`,
      headers: ["Proxy-Authorization: Basic ZmFrZTpmYWtl"],
    });
    const event = events.at(-1);
    expect(event).toMatchObject({ kind: "refused", reason: "destination_not_allowed" });
    expect(event?.targetDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(event?.targetLength).toBe(secretish.length);
    const journal = JSON.stringify(events);
    expect(journal).not.toContain("c2VjcmV0");
    expect(journal).not.toContain("ZmFrZTpmYWtl");
  });

  it("refuse une requête HTTP ordinaire (proxy en clair)", async () => {
    const status = await new Promise<number | undefined>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: relay.port, path: `http://${HOST}/`, headers: { host: HOST } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", () => {
        resolve(undefined);
      });
      req.end();
    });
    expect(status).toBe(405);
    expect(events.at(-1)).toMatchObject({ kind: "refused", reason: "method_not_allowed" });
  });

  it("refuse un SNI différent de la cible sans ouvrir de connexion amont", async () => {
    const before = upstreamConnections;
    const outcome = await connectVia({
      relayPort: relay.port,
      target: `${HOST}:443`,
      servername: "other.mindwake.test",
      ca: cert.cert,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toBeNull();
    expect(upstreamConnections).toBe(before);
    await waitFor(() => events.at(-1)?.reason === "sni_mismatch");
  });

  it("refuse un flux non TLS dans le tunnel", async () => {
    const before = upstreamConnections;
    const outcome = await connectVia({
      relayPort: relay.port,
      target: `${HOST}:443`,
      raw: `GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
    });
    expect(outcome.body).toBeNull();
    expect(upstreamConnections).toBe(before);
    await waitFor(() => events.at(-1)?.reason === "not_tls");
  });

  it("refuse un hôte autorisé qui se résout vers une adresse interdite", async () => {
    const dnsEvents: RelayEvent[] = [];
    let connects = 0;
    const hostile = new ProviderRelay({
      runtime: "codex",
      destinations: [{ host: HOST, ports: [443], purpose: "test" }],
      journal: (event) => dnsEvents.push(event),
      upstream: {
        lookup: () => Promise.resolve(["10.0.0.5", "169.254.169.254", "::1", "::ffff:127.0.0.1"]),
        isForbidden: isForbiddenAddress,
        connect: () => {
          connects += 1;
          throw new Error("ne doit pas être appelé");
        },
      },
    });
    await hostile.listen();
    try {
      const outcome = await connectVia({ relayPort: hostile.port, target: `${HOST}:443` });
      expect(outcome.status).toBe(403);
      expect(connects).toBe(0);
      expect(dnsEvents.at(-1)).toMatchObject({ kind: "refused", reason: "forbidden_address" });
    } finally {
      await hostile.close();
    }
  });
});

describe("adresses et cibles", () => {
  it.each([
    "127.0.0.1",
    "127.10.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "pas-une-ip",
  ])("adresse interdite : %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])(
    "adresse publique : %s",
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it("normalise la cible et refuse les formes ambiguës", () => {
    expect(parseConnectTarget("API.Anthropic.com.:443")).toEqual({
      ok: true,
      target: { host: "api.anthropic.com", port: 443 },
    });
    expect(parseConnectTarget("2130706433:443")).toMatchObject({ ok: false, reason: "ip_literal" });
    expect(parseConnectTarget("user@api.anthropic.com:443")).toMatchObject({ ok: false });
    expect(parseConnectTarget("localhost:443")).toMatchObject({ ok: false });
    expect(parseConnectTarget("api.anthropic.com:99999")).toMatchObject({ ok: false });
  });

  it("la policy restreint le catalogue vérifié sans pouvoir l'élargir", () => {
    expect(providerAllowlist("codex")).toBe(PROVIDER_DESTINATIONS.codex);
    const restricted = providerAllowlist("codex", [
      { host: "API.openai.com", ports: [443, 80], purpose: "policy" },
      { host: "evil.example.com", ports: [443], purpose: "policy" },
    ]);
    expect(restricted.map((d) => [d.host, d.ports])).toEqual([["api.openai.com", [443]]]);
    for (const list of Object.values(PROVIDER_DESTINATIONS)) {
      for (const dest of list) {
        expect(dest.ports).toEqual([443]);
        expect(parseConnectTarget(`${dest.host}:443`).ok).toBe(true);
      }
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition non atteinte");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
