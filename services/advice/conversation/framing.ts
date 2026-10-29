/**
 * Transport local : pipe nommé Windows ou socket de domaine Unix, jamais un port TCP.
 * Messages JSON délimités par des sauts de ligne, avec une borne de taille par ligne.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { LIMITS } from "./protocol.js";

export function localPipePath(label = "mind-advice"): string {
  const suffix = randomBytes(8).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${label}-${suffix}`
    : join(tmpdir(), `${label}-${suffix}.sock`);
}

/** Refuse toute adresse qui ne désigne pas un pipe ou une socket locale. */
export function assertLocalPipePath(path: string): void {
  const windowsPipe = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/.test(path);
  const unixSocket = process.platform !== "win32" && path.startsWith("/") && path.endsWith(".sock");
  if (!windowsPipe && !unixSocket) {
    throw new Error("Adresse de transport refusée : seul un pipe ou une socket locale est admis.");
  }
}

/** Découpe un flux en lignes JSON ; une ligne trop longue ferme la connexion. */
export function onJsonLines(socket: Socket, handle: (value: unknown) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > LIMITS.maxLineBytes && !buffer.includes("\n")) {
      socket.destroy();
      return;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > LIMITS.maxLineBytes) {
        socket.destroy();
        return;
      }
      if (line.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        handle(parsed);
      }
      index = buffer.indexOf("\n");
    }
  });
}

export function writeJsonLine(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}
