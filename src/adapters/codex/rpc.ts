/**
 * Client JSON-RPC minimal pour `codex app-server` sur stdio (une ligne JSON par message,
 * sans champ `jsonrpc`). Lit le flux en continu : réponses, notifications et requêtes du
 * serveur. Les requêtes du serveur (demandes d'approbation, outils dynamiques…) sont
 * refusées : Wake ne délègue aucune décision au modèle ni à un humain absent.
 */

import { asRecord, parseLine, type JsonRecord } from "./protocol.js";

/** Canal ligne à ligne d'un processus (forme commune à `ContainedProcess` et `SandboxedProcess`). */
export interface LineChannel {
  readLine(): Promise<string | null>;
  send(line: string): void;
}

export class RpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(method: string, code: number | null, message: string, data: unknown = null) {
    super(`${method} : ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class RpcClosedError extends Error {
  constructor(method: string) {
    super(`${method} : flux app-server fermé avant la réponse`);
    this.name = "RpcClosedError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method} : pas de réponse en ${String(ms)} ms`);
    this.name = "RpcTimeoutError";
  }
}

interface Pending {
  readonly method: string;
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
}

export interface RpcClientOptions {
  readonly onNotification: (method: string, params: JsonRecord) => void;
  /** Fin du flux (processus terminé ou sortie fermée). */
  readonly onClose: () => void;
  readonly requestTimeoutMs: number;
}

/** Code JSON-RPC « method not found », renvoyé aux requêtes du serveur. */
const METHOD_NOT_HANDLED = -32601;

export class RpcClient {
  readonly #channel: LineChannel;
  readonly #options: RpcClientOptions;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #closed = false;
  /** Requêtes du serveur refusées (diagnostic). */
  readonly refusedServerRequests: string[] = [];
  /** Lignes illisibles ignorées (diagnostic). */
  malformedLines = 0;
  readonly done: Promise<void>;

  constructor(channel: LineChannel, options: RpcClientOptions) {
    this.#channel = channel;
    this.#options = options;
    this.done = this.#pump();
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(method: string, params: JsonRecord): Promise<JsonRecord> {
    if (this.#closed) return Promise.reject(new RpcClosedError(method));
    const id = this.#nextId++;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTimeoutError(method, this.#options.requestTimeoutMs));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#channel.send(JSON.stringify({ method, id, params }));
    });
  }

  notify(method: string, params: JsonRecord): void {
    if (!this.#closed) this.#channel.send(JSON.stringify({ method, params }));
  }

  async #pump(): Promise<void> {
    for (;;) {
      const line = await this.#channel.readLine();
      if (line === null) break;
      if (line.trim() === "") continue;
      const message = parseLine(line);
      if (message === null) {
        this.malformedLines += 1;
        continue;
      }
      this.#dispatch(message);
    }
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new RpcClosedError(pending.method));
      this.#pending.delete(id);
    }
    this.#options.onClose();
  }

  #dispatch(message: JsonRecord): void {
    const method = message["method"];
    const id = message["id"];
    if (typeof method === "string") {
      const params = asRecord(message["params"]) ?? {};
      if (id === undefined || id === null) {
        this.#options.onNotification(method, params);
        return;
      }
      this.refusedServerRequests.push(method);
      this.#channel.send(
        JSON.stringify({
          id,
          error: { code: METHOD_NOT_HANDLED, message: "non pris en charge par MIND Wake" },
        }),
      );
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = asRecord(message["error"]);
    if (error !== null) {
      const code = typeof error["code"] === "number" ? error["code"] : null;
      const text = typeof error["message"] === "string" ? error["message"] : "erreur";
      pending.reject(new RpcError(pending.method, code, text.slice(0, 500), error["data"]));
      return;
    }
    pending.resolve(asRecord(message["result"]) ?? {});
  }
}
