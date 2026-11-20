import { expect, it, vi } from "vitest";
import { appendHumanDictation } from "./conversation-item-microphone.js";

it("appends human dictation to the selected passage without overwriting other edits", async () => {
  let text = "**Marco —** Proposition.\n\n**Coach —** Nouvelle correction.";
  const edit = vi.fn(async (request: Record<string, unknown>) => {
    if (request["action"] === "principalSave") {
      expect(request["revision"]).toBe("latest");
      text = String(request["text"]);
    }
    return {text, revision: "latest"};
  });
  const first = await appendHumanDictation("artifacts/principal/01.md", "Proposition.", "Mon ajout.", edit);
  await appendHumanDictation("artifacts/principal/01.md", first, "La suite.", edit);
  expect(text).toBe("**Marco —** Proposition.\n\n**Humain :** Mon ajout.\n\n**Humain :** La suite.\n\n**Coach —** Nouvelle correction.");
});

it("refuses to append to a changed or ambiguous passage", async () => {
  const edit = vi.fn(async () => ({text: "**Marco —** Proposition révisée.", revision: "new"}));
  await expect(appendHumanDictation("artifacts/principal/01.md", "Proposition.", "Mon ajout", edit)).rejects.toThrow("changé");
  expect(edit).toHaveBeenCalledTimes(1);
});

it("propagates a save conflict rather than reporting the dictation saved", async () => {
  const edit = vi.fn(async (request: Record<string, unknown>) => {
    if (request["action"] === "principalSave") throw Error("Version modifiée");
    return {text: "**Marco —** Proposition.", revision: "old"};
  });
  await expect(appendHumanDictation("artifacts/principal/01.md", "Proposition.", "Mon ajout", edit)).rejects.toThrow("Version modifiée");
});
