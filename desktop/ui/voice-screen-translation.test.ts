import { expect, it } from "vitest";
import { screenShifts, splitScreenRegion, type ScreenRectangle } from "./voice-screen-translation.js";

const W = 128, H = 128;
const whole = { x: 0, y: 0, width: W, height: H };

function texture(x: number, y: number): number {
  const value = Math.imul(x + 1, 0x85ebca6b) ^ Math.imul(y + 1, 0x9e3779b9);
  return (value ^ value >>> 13 ^ value << 7) | 0xff000000;
}

function image(draw: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  const pixels = new Uint32Array(data.buffer);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      pixels[y * W + x] = draw(x, y);
  return { data, width: W, height: H } as ImageData;
}

function intersects(a: ScreenRectangle, b: ScreenRectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

it("matches an off-grid scroll and leaves the revealed strip and a changed pixel for transport", () => {
  const previous = image(texture);
  const current = image((x, y) => y < 115 && (x !== 42 || y !== 42) ? texture(x, y + 13) : 0xffeeeeee);
  const shift = screenShifts(previous, current, [whole], () => true).find(move => move.dx === 0 && move.dy === -13);
  expect(shift?.regions).toContainEqual({ x: 0, y: 0, width: 16, height: 16 });
  expect(shift?.regions.some(region => intersects(region, { x: 42, y: 42, width: 1, height: 1 }))).toBe(false);
  expect(shift?.regions.every(region => region.y + region.height <= 115)).toBe(true);
});

it("tracks diagonal window movement and leaves the uncovered desktop intact", () => {
  const window = (x: number, y: number) => x >= 9 && x < 89 && y >= 11 && y < 91;
  const old = image((x, y) => window(x, y) ? texture(x, y) : 0xff777777);
  const next = image((x, y) => window(x - 19, y - 11) ? texture(x - 19, y - 11) : 0xff777777);
  const change = splitScreenRegion(whole).filter(region =>
    region.x >= 16 && region.x < 112 && region.y >= 16 && region.y < 112);
  const blocked = { x: 16, y: 16, width: 16, height: 16 };
  const shift = screenShifts(old, next, change, region => !intersects(region, blocked))
    .find(move => move.dx === 19 && move.dy === 11);
  expect(shift?.regions).toContainEqual({ x: 64, y: 64, width: 16, height: 16 });
  expect(shift?.regions.some(region => intersects(region, { x: 16, y: 32, width: 8, height: 16 }))).toBe(false);
  expect(shift?.regions.every(region => !intersects({ ...region, x: region.x - 19, y: region.y - 11 }, blocked))).toBe(true);
});

it("tolerates bounded codec noise during replay without losing a high-contrast change", () => {
  const previous = image(texture);
  const current = image((x, y) => {
    if (y >= 115 || (x === 42 && y === 42)) return 0xffeeeeee;
    const value = texture(x, y + 13);
    const red = value & 255;
    return (value & ~255) | (red < 252 ? red + 3 : red - 3);
  });
  const detect = (tolerance?: number) => screenShifts(previous, current, [whole], () => true, tolerance)
    .find(move => move.dx === 0 && move.dy === -13);
  expect(detect()).toBeUndefined();
  const replay = detect(24);
  expect(replay?.regions).toContainEqual({ x: 0, y: 0, width: 16, height: 16 });
  expect(replay?.regions.some(region => intersects(region, { x: 42, y: 42, width: 1, height: 1 }))).toBe(false);
});
