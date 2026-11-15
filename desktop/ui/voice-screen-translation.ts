const STEP = 4;
const CELL = 16;
const MAX_ANCHOR_MATCHES = 4;
const MAX_CANDIDATES = 6;
const MIN_SHIFT = 3;

export interface ScreenRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenShift {
  dx: number;
  dy: number;
  regions: ScreenRectangle[];
}

type PixelFrame = { width: number; height: number; pixels: Uint32Array };

function frame(image: ImageData): PixelFrame {
  return { width: image.width, height: image.height,
    pixels: new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4) };
}

// Anchors propose offsets. The complete destination pixels are verified below.
function anchor(image: PixelFrame, x: number, y: number, approximate: boolean): number | undefined {
  const row = y * image.width + x;
  let a = image.pixels[row]!;
  let b = image.pixels[row + 3]!;
  let c = image.pixels[row + 3 * image.width]!;
  let d = image.pixels[row + 5 * image.width + 5]!;
  if (approximate) {
    const luminanceBin = (pixel: number) => ((pixel & 255) * 3 + (pixel >>> 8 & 255) * 6 + (pixel >>> 16 & 255)) >>> 7;
    a = luminanceBin(a); b = luminanceBin(b); c = luminanceBin(c); d = luminanceBin(d);
  }
  if (a === b && a === c && a === d) return;
  return Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b) ^
    Math.imul(c, 0xc2b2ae35) ^ Math.imul(d, 0x27d4eb2f);
}

function proposedOffsets(source: PixelFrame, destination: PixelFrame, changed: ScreenRectangle[], approximate: boolean) {
  const index = new Map<number, number[]>();
  for (let y = 0; y + 5 < source.height; y += STEP) {
    for (let x = 0; x + 5 < source.width; x += STEP) {
      const key = anchor(source, x, y, approximate);
      if (key === undefined) continue;
      const positions = index.get(key);
      if (!positions) index.set(key, [y * source.width + x]);
      else if (positions.length <= MAX_ANCHOR_MATCHES) positions.push(y * source.width + x);
    }
  }

  const votes = new Map<string, { dx: number; dy: number; votes: number }>();
  const probes = approximate ? [0, 6] : [0];
  for (const region of changed) {
    for (let y = region.y; y + 8 < region.y + region.height; y += CELL) {
      for (let x = region.x; x + 8 < region.x + region.width; x += CELL) {
        const witnessed = new Set<string>();
        // All four phases on both axes allow displacements smaller than the source sampling step.
        for (const probe of probes) {
          for (let py = y + probe; py < y + probe + STEP && py + 5 < region.y + region.height; py++) {
            for (let px = x + probe; px < x + probe + STEP && px + 5 < region.x + region.width; px++) {
              const key = anchor(destination, px, py, approximate);
              const positions = key === undefined ? undefined : index.get(key);
              if (!positions || positions.length > MAX_ANCHOR_MATCHES) continue;
              for (const position of positions) {
                const dx = px - position % source.width;
                const dy = py - Math.floor(position / source.width);
                if (Math.max(Math.abs(dx), Math.abs(dy)) < (approximate ? MIN_SHIFT : 1)) continue;
                const offset = `${dx},${dy}`;
                if (witnessed.has(offset)) continue;
                witnessed.add(offset);
                const tally = votes.get(offset);
                if (tally) tally.votes++;
                else votes.set(offset, { dx, dy, votes: 1 });
              }
            }
          }
        }
      }
    }
  }
  return [...votes.values()].filter(candidate => candidate.votes >= 2)
    .sort((a, b) => b.votes - a.votes).slice(0, approximate ? MAX_CANDIDATES * 2 : MAX_CANDIDATES);
}

function equal(source: PixelFrame, destination: PixelFrame, region: ScreenRectangle, dx: number, dy: number, tolerance: number): boolean {
  let totalError = 0;
  const x = region.x - dx, y = region.y - dy;
  if (x < 0 || y < 0 || x + region.width > source.width || y + region.height > source.height) return false;
  for (let row = 0; row < region.height; row++) {
    const from = (y + row) * source.width + x;
    const to = (region.y + row) * destination.width + region.x;
    for (let column = 0; column < region.width; column++) {
      const a = source.pixels[from + column]!, b = destination.pixels[to + column]!;
      if (a === b) continue;
      if (!tolerance || a >>> 24 !== b >>> 24) return false;
      const red = Math.abs((a & 255) - (b & 255));
      const green = Math.abs((a >>> 8 & 255) - (b >>> 8 & 255));
      const blue = Math.abs((a >>> 16 & 255) - (b >>> 16 & 255));
      if (Math.max(red, green, blue) > tolerance) return false;
      totalError += red + green + blue;
    }
  }
  return totalError <= region.width * region.height * 3 * (tolerance / 4);
}

function textured(image: PixelFrame, region: ScreenRectangle): boolean {
  const first = image.pixels[region.y * image.width + region.x]!;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const color = image.pixels[y * image.width + x]!;
      if (Math.abs((first & 255) - (color & 255)) >= 24 ||
          Math.abs((first >>> 8 & 255) - (color >>> 8 & 255)) >= 24 ||
          Math.abs((first >>> 16 & 255) - (color >>> 16 & 255)) >= 24) return true;
    }
  }
  return false;
}

export function splitScreenRegion(region: ScreenRectangle): ScreenRectangle[] {
  const cells: ScreenRectangle[] = [];
  for (let y = region.y; y < region.y + region.height; y += CELL)
    for (let x = region.x; x < region.x + region.width; x += CELL)
      cells.push({ x, y, width: Math.min(CELL, region.x + region.width - x), height: Math.min(CELL, region.y + region.height - y) });
  return cells;
}

export function screenShifts(previous: ImageData, current: ImageData, changed: ScreenRectangle[],
    sourceAvailable: (region: ScreenRectangle) => boolean, tolerance = 0): ScreenShift[] {
  if (!changed.length || previous.width !== current.width || previous.height !== current.height) return [];
  const source = frame(previous), destination = frame(current);
  const remaining = new Set(changed.flatMap(splitScreenRegion));
  const shifts: ScreenShift[] = [];
  for (const { dx, dy } of proposedOffsets(source, destination, changed, tolerance > 0)) {
    const regions = [...remaining].filter(cell => !equal(source, destination, cell, 0, 0, tolerance) &&
      equal(source, destination, cell, dx, dy, tolerance) &&
      sourceAvailable({ ...cell, x: cell.x - dx, y: cell.y - dy }));
    if (regions.filter(cell => textured(destination, cell)).length < 2) continue;
    shifts.push({ dx, dy, regions });
    // Compression can make unrelated small regions look alike. Keep only the
    // dominant verified offset for this replay frame; other pixels stay visual.
    if (tolerance) break;
    for (const cell of regions) remaining.delete(cell);
  }
  return shifts;
}
