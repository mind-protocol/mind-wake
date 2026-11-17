import { expect, it } from "vitest";
import { agentTint } from "./author-tint.js";
import { roomName, setRoomLabels } from "./room-name.js";

// NLR 15 nov. 2026 : holders en jaune, VOX en violet ; Marco, Vox et « Room N » à l'écran.
it("reads the author from existing signatures, without mistaking the fast reply", () => {
  expect(agentTint("🪙 Crypto · Le token reste au collectif.")).toBe("holder");
  expect(agentTint("🧭 Pattern holder · Pourquoi ce choix ?", 7)).toBe("holder");
  expect(agentTint("VOX (Room 7) : bonjour NLR")).toBe("vox");
  expect(agentTint("VOX (Fork 7) : ancien message")).toBe("vox");
  expect(agentTint("Je reprends la maquette.", 7)).toBe("vox");
  expect(agentTint("⚡ réponse rapide · c'est noté", 7)).toBeNull();
  expect(agentTint("Je reprends la maquette.", 3)).toBeNull();
});

it("names rooms for display only", () => {
  expect([1, 2, 7, 8].map(roomName)).toEqual(["Marco", "Room 2", "Vox", "Room 8"]);
});

// NLR, 16 nov. 2026 : « renommons les rooms avec les noms de projet ».
it("shows the room label sent by the runtime, Marco stays Marco", () => {
  setRoomLabels([{ id: 1, label: "X" }, { id: 3, label: "Médicis" }, { id: 7, label: "VOX" }, { id: 8, label: "" }]);
  expect([1, 3, 7, 8].map(roomName)).toEqual(["Marco", "Médicis", "VOX", "Room 8"]);
  setRoomLabels([]);
  expect([3, 7].map(roomName)).toEqual(["Room 3", "Vox"]);
});
