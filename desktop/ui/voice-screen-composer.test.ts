import { afterEach, expect, it, vi } from "vitest";
import { voiceScreenComposer } from "./voice-screen-composer.js";

const at = (seconds: number) => new Date(seconds * 1000).toISOString();
const sample = (seconds: number, left: number, right = 20, spinner = 0, nearby = 0, typed = 0) =>
  JSON.stringify({ capturedAt: at(seconds), base64: btoa(String.fromCharCode(left, right, spinner, nearby, typed)) });

function canvasFixture() {
  const written: number[] = [];
  vi.stubGlobal("ImageData", class {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  });
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
    width: 128, height: 64, pixels: new Uint8Array(await blob.arrayBuffer()), close() {},
  }));
  vi.stubGlobal("document", {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,AA==" };
      let pixels: Uint8Array;
      let stabilized: ImageData | undefined;
      const ctx = {
        canvas,
        drawImage(image: {pixels: Uint8Array}) { pixels = image.pixels; },
        getImageData(x: number, y: number, width: number, height: number) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let i = 0; i < data.length; i++) {
            const px = x + Math.floor(i / 4) % width, py = y + Math.floor(i / (width * 4));
            const near = pixels[3] && py >= 29 && py < 35 &&
              ((px >= 53 && px < 58) || (px >= 66 && px < 70));
            const ink = py >= 27 && py < 33 && px >= 22 && px < 22 + pixels[4]! * 12 && px % 12 < 8;
            data[i] = stabilized?.data[(py * 128 + px) * 4 + i % 4] ??
              (ink ? 22 : pixels[near ? 3 : px >= 6 && px < 14 && py >= 6 && py < 14 ? 2 : px < 64 ? 0 : 1]!);
          }
          return { width, height, data };
        },
        fillRect() {}, fillText() {},
        putImageData(image: ImageData) { if (pixels) stabilized = image; else written.push(image.width); },
      };
      return canvas;
    },
  });
  return written;
}

afterEach(() => vi.unstubAllGlobals());

it("keeps a brief menu and reuses any exact tile state previously sent at that position", async () => {
  const written = canvasFixture();
  const composer = voiceScreenComposer();
  const baseline = await composer.compose([sample(0, 10)], at(0), () => true);
  expect(baseline.images).toHaveLength(1);
  baseline.commit();
  const menu = await composer.compose([sample(33, 10), sample(34, 30), sample(35, 10)], at(30), () => true);
  expect(menu.images).toHaveLength(1);
  expect(menu.references).toContain("+5.0s retour à E1.1 (0,0, 64×64)");
  expect(written).toEqual([128, 64]);
  menu.commit();
  const repeat = await composer.compose([sample(62, 30), sample(63, 10)], at(60), () => true);
  expect(repeat.images).toEqual([]);
  expect(repeat.references).toContain("+2.0s retour à E2.1");
  expect(repeat.references).toContain("+3.0s retour à E1.1");
});

it("suppresses a fast localized animation without losing a menu in the same tile", async () => {
  const written = canvasFixture();
  const composer = voiceScreenComposer();
  const frames = Array.from({ length: 10 }, (_, index) => sample(index / 5, index === 8 ? 90 : 10, 20, index % 2 ? 80 : 0));
  const draft = await composer.compose(frames, at(0), () => true);
  expect(written).toEqual([128, 64]);
  expect(draft.references).toContain("+1.8s retour à E1.1");
});

it("rejects replay grain but keeps a menu visible for only one sample", async () => {
  const written = canvasFixture();
  const composer = voiceScreenComposer({ compressedReplay: true });
  const draft = await composer.compose([
    sample(0, 20), sample(0.2, 24), sample(0.4, 17), sample(0.6, 85),
    sample(0.8, 20), sample(1, 18),
  ], at(0), () => true);
  expect(written).toEqual([128, 64]);
  expect(draft.references).toContain("+0.8s retour à E1.1");
});

it("keeps close edits across a tile boundary in one contextual crop", async () => {
  const written = canvasFixture();
  const draft = await voiceScreenComposer().compose([
    sample(0, 20), sample(0.2, 20, 20, 0, 85), sample(0.4, 20),
  ], at(0), () => true);
  expect(written).toEqual([128, 128]);
  expect(draft.references).toContain("+0.4s retour à E1.1");
});

it("coalesces additions on one line but flushes them before the line disappears", async () => {
  const written = canvasFixture();
  const frames = [0, 1, 2, 3, 0].map((typed, index) => sample(index / 5, 244, 244, 244, 0, typed));
  const draft = await voiceScreenComposer().compose(frames, at(0), () => true);
  expect(written).toEqual([128, 64]);
  expect(draft.references).toContain("+0.8s retour à E1.1");
});

it("continues to attach novel visual changes after the text reference budget fills", async () => {
  const written = canvasFixture();
  const composer = voiceScreenComposer();
  const frames = Array.from({ length: 22 }, (_, index) => sample(index, index % 2 ? 90 : 10));
  frames.push(sample(22, 50));
  const draft = await composer.compose(frames, at(0), () => true);
  expect(written).toEqual([128, 64, 64]);
  expect(draft.references).toContain("autres retours vers des zones déjà connues");
  expect(draft.references).not.toContain("Séquence écran partielle");
});

it("packs overflowing visual pages without discarding late changes", async () => {
  const written = canvasFixture();
  const frames = Array.from({ length: 499 }, (_, index) => sample(index, Math.floor(index / 2), Math.ceil(index / 2)));
  const draft = await voiceScreenComposer().compose(frames, at(0), () => true);
  expect(draft.images).toHaveLength(3);
  expect(written).toHaveLength(499);
  expect(draft.references).toContain("Planches regroupées");
  expect(draft.references).not.toContain("Séquence écran partielle");
});

it("separates recipients and never remembers a plan discarded before transport", async () => {
  canvasFixture();
  const first = voiceScreenComposer(), second = voiceScreenComposer();
  const samples = [sample(0, 10)];
  await first.compose(samples, at(0), () => true); // No delivery.
  const retry = await first.compose(samples, at(0), () => true);
  expect(retry.images).toHaveLength(1);
  retry.commit();
  expect((await first.compose(samples, at(0), () => true)).images).toEqual([]);
  expect((await second.compose(samples, at(0), () => true)).images).toHaveLength(1);
  first.clear();
  retry.commit(); // Late receipt from before revocation.
  expect((await first.compose(samples, at(0), () => true)).images).toHaveLength(1);
});
