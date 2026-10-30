import { BUMP_TEXT } from "./chat-presence.js";
// Protocol reserve covers worst-case physical coordinates and timestamp; tested against CLI.
export const BUMPE_CONTEXT_RESERVE = 768;
const POINT_INVITATION = "\n\nBumpe — relance ciblée : ton humain t’invite à contribuer à partir du point précis de son clic droit, cerclé en rouge dans la capture jointe. Relie ta proposition ou ta question à ce point et explique son contexte et sa valeur pour la conversation. Le texte éventuellement en cours de saisie dans le menu reste un brouillon séparé.";
/** Fall back to the complete invitation; never cut off final instructions from the file. */
export function pointBumpText(invitation: string): string {
  const chosen = invitation.length + POINT_INVITATION.length + BUMPE_CONTEXT_RESERVE <= 4000 ? invitation : BUMP_TEXT;
  return chosen + POINT_INVITATION;
}

export interface PointIntent { key: string; text: string; clickId: number; kind: "message" | "bumpe" }

/** A failed send retains the same invitation and key, including a prompt edited meanwhile. */
export class PointSendIntent {
  private pending: PointIntent | null = null;
  private uncertain = false;
  prepare(kind: PointIntent["kind"], text: string, clickId: number, key: () => string): PointIntent {
    if (this.pending?.kind === kind && (this.uncertain || this.pending.clickId === clickId) && (kind === "bumpe" || this.pending.text === text)) return this.pending;
    this.pending = {kind, text, clickId, key:key()};
    return this.pending;
  }
  current(kind: PointIntent["kind"], clickId: number): PointIntent | null {
    return this.pending?.kind === kind && (this.uncertain || this.pending.clickId === clickId) ? this.pending : null;
  }
  unconfirmed(): void { this.uncertain = true; }
  isUnconfirmed(): boolean { return this.uncertain; }
  complete(): void { this.pending = null; this.uncertain = false; }
}
