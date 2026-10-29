/**
 * Relais fournisseur hors conteneur (ADR-002, ADR-005) : proxy HTTP `CONNECT` sur
 * `127.0.0.1`, joint par le lanceur confiné qui y relaie le pipe broker. C'est la seule
 * route réseau du conteneur.
 *
 * Pour chaque tunnel : cible `hôte:443` d'un nom de l'allowlist du runtime (jamais une IP
 * littérale), résolution DNS par l'hôte et refus de toute adresse interdite (loopback,
 * privé, lien local, métadonnées), puis contrôle du nom TLS (SNI) du premier message du
 * client avant d'ouvrir la connexion amont vers l'adresse vérifiée. Tout le reste reçoit
 * un refus et une entrée de journal. Le relais ne termine pas TLS : il ne voit ni les
 * requêtes, ni les credentials, ni les en-têtes de limitation du fournisseur.
 *
 * Journal expurgé : un nom refusé est remplacé par son empreinte et sa longueur (l'agent
 * pourrait y coder un secret), aucun en-tête n'est consigné, aucun octet du flux.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { NetworkDestination } from "../contracts/index.js";
import type { ProviderBroker } from "../sandbox/broker.js";
import { isForbiddenAddress, parseConnectTarget, type ConnectTarget } from "./address.js";
import { normalizeHost, type ProviderRuntime } from "./destinations.js";
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from "./sni.js";

export type RelayRefusal =
  | "method_not_allowed"
  | "malformed_target"
  | "ip_literal"
  | "destination_not_allowed"
  | "port_not_allowed"
  | "resolution_failed"
  | "forbidden_address"
  | "not_tls"
  | "sni_missing"
  | "sni_mismatch"
  | "client_hello_timeout"
  | "too_many_tunnels"
  | "upstream_unreachable"
  | "relay_closed";

export interface RelayEvent {
  readonly at: string;
  readonly kind: "tunnel_opened" | "tunnel_closed" | "refused";
  readonly runtime: ProviderRuntime;
  readonly connection: number;
  /** Hôte de l'allowlist ; absent pour une cible refusée avant ce contrôle. */
  readonly host?: string;
  readonly port?: number;
  /** Cible refusée hors allowlist : empreinte SHA-256 tronquée et longueur, jamais le nom. */
  readonly targetDigest?: string;
  readonly targetLength?: number;
  readonly reason?: RelayRefusal;
  /** Adresse amont vérifiée. */
  readonly address?: string;
  readonly bytesUp?: number;
  readonly bytesDown?: number;
  readonly durationMs?: number;
  /** Fin du tunnel : qui l'a fermé, et si c'était une erreur réseau. */
  readonly closedBy?: "client" | "upstream" | "idle" | "relay";
  readonly error?: boolean;
}

/** Ce que le relais observe sans terminer TLS : volumes, tunnels, échecs amont. */
export interface RelayStats {
  readonly tunnelsOpened: number;
  readonly tunnelsActive: number;
  readonly refused: number;
  readonly refusedByReason: Readonly<Partial<Record<RelayRefusal, number>>>;
  readonly bytesUp: number;
  readonly bytesDown: number;
  /** Connexions amont fermées sur erreur (reset, délai) : indice indirect seulement. */
  readonly upstreamErrors: number;
  readonly byHost: Readonly<Record<string, { readonly tunnels: number; readonly bytes: number }>>;
}

/** Accès réseau amont, injectable pour les tests (serveur HTTPS local). */
export interface RelayUpstream {
  lookup(host: string): Promise<readonly string[]>;
  isForbidden(address: string): boolean;
  connect(address: string, port: number): net.Socket;
}

export const DIRECT_UPSTREAM: RelayUpstream = {
  async lookup(host) {
    const found = await dnsLookup(host, { all: true, order: "verbatim" });
    return found.map((entry) => entry.address);
  },
  isForbidden: isForbiddenAddress,
  connect: (address, port) => net.connect({ host: address, port }),
};

export interface ProviderRelayOptions {
  readonly runtime: ProviderRuntime;
  readonly destinations: readonly NetworkDestination[];
  readonly journal?: (event: RelayEvent) => void;
  readonly upstream?: RelayUpstream;
  readonly maxTunnels?: number;
  readonly clientHelloTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly now?: () => Date;
}

const STATUS: Readonly<Record<RelayRefusal, number>> = {
  method_not_allowed: 405,
  malformed_target: 400,
  ip_literal: 403,
  destination_not_allowed: 403,
  port_not_allowed: 403,
  resolution_failed: 502,
  forbidden_address: 403,
  not_tls: 403,
  sni_missing: 403,
  sni_mismatch: 403,
  client_hello_timeout: 408,
  too_many_tunnels: 503,
  upstream_unreachable: 502,
  relay_closed: 503,
};

