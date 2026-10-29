/**
 * Transport fournisseur réel depuis un AppContainer (Windows, sans admin, sans règle
 * pare-feu) : un client Node confiné, lancé derrière le shim avec `HTTPS_PROXY`, joint un
 * serveur HTTPS LOCAL de test par le pipe broker et le relais ; une destination hors
 * allowlist est refusée ; une connexion directe hors relais est refusée par le système.
 * Aucun appel à un vrai fournisseur. Profil éphémère, ACE et dossiers temporaires retirés
 * et vérifiés après le test, même en échec.
 */

import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selfSignedCertificate } from "../../test/support/self-signed-cert.js";
import { ephemeralProfileName, Sandbox } from "../sandbox/index.js";
import { RelayProviderTransport, type RelayEvent, type RelayStats } from "./index.js";

const WINDOWS = process.platform === "win32";
const HOST = "provider.mindwake.test";

/** Client exécuté dans le conteneur : `fetch` natif, proxy pris dans l'environnement. */
const CLIENT = String.raw`
import net from "node:net";
import { createInterface } from "node:readline";
const [allowedUrl, deniedUrl, directPort] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const tryFetch = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { ok: true, status: r.status, body: await r.text() };
  } catch (e) {
    return { ok: false, error: String(e.cause?.code ?? e.cause?.message ?? e.name) };
  }
};
const direct = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: "timeout" }); }, 3000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve({ ok: true }); });
  s.on("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.code }); });
});
out({ step: "env", proxy: process.env.HTTPS_PROXY ?? null });
out({ step: "allowed", ...(await tryFetch(allowedUrl)) });
out({ step: "denied", ...(await tryFetch(deniedUrl)) });
out({ step: "direct_loopback", ...(await direct("127.0.0.1", Number(directPort))) });
out({ step: "direct_external", ...(await direct("1.1.1.1", 443)) });
out({ step: "waiting" });
await new Promise((resolve) => {
  createInterface({ input: process.stdin }).once("line", resolve);
  setTimeout(resolve, 15000);
});
out({ step: "done" });
process.exit(0);
`;

interface Step {
  readonly step: string;
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly error?: string;
  readonly proxy?: string | null;
}

describe.runIf(WINDOWS)("transport fournisseur depuis l'AppContainer", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-broker-test-"));
  const dirs = {
    build: path.join(base, "build"),
    runtime: path.join(base, "runtime"),
    shim: path.join(base, "shim"),
    work: path.join(base, "work"),
  };
  const sandbox = (() => {
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
    return new Sandbox(dirs.build, ephemeralProfileName("mindwake.brokertest"));
  })();
  const cert = selfSignedCertificate(HOST);
  const events: RelayEvent[] = [];
  const steps = new Map<string, Step>();
  let server: https.Server;
  let serverPort = 0;
  let served = 0;
  let shimReachableFromHost: boolean | null = null;
  let stats: RelayStats | null = null;
  let exitCode: number | null = null;
  let aclRevoked = false;

  beforeAll(async () => {
    server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
      served += 1;
      res.writeHead(200, { "content-type": "text/plain", "content-length": "4" });
      res.end(req.url === "/ping" ? "pong" : "????");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    serverPort = typeof address === "object" && address !== null ? address.port : 0;

    const node = path.join(dirs.runtime, "node.exe");
    fs.copyFileSync(process.execPath, node);
    fs.writeFileSync(path.join(dirs.runtime, "client.mjs"), CLIENT);
    fs.writeFileSync(path.join(dirs.runtime, "test-ca.pem"), cert.cert);
    sandbox.ensureProfile();

    const transport = new RelayProviderTransport({
      runtime: "claude",
      nodeExecutable: node,
      shimDir: dirs.shim,
      // Test seulement : nom fictif, résolu vers le serveur HTTPS local.
      destinations: [{ host: HOST, ports: [443], purpose: "serveur HTTPS local de test" }],
      upstream: {
        lookup: (host) => Promise.resolve(host === HOST ? ["127.0.0.1"] : []),
        isForbidden: (a) => a !== "127.0.0.1",
        connect: () => net.connect({ host: "127.0.0.1", port: serverPort }),
      },
      journal: (event) => events.push(event),
    });
    const session = await transport.open({
      executable: node,
      args: [
        "--preserve-symlinks-main",
        "--preserve-symlinks",
        path.join(dirs.runtime, "client.mjs"),
        `https://${HOST}/ping`,
        "https://evil.mindwake.test/",
        String(serverPort),
      ],
    });
    try {
      const proc = sandbox.launch({
        jobName: `Local\\mindwake-brokertest-${String(Date.now())}`,
        executable: session.launch.executable,
        args: session.launch.args,
        cwd: dirs.work,
        readWriteRoots: [dirs.work],
        readOnlyRoots: [dirs.runtime, ...session.launch.readOnlyRoots],
        protectedPaths: [dirs.build],
        env: { ...session.launch.env, NODE_EXTRA_CA_CERTS: path.join(dirs.runtime, "test-ca.pem") },
        maxProcesses: 8,
        memoryLimitMb: 2048,
        maxWallMs: 60_000,
        broker: session.launch.broker,
      });
      for (;;) {
        const line = await proc.readLine();
        if (line === null) break;
        const step = JSON.parse(line) as Step;
        steps.set(step.step, step);
        if (step.step === "waiting") {
          // Le port du shim, interne au conteneur, est-il joignable depuis l'hôte ?
          const port = Number(new URL(steps.get("env")?.proxy ?? "http://x:1").port);
          shimReachableFromHost = await reachable(port);
          proc.send("done");
        }
      }
      const exit = await proc.exited;
      exitCode = exit.mainExitCode;
      aclRevoked = exit.aclRevoked;
    } finally {
      stats = await session.close();
    }
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    const profile = sandbox.deleteProfile();
    const roots = { readWrite: [dirs.work], readOnly: [dirs.runtime, dirs.shim] };
    const acl = sandbox.aclStatus(roots);
    fs.rmSync(base, { recursive: true, force: true });
    expect(profile.exists).toBe(false);
    expect(profile.registryMapping).toBe(false);
    expect(profile.folder).toBe(false);
    expect(acl.every((a) => !a.granted)).toBe(true);
    expect(fs.existsSync(base)).toBe(false);
  });

  it("le CLI confiné reçoit HTTPS_PROXY vers le shim, sur le loopback du conteneur", () => {
    expect(steps.get("env")?.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(exitCode).toBe(0);
    expect(aclRevoked).toBe(true);
  });

  it("une requête HTTPS vers une destination autorisée passe par le relais", () => {
    expect(steps.get("allowed")).toMatchObject({ ok: true, status: 200, body: "pong" });
    expect(served).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tunnel_opened", host: HOST, port: 443 }),
    );
    expect(stats?.tunnelsOpened).toBe(1);
    expect(stats?.bytesDown).toBeGreaterThan(0);
  });

  it("une destination hors allowlist est refusée par le relais", () => {
    expect(steps.get("denied")?.ok).toBe(false);
    expect(stats?.refusedByReason.destination_not_allowed).toBe(1);
    expect(JSON.stringify(events)).not.toContain("evil.mindwake.test");
  });

  it("une connexion directe hors relais est refusée par le système", () => {
    expect(steps.get("direct_loopback")).toMatchObject({ ok: false });
    expect(steps.get("direct_external")).toMatchObject({ ok: false, error: "EACCES" });
    expect(served).toBe(1);
  });

  it("le port du shim n'est pas joignable depuis l'hôte", () => {
    expect(shimReachableFromHost).toBe(false);
  });
});

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
