/**
 * Client du protocole du hub, utilisé par l'adaptateur MCP. Reconnexion paresseuse et
 * authentification par la clé de liaison de l'environnement, jamais exposée au modèle.
 */

import { connect, type Socket } from "node:net";
import { assertLocalPipePath, onJsonLines, writeJsonLine } from "../advice/conversation/framing.js";
import { HUB_PROTOCOL_VERSION, HubError, type HubRequest, type HubResponse } from "./protocol.js";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

/** Requête sans `id` : le client numérote lui-même. */
export type HubCall = HubRequest extends infer R
  ? R extends HubRequest
    ? Omit<R, "id">
    : never
  : never;

class Connection {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  closed = false;

  constructor(socket: Socket) {
    this.#socket = socket;
    onJsonLines(socket, (raw) => {
      const response = raw as HubResponse;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else
        pending.reject(
          new HubError(response.error.code, response.error.message, response.error.retryable),
        );
    });
    socket.on("close", () => {
      this.closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new HubError("internal", "Connexion au hub fermée.", true));
      }
      this.#pending.clear();
    });
    socket.on("error", () => socket.destroy());
  }

  call(request: HubCall): Promise<unknown> {
    if (this.closed) return Promise.reject(new HubError("internal", "Hub injoignable.", true));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      writeJsonLine(this.#socket, { ...request, id });
    });
  }
}

export class HubLink {
  readonly #pipe: string;
  readonly #key: string;
  #connection: Promise<Connection> | null = null;

  constructor(pipe: string, key: string) {
    assertLocalPipePath(pipe);
    this.#pipe = pipe;
    this.#key = key;
  }

  async #connect(): Promise<Connection> {
    if (this.#connection !== null) {
      const current = await this.#connection.catch(() => null);
      if (current !== null && !current.closed) return current;
    }
    this.#connection = (async () => {
      const socket = connect(this.#pipe);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", () => {
          reject(new HubError("internal", "Hub injoignable.", true));
        });
      });
      const connection = new Connection(socket);
      await connection.call({ op: "hello", version: HUB_PROTOCOL_VERSION, key: this.#key });
      return connection;
    })();
    return this.#connection;
  }

  async call<T>(request: HubCall): Promise<T> {
    const connection = await this.#connect();
    return (await connection.call(request)) as T;
  }
}
