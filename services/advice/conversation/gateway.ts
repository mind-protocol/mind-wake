/**
 * Passerelle de conversation locale : expose `ConversationService` sur un pipe nommé.
 * Chaque connexion s'authentifie une fois (`hello`) ; le rôle authentifié borne les
 * opérations permises. Aucune opération hors de la liste nommée du protocole.
 */

import { createServer, type Server, type Socket } from "node:net";
import { assertLocalPipePath, onJsonLines, writeJsonLine } from "./framing.js";
import {
  requestSchema,
  type GuestHelloResult,
  type Request,
  type Response,
  type WireError,
} from "./protocol.js";
import { ConversationError, type ConversationService, type Principal } from "./service.js";

const MAX_IN_FLIGHT_PER_CONNECTION = 8;

interface ConnectionState {
  principal: Principal | null;
  guestGeneration: number | null;
  inFlight: number;
}

export interface Gateway {
  readonly server: Server;
  close(): Promise<void>;
}

export async function startGateway(
  service: ConversationService,
  pipePath: string,
  sweepIntervalMs = 250,
): Promise<Gateway> {
  assertLocalPipePath(pipePath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const state: ConnectionState = { principal: null, guestGeneration: null, inFlight: 0 };
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (state.principal?.kind === "guest" && state.guestGeneration !== null) {
        service.detachGuest(state.principal.invitation, state.guestGeneration);
      }
    });
    onJsonLines(socket, (raw) => {
      const id = readId(raw);
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        reply(socket, id, failure("bad_request", "Requête invalide ou opération inconnue."));
        return;
      }
      if (state.inFlight >= MAX_IN_FLIGHT_PER_CONNECTION) {
        reply(socket, id, failure("limit_reached", "Trop de requêtes simultanées.", true));
        return;
      }
      state.inFlight += 1;
      handle(service, state, parsed.data)
        .then(
          (result) => {
            reply(socket, id, { id, ok: true, result });
          },
          (error: unknown) => {
            reply(socket, id, toFailure(error, id));
          },
        )
        .finally(() => {
          state.inFlight -= 1;
        });
    });
  });
  const sweeper = setInterval(() => {
    service.sweep();
  }, sweepIntervalMs);
  sweeper.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function handle(
  service: ConversationService,
  state: ConnectionState,
  request: Request,
): Promise<unknown> {
  if (request.op === "hello") {
    if (state.principal !== null) {
      throw new ConversationError("bad_request", "Connexion déjà authentifiée.");
    }
    const principal = service.authenticate(request.role, request.key, request.invitation);
    if (principal.kind === "guest") {
      const attached = service.attachGuest(principal);
      state.principal = principal;
      state.guestGeneration = attached.generation;
      return {
        encounterId: attached.encounterId,
        capability: attached.capability,
        selfPseudonym: attached.selfPseudonym,
        counterpartPseudonym: attached.counterpartPseudonym,
        state: attached.state,
      } satisfies GuestHelloResult;
    }
    state.principal = principal;
    return { role: principal.kind };
  }
  const principal = state.principal;
  if (principal === null) {
    throw new ConversationError("not_authenticated", "Authentification requise.");
  }
  switch (request.op) {
    case "open_encounter":
      return service.open(principal, request.invitation, request.requestId);
    case "send":
      requireParticipant(principal);
      return service.send(principal, request);
    case "receive": {
      requireParticipant(principal);
      const first = service.receive(principal, request);
      if (first.messages.length > 0 || request.waitMs === 0) return first;
      await service.waitFor(request.encounterId, request.after, request.waitMs);
      return service.receive(principal, request);
    }
    case "close":
      requireParticipant(principal);
      return service.close(principal, request);
    case "status":
      requireParticipant(principal);
      return service.status(principal, request);
    case "revoke":
      return service.revoke(principal, request.encounterId);
    case "audit":
      return service.audit(principal, request.encounterId);
  }
}

function requireParticipant(principal: Principal): void {
  if (principal.kind === "operator") {
    throw new ConversationError("wrong_role", "L'opérateur ne participe pas à la conversation.");
  }
}

function readId(raw: unknown): number {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = raw.id;
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) return id;
  }
  return -1;
}

function failure(code: WireError["code"], message: string, retryable = false): Response {
  return { id: -1, ok: false, error: { code, message, retryable } };
}

function toFailure(error: unknown, id: number): Response {
  if (error instanceof ConversationError) {
    const wire: WireError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.state === undefined ? {} : { state: error.state }),
    };
    return { id, ok: false, error: wire };
  }
  // Pas de détail interne vers le client : le message d'erreur pourrait contenir des données.
  return {
    id,
    ok: false,
    error: { code: "internal", message: "Erreur interne.", retryable: true },
  };
}

function reply(socket: Socket, id: number, response: Response): void {
  writeJsonLine(socket, { ...response, id });
}
