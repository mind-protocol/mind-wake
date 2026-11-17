import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateAssignment, type ForkAssignment } from "../daemon/fork-assignment.js";
import { roomNameHandle, telegramHandleTable } from "./telegram-handle-route.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function dataDirWithRooms(rooms: readonly number[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handle-route-"));
  dirs.push(dir);
  for (const room of rooms) fs.mkdirSync(path.join(dir, "forks", String(room)), { recursive: true });
  return dir;
}

// NLR, 16 nov. 2026 : « renommons les rooms avec les noms de projet ».
it("dérive un handle du nom : minuscules, sans accents ni ponctuation", () => {
  expect(roomNameHandle("Médicis")).toBe("medicis");
  expect(roomNameHandle("Rose des Vents")).toBe("rosedesvents");
  expect(roomNameHandle("La Toile")).toBe("latoile");
  expect(roomNameHandle("Équerre")).toBe("equerre");
  expect(roomNameHandle("—")).toBeNull();
});

it("une room nommée se joint par son nom et par @roomN, sous son nom", () => {
  const instructions = path.join(os.tmpdir(), "DEPART.md");
  const assignments: Record<number, ForkAssignment> = {
    3: validateAssignment({ instructions, name: "Médicis" }),
    4: validateAssignment({
      instructions,
      name: "Rose des Vents",
      agents: [{ id: "medicis", name: "Agent Médicis", instructions }],
    }),
  };
  const table = telegramHandleTable(dataDirWithRooms([3, 4, 5, 7]), (room) => assignments[room] ?? null, () => []);
  expect(table.get("medicis")).toMatchObject({ room: 3, agent: null, label: "Médicis (Room 3)" });
  expect(table.get("room3")).toMatchObject({ room: 3, agent: null, label: "Médicis (Room 3)" });
  expect(table.get("rosedesvents")).toMatchObject({ room: 4, agent: null, label: "Rose des Vents (Room 4)" });
  expect(table.get("room4")?.room).toBe(4);
  // Room sans nom : « Room N » ; Room 7 garde sa signature historique.
  expect(table.get("room5")?.label).toBe("Room 5");
  expect(table.get("vox")).toMatchObject({ room: 7, label: "VOX (Room 7)" });
});