export class ProviderRelay implements ProviderBroker {
  readonly runtime: ProviderRuntime;
  #allow: ReadonlyMap<string, readonly number[]>;
  #journal: (event: RelayEvent) => void;
  #upstream: RelayUpstream;
  #maxTunnels: number;
  #helloTimeout: number;
  #idleTimeout: number;
  #now: () => Date;
  #server: http.Server;
  #sockets = new Set<net.Socket>();
  #closed = false;
  #nextId = 1;
  #stats = {
    tunnelsOpened: 0,
    tunnelsActive: 0,
    refused: 0,
    refusedByReason: {} as Partial<Record<RelayRefusal, number>>,
    bytesUp: 0,
    bytesDown: 0,
    upstreamErrors: 0,
    byHost: {} as Record<string, { tunnels: number; bytes: number }>,
  };

  constructor(options: ProviderRelayOptions) {
    this.runtime = options.runtime;
    const allow = new Map<string, number[]>();
    for (const dest of options.destinations) {
      const host = normalizeHost(dest.host);
      allow.set(host, [...(allow.get(host) ?? []), ...dest.ports]);
    }
    this.#allow = allow;
    this.#journal = options.journal ?? (() => undefined);
    this.#upstream = options.upstream ?? DIRECT_UPSTREAM;
    this.#maxTunnels = options.maxTunnels ?? 32;
    this.#helloTimeout = options.clientHelloTimeoutMs ?? 10_000;
    this.#idleTimeout = options.idleTimeoutMs ?? 15 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 });
    this.#server.on("connection", (socket: net.Socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    // Requête ordinaire (proxy HTTP en clair, URL absolue) : refusée.
    this.#server.on("request", (_req: http.IncomingMessage, res: http.ServerResponse) => {
      const id = this.#nextId++;
      this.#refuse(id, "method_not_allowed", {});
      res.writeHead(405, { connection: "close", "content-type": "text/plain" });
      res.end("CONNECT only\n");
    });
    this.#server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      void this.#tunnel(req, socket, head);
    });
  }

  async listen(): Promise<{ readonly port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    return { port: this.port };
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("relais non démarré");
    return address.port;
  }

  stats(): RelayStats {
    const s = this.#stats;
    return {
      ...s,
      refusedByReason: { ...s.refusedByReason },
      byHost: Object.fromEntries(Object.entries(s.byHost).map(([k, v]) => [k, { ...v }])),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async #tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const id = this.#nextId++;
    const begin = performance.now();
    client.on("error", () => undefined);
    const deny = (reason: RelayRefusal, extra: Partial<RelayEvent>): void => {
      this.#refuse(id, reason, extra);
      if (client.writable) {
        client.end(`HTTP/1.1 ${String(STATUS[reason])} Refused\r\nConnection: close\r\n\r\n`);
      }
      client.destroySoon();
    };

    const admitted = await this.#admit(req.url);
    if (!admitted.ok) {
      deny(admitted.reason, admitted.extra);
      return;
    }
    const { target, address } = admitted;
    const where = { host: target.host, port: target.port };

    this.#stats.tunnelsActive += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#stats.tunnelsActive -= 1;
    };
    client.on("close", release);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const hello = await readClientHello(client, head, this.#helloTimeout);
    if (hello.kind !== "ok") {
      release();
      this.#refuse(id, hello.kind, { ...where, address });
      client.destroy();
      return;
    }
    if (hello.sni !== target.host) {
      release();
      this.#refuse(id, hello.sni === null ? "sni_missing" : "sni_mismatch", { ...where, address });
      client.destroy();
      return;
    }

    const upstream = this.#upstream.connect(address, target.port);
    let opened = false;
    let closedBy: NonNullable<RelayEvent["closedBy"]> = "relay";
    let error = false;
    let up = 0;
    let down = 0;
    const finish = (): void => {
      release();
      client.destroy();
      upstream.destroy();
      if (!opened) return;
      opened = false;
      const host = (this.#stats.byHost[target.host] ??= { tunnels: 0, bytes: 0 });
      host.bytes += up + down;
      if (error && closedBy === "upstream") this.#stats.upstreamErrors += 1;
      this.#emit({
        kind: "tunnel_closed",
        connection: id,
        ...where,
        address,
        bytesUp: up,
        bytesDown: down,
        durationMs: Math.round(performance.now() - begin),
        closedBy,
        error,
      });
    };
    upstream.once("connect", () => {
      opened = true;
      this.#stats.tunnelsOpened += 1;
      (this.#stats.byHost[target.host] ??= { tunnels: 0, bytes: 0 }).tunnels += 1;
      this.#emit({ kind: "tunnel_opened", connection: id, ...where, address });
      upstream.write(hello.bytes);
      up += hello.bytes.length;
      this.#stats.bytesUp += hello.bytes.length;
      client.on("data", (chunk: Buffer) => {
        up += chunk.length;
        this.#stats.bytesUp += chunk.length;
      });
      upstream.on("data", (chunk: Buffer) => {
        down += chunk.length;
        this.#stats.bytesDown += chunk.length;
      });
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => {
      if (!opened) {
        release();
        this.#refuse(id, "upstream_unreachable", { ...where, address });
        client.destroy();
        return;
      }
      error = true;
      closedBy = "upstream";
    });
    client.once("error", () => {
      error = true;
      closedBy = "client";
    });
    client.once("end", () => {
      closedBy = "client";
      upstream.end();
    });
    upstream.once("end", () => {
      closedBy = "upstream";
      client.end();
    });
    upstream.setTimeout(this.#idleTimeout, () => {
      closedBy = "idle";
      finish();
    });
    client.once("close", finish);
    upstream.once("close", () => {
      if (opened) finish();
    });
  }

  /** Cible, allowlist, nombre de tunnels, puis résolution DNS et filtre d'adresses. */
  async #admit(
    url: string | undefined,
  ): Promise<
    | { readonly ok: true; readonly target: ConnectTarget; readonly address: string }
    | { readonly ok: false; readonly reason: RelayRefusal; readonly extra: Partial<RelayEvent> }
  > {
    const no = (reason: RelayRefusal, extra: Partial<RelayEvent> = {}) =>
      ({ ok: false, reason, extra }) as const;
    if (this.#closed) return no("relay_closed");
    const parsed = parseConnectTarget(url);
    if (!parsed.ok) return no(parsed.reason, digest(url ?? ""));
    const target = parsed.target;
    const ports = this.#allow.get(target.host);
    if (ports === undefined) return no("destination_not_allowed", digest(target.host));
    const where = { host: target.host, port: target.port };
    if (!ports.includes(target.port)) return no("port_not_allowed", where);
    if (this.#stats.tunnelsActive >= this.#maxTunnels) return no("too_many_tunnels", where);
    let addresses: readonly string[];
    try {
      addresses = await this.#upstream.lookup(target.host);
    } catch {
      return no("resolution_failed", where);
    }
    const address = addresses.find((a) => !this.#upstream.isForbidden(a));
    if (address !== undefined) return { ok: true, target, address };
    return no(addresses.length > 0 ? "forbidden_address" : "resolution_failed", where);
  }

  #refuse(id: number, reason: RelayRefusal, extra: Partial<RelayEvent>): void {
    this.#stats.refused += 1;
    this.#stats.refusedByReason[reason] = (this.#stats.refusedByReason[reason] ?? 0) + 1;
    this.#emit({ kind: "refused", connection: id, reason, ...extra });
  }

  #emit(event: Omit<RelayEvent, "at" | "runtime">): void {
    try {
      this.#journal({ at: this.#now().toISOString(), runtime: this.runtime, ...event });
    } catch {
      // Le journal ne doit pas pouvoir casser le relais.
    }
  }
}

