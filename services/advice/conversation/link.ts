/**
 * Client du protocole filaire, utilisé par l'adaptateur MCP, l'agent guest factice et
 * les tests. Ne connaît que les opérations nommées ; une erreur serveur devient une
 * `LinkError` portant le code du protocole.
 */

import { connect, type Socket } from "node:net";
import { assertLocalPipePath, onJsonLines, writeJsonLine } from "./framing.js";
import type { Request, Response, WireError } from "./protocol.js";

export class LinkError extends Error {
  readonly error: WireError;

  constructor(error: WireError) {
    super(`${error.code}: ${error.message}`);
    this.name = "LinkError";
    this.error = error;
  }
}

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
};

/** Requête sans `id` : le client le numérote lui-même. */
export type LinkRequest = Request extends infer R
  ? R extends Request
    ? Omit<R, "id">
    : never
  : never;

export class GatewayLink {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    onJsonLines(socket, (raw) => {
      const response = raw as Response;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new LinkError(response.error));
    });
    socket.on("close", () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Connexion à la passerelle fermée."));
      }
      this.#pending.clear();
    });
    socket.on("error", () => socket.destroy());
  }

  static async connect(pipePath: string): Promise<GatewayLink> {
    assertLocalPipePath(pipePath);
    const socket = connect(pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new GatewayLink(socket);
  }

  get closed(): boolean {
    return this.#closed;
  }

  call<T>(request: LinkRequest): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Connexion à la passerelle fermée."));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
      writeJsonLine(this.#socket, { ...request, id });
    });
  }

  /** Envoie une ligne arbitraire : réservé aux tests de requêtes falsifiées. */
  sendRaw(value: unknown): void {
    writeJsonLine(this.#socket, value);
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }
}
