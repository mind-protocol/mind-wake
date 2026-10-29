/**
 * Client de test d'un proxy `CONNECT` : envoie la requête, lit la réponse du relais, puis
 * ouvre TLS dans le tunnel et émet une requête HTTP. Aucun appel à un vrai fournisseur.
 */

import net from "node:net";
import tls from "node:tls";

export interface ConnectOutcome {
  /** Code de la réponse au `CONNECT` ; `null` si la connexion a été coupée avant. */
  readonly status: number | null;
  /** Corps HTTP reçu dans le tunnel ; `null` si TLS ou la requête ont échoué. */
  readonly body: string | null;
  readonly tlsError?: string;
}

export interface ConnectOptions {
  readonly relayPort: number;
  readonly target: string;
  /** Nom TLS présenté (SNI) ; par défaut l'hôte de la cible. */
  readonly servername?: string;
  readonly ca?: string;
  readonly headers?: readonly string[];
  /** Données envoyées dans le tunnel à la place d'une poignée TLS. */
  readonly raw?: string;
  readonly timeoutMs?: number;
}

export function connectVia(options: ConnectOptions): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: options.relayPort });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status, body: null, tlsError: "timeout" });
    }, options.timeoutMs ?? 5_000);
    let status: number | null = null;
    let head = "";
    const finish = (outcome: ConnectOutcome): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    socket.on("error", () => {
      finish({ status, body: null, tlsError: "socket" });
    });
    socket.on("close", () => {
      finish({ status, body: null, tlsError: "closed" });
    });
    socket.on("connect", () => {
      const extra = (options.headers ?? []).map((h) => `${h}\r\n`).join("");
      socket.write(`CONNECT ${options.target} HTTP/1.1\r\nHost: ${options.target}\r\n${extra}\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? NaN);
      if (status !== 200) {
        finish({ status, body: null });
        return;
      }
      if (options.raw !== undefined) {
        socket.write(options.raw);
        return;
      }
      const host = options.target.replace(/:\d+$/, "");
      const secure = tls.connect({
        socket,
        servername: options.servername ?? host,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        checkServerIdentity: () => undefined,
      });
      let body = "";
      let secured = false;
      secure.on("secureConnect", () => {
        secured = true;
        secure.write(`GET /ping HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      secure.on("data", (d: Buffer) => (body += d.toString("utf8")));
      secure.on("end", () => {
        if (!secured) {
          finish({ status, body: null, tlsError: "closed before handshake" });
          return;
        }
        finish({ status, body: body.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
      });
      secure.on("error", (error: Error) => {
        finish({ status, body: null, tlsError: error.message });
      });
    };
    socket.on("data", onData);
  });
}