function digest(raw: string): Pick<RelayEvent, "targetDigest" | "targetLength"> {
  return {
    targetDigest: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    targetLength: raw.length,
  };
}

type HelloRead =
  | { readonly kind: "ok"; readonly sni: string | null; readonly bytes: Buffer }
  | { readonly kind: "not_tls" | "client_hello_timeout" };

/** Lit le ClientHello du client (tamponné, transmis ensuite tel quel à l'amont). */
function readClientHello(client: net.Socket, head: Buffer, timeoutMs: number): Promise<HelloRead> {
  return new Promise((resolve) => {
    let buffer = head;
    let settled = false;
    const done = (result: HelloRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.off("close", onClose);
      client.pause();
      resolve(result);
    };
    const check = (): void => {
      const parse = parseClientHello(buffer);
      if (parse.kind === "incomplete") {
        if (buffer.length > MAX_CLIENT_HELLO_BYTES) done({ kind: "not_tls" });
        return;
      }
      if (parse.kind === "not_tls") {
        done({ kind: "not_tls" });
        return;
      }
      done({ kind: "ok", sni: parse.kind === "sni" ? parse.name : null, bytes: buffer });
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      check();
    };
    const onClose = (): void => {
      done({ kind: "not_tls" });
    };
    const timer = setTimeout(() => {
      done({ kind: "client_hello_timeout" });
    }, timeoutMs);
    client.on("data", onData);
    client.on("close", onClose);
    if (buffer.length > 0) check();
  });
}
