/**
 * Contrôles de contenu appliqués par la passerelle, quel que soit le comportement des
 * participants : un message ne transporte ni secret reconnaissable, ni chemin privé, ni
 * identifiant privé d'une partie (SPEC §15.2–15.3). Le refus est explicite : rien n'est
 * réécrit en silence.
 */

import { redactPrivatePaths, redactString } from "../../../src/journal/redact.js";
import type { ErrorCode } from "./protocol.js";

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export function checkMessageText(
  text: string,
  privateIdentifiers: readonly string[],
): GuardVerdict {
  if (text.trim().length === 0) {
    return { ok: false, code: "empty_message", message: "Message vide refusé." };
  }
  if (redactString(text) !== text || redactPrivatePaths(text) !== text) {
    return {
      ok: false,
      code: "sensitive_content_refused",
      message:
        "Le message contient un secret ou un chemin privé reconnaissable ; rien n'a été envoyé.",
    };
  }
  const lowered = text.toLowerCase();
  if (privateIdentifiers.some((id) => id.length > 0 && lowered.includes(id.toLowerCase()))) {
    return {
      ok: false,
      code: "private_identifier_refused",
      message: "Le message contient un identifiant privé d'une partie ; rien n'a été envoyé.",
    };
  }
  return { ok: true };
}
