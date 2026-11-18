/**
 * Participants de la room ouverte (NLR, 18 nov. 2026 14:19 : les holders « assignés à des salles
 * comme des agents normaux »). Le runtime rend `participants` pour chaque room : agents de room
 * et pattern holders (🟡, comme leurs bulles). Affichage seulement.
 */
import { tr } from "./i18n.js";

export interface RoomParticipantView {
  id: string;
  name: string;
  kind: "agent" | "holder";
  emoji?: string;
  missing?: true;
}

/** Participants valides d'une vue de room ; tout objet inattendu est ignoré. */
export function participantsOf(fork: object): RoomParticipantView[] {
  const raw = (fork as { participants?: unknown }).participants;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is RoomParticipantView =>
    p !== null && typeof p === "object" &&
    typeof (p as RoomParticipantView).id === "string" &&
    typeof (p as RoomParticipantView).name === "string" &&
    ((p as RoomParticipantView).kind === "agent" || (p as RoomParticipantView).kind === "holder"));
}

/** Texte d'un participant : « 🟡 🧭 Crypto (holder) », « Coach Colony ». */
export function participantLabel(p: RoomParticipantView): string {
  if (p.kind === "agent") return p.name;
  const missing = p.missing ? ` · ${tr("introuvable")}` : "";
  return `🟡 ${p.emoji ? `${p.emoji} ` : ""}${p.name} (${tr("holder")}${missing})`;
}

/** Remplit la ligne des participants ; masquée quand la room n'en a aucun. */
export function renderRoomParticipants(target: HTMLElement, fork: object): void {
  const list = participantsOf(fork);
  target.hidden = list.length === 0;
  if (list.length === 0) {
    target.replaceChildren();
    return;
  }
  const items = list.map((p) => {
    const chip = document.createElement("span");
    chip.className = `room-participant room-participant-${p.kind}`;
    chip.dataset["participant"] = p.id;
    chip.title = `@${p.id}`;
    chip.textContent = participantLabel(p);
    return chip;
  });
  const label = document.createElement("strong");
  label.textContent = `${tr("Participants")} : `;
  target.replaceChildren(label, ...items);
}
