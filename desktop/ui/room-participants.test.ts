import { expect, it } from "vitest";
import { participantLabel, participantsOf } from "./room-participants.js";

it("keeps valid participants and labels holders apart from agents", () => {
  const list = participantsOf({ participants: [
    { id: "coach-a", name: "Coach A", kind: "agent" },
    { id: "crypto", name: "Crypto", kind: "holder", emoji: "🪙" },
    { id: "absent", name: "absent", kind: "holder", missing: true },
    { id: 3, name: "invalide", kind: "agent" },
    null,
  ] });
  expect(list.map((p) => p.id)).toEqual(["coach-a", "crypto", "absent"]);
  expect(participantLabel(list[0]!)).toBe("Coach A");
  expect(participantLabel(list[1]!)).toMatch(/^🟡 🪙 Crypto \(holder\)$/);
  expect(participantLabel(list[2]!)).toMatch(/absent \(holder · (introuvable|not found)\)/);
  expect(participantsOf({})).toEqual([]);
});
