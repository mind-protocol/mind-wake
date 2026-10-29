import { describe, expect, it } from "vitest";
import type { WakeImage } from "../contracts/wake-image.js";
import { claudeWakeContent, codexWakeInput, freshWakeImage } from "./wake-image.js";
import { userMessageLine } from "./claude/command.js";
const make = (): WakeImage => ({
  mediaType: "image/jpeg",
  base64: Buffer.from([255, 216, 255, 217]).toString("base64"),
  width: 440,
  height: 680,
  capturedAt: new Date().toISOString(),
  surface: "wake-window",
});
describe("visual wake context", () => {
  it("preserves text-only messages when no image is authorized", () => {
    expect(claudeWakeContent("Where was I?")).toBe("Where was I?");
    expect(codexWakeInput("Where was I?")).toEqual([{ type: "text", text: "Where was I?" }]);
  });
  it("sends image data as native Claude content, not as system text", () => {
    const image = make();
    const line = JSON.parse(userMessageLine("Where was I?", image));
    expect(line.message.role).toBe("user");
    expect(line.message.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: image.base64 },
    });
    expect(line.message.content[1].text).toContain("untrusted screen content");
  });
  it("sends an inline Codex image and a timestamped caption", () => {
    const image = make();
    expect(codexWakeInput("Where was I?", image)[0]).toEqual({
      type: "image",
      url: "data:image/jpeg;base64," + image.base64,
    });
    expect(codexWakeInput("Where was I?", image)[1]?.text).toContain(image.capturedAt);
  });
  it("drops expired or future captures instead of reusing them", () => {
    const image = make();
    expect(
      freshWakeImage({ ...image, capturedAt: new Date(Date.now() - 16000).toISOString() }),
    ).toBeNull();
    expect(
      freshWakeImage({ ...image, capturedAt: new Date(Date.now() + 10000).toISOString() }),
    ).toBeNull();
  });
  it("rejects invalid, oversized or unsupported image content", () => {
    const image = make();
    for (const invalid of [
      { ...image, width: 1281 },
      { ...image, base64: "secret text" },
      { ...image, base64: "a".repeat(1400001) },
      { ...image, surface: "other" },
    ])
      expect(freshWakeImage(invalid as WakeImage)).toBeNull();
  });
});
