import { beforeEach, expect, vi } from "vitest";

// Existing UI assertions describe the French interface. Pin their browser locale
// explicitly instead of depending on the machine running the tests.
if (expect.getState().testPath?.replaceAll("\\", "/").includes("/desktop/ui/")) {
  const pinFrench = (): void => { vi.stubGlobal("navigator", { language: "fr-FR", languages: ["fr-FR"] }); };
  pinFrench();
  beforeEach(pinFrench);
}
