import { screenShifts, splitScreenRegion, type ScreenRectangle } from "./voice-screen-translation.js";

const TILE = 64;
const MAX_ATLASES = 3;
const MAX_ATLAS_EDGE = 1280;
const MAX_ATLAS_PIXELS = 1_000_000;
const MAX_FOLLOWUP_ATLAS_PIXELS = MAX_ATLAS_PIXELS / 2;
const LABEL_HEIGHT = 19;
const MAX_REFERENCE_LINES = 12;
const MAX_REFERENCE_CHARS = 1450;
const MAX_SHIFT_CHARS = 1050;
const MAX_ANIMATION_EDGE = 24;
const MIN_ANIMATION_CHANGES = 6;

interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
  position: string;
  digest: string;
}
interface Patch {
  x: number;
  y: number;
  width: number;
  height: number;
  tiles: ScreenRectangle[];
  pixels?: ImageData;
  label?: string;
  offset?: string;
}
interface ScreenSample {
  base64: string;
  capturedAt: string;
}
interface Region { left: number; top: number; right: number; bottom: number }
interface Motion extends Region { times: number[]; source: ImageData; tile: Region; geometry: string }
interface ScreenState {
  image: ImageData;
  available: Set<string>;
  sequence: string;
  offset: string;
}
export interface VoiceScreenDraft {
  images: string[];
  references: string;
  commit(): void;
}

function context(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw Error("Canvas indisponible pour la composition écran.");
  return ctx;
}

async function decode(sample: ScreenSample): Promise<CanvasRenderingContext2D> {
  const png = Uint8Array.from(atob(sample.base64), value => value.charCodeAt(0));
  const image = await createImageBitmap(new Blob([png], { type: "image/png" }));
  try {
    const ctx = context(image.width, image.height);
    ctx.drawImage(image, 0, 0);
    return ctx;
  } finally {
    image.close();
  }
}

function difference(previous: ImageData, current: ImageData, region: Region, sourceX = 0, sourceY = 0): Region | undefined {
  let left = region.right, top = region.bottom, right = region.left, bottom = region.top;
  const before = previous.data, after = current.data;
  for (let y = region.top; y < region.bottom; y++) {
    for (let x = region.left; x < region.right; x++) {
      const i = (y * current.width + x) * 4;
      const j = ((y - sourceY) * previous.width + x - sourceX) * 4;
      if (Math.max(
        Math.abs(before[j]! - after[i]!),
        Math.abs(before[j + 1]! - after[i + 1]!),
        Math.abs(before[j + 2]! - after[i + 2]!),
      ) < 16) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = y + 1;
    }
  }
  return left < right ? { left, top, right, bottom } : undefined;
}

function copyTile(image: ImageData, tile: Region): ImageData {
  const width = tile.right - tile.left, height = tile.bottom - tile.top;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((tile.top + y) * image.width + tile.left) * 4;
    data.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return new ImageData(data, width, height);
}

function small(region: Region): boolean {
  return region.right - region.left <= MAX_ANIMATION_EDGE &&
    region.bottom - region.top <= MAX_ANIMATION_EDGE;
}

/** Detect a fixed, repeatedly changing region within a short time span. */
async function animations(samples: ScreenSample[], allowed: () => boolean): Promise<Map<string, Motion>> {
  const detected = new Map<string, Motion>();
  const pending = new Map<string, Motion>();
  let previous: ImageData | undefined;
  for (const sample of samples) {
    if (!allowed()) break;
    const ctx = await decode(sample);
    const current = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const at = Date.parse(sample.capturedAt);
    const { width, height } = current;
    if (previous?.width === width && previous.height === height) {
      for (let y = 0; y < height; y += TILE) {
        for (let x = 0; x < width; x += TILE) {
          const key = `${width}×${height}@${x},${y}`;
          if (detected.has(key)) continue;
          const tile = { left: x, top: y, right: Math.min(x + TILE, width), bottom: Math.min(y + TILE, height) };
          const change = difference(previous, current, tile);
          if (!change) continue;
          if (!small(change)) { pending.delete(key); continue; }
          const earlier = pending.get(key);
          const union = earlier && {
            left: Math.min(earlier.left, change.left), top: Math.min(earlier.top, change.top),
            right: Math.max(earlier.right, change.right), bottom: Math.max(earlier.bottom, change.bottom),
          };
          const times = earlier?.times.filter(time => at - time <= 2000) ?? [];
          const motion: Motion = earlier && union && small(union) && times.length
            ? { ...earlier, ...union, times: [...times, at] }
            : { ...change, times: [at], source: copyTile(previous, tile), tile, geometry: `${width}×${height}` };
          if (motion.times.length >= MIN_ANIMATION_CHANGES) {
            detected.set(key, motion);
            pending.delete(key);
          } else pending.set(key, motion);
        }
      }
    }
    previous = current;
  }
  return detected;
}

function stabilize(image: ImageData, motion: Map<string, Motion>): void {
  for (const region of motion.values()) {
    if (region.geometry !== `${image.width}×${image.height}`) continue;
    const { left, top, right, bottom, source, tile } = region;
    const change = difference(source, image, tile, tile.left, tile.top);
    if (change && (change.left < left || change.top < top || change.right > right || change.bottom > bottom)) continue;
    for (let y = top; y < bottom; y++) {
      const start = (y * image.width + left) * 4;
      const sourceStart = ((y - tile.top) * source.width + left - tile.left) * 4;
      image.data.set(source.data.subarray(sourceStart, sourceStart + (right - left) * 4), start);
    }
  }
}

/** Anchor weak changes to the last visible state, so gradual real edits can accumulate. */
function suppressNoise(previous: ImageData, current: ImageData, compressed: boolean) {
  if (previous.width !== current.width || previous.height !== current.height)
    return { filtered: false, changed: true };
  let filtered = false, changed = false;
  let left = current.width, right = 0, top = current.height, bottom = 0;
  let lightInk = 0, darkInk = 0, totalStrong = 0;
  const { width, height, data } = current;
  const original = previous.data;
  for (let y = 0; y < height; y += 8) {
    const endY = Math.min(y + 8, height);
    for (let x = 0; x < width; x += 8) {
      const endX = Math.min(x + 8, width);
      let sum = 0, strongest = 0, changedPixels = 0, strong = 0, light = 0, dark = 0;
      for (let row = y; row < endY; row++) {
        for (let column = x; column < endX; column++) {
          const i = (row * width + column) * 4;
          const r = data[i]! - original[i]!;
          const g = data[i + 1]! - original[i + 1]!;
          const b = data[i + 2]! - original[i + 2]!;
          const delta = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
          if (delta || data[i + 3] !== original[i + 3]) changedPixels++;
          if (delta >= 30) {
            strong++;
            const background = original[i]! + original[i + 1]! + original[i + 2]!;
            if (background >= 660 && r + g + b < -65) dark++;
            else if (background <= 105 && r + g + b > 65) light++;
          }
          sum += delta;
          strongest = Math.max(strongest, delta);
        }
      }
      if (!changedPixels) continue;
      if (compressed
        ? strong >= 4 || strongest >= 64 || sum >= (endY - y) * (endX - x) * 8
        : strongest > 3 || changedPixels > 4) {
        changed = true;
        if (strong) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, endX);
          bottom = Math.max(bottom, endY);
          lightInk += light;
          darkInk += dark;
          totalStrong += strong;
        }
        continue;
      }
      for (let row = y; row < endY; row++) {
        const start = (row * width + x) * 4;
        const end = start + (endX - x) * 4;
        data.set(original.subarray(start, end), start);
      }
      filtered = true;
    }
  }
  const ink = Math.max(lightInk, darkInk);
  const growth = ink >= 4 && totalStrong <= 1100 && ink >= (totalStrong - ink) * 4 &&
    right - left <= 240 && bottom - top <= 32
    ? { left, top, right, bottom, light: lightInk > darkInk } : undefined;
  return { filtered, changed, growth };
}

/** Retain the final image of an uninterrupted addition of ink on one line. */
async function* visibleFrames(samples: ScreenSample[], previous: ImageData | undefined, compressed: boolean,
    motion: Map<string, Motion>, allowed: () => boolean) {
  type Prepared = { sample: ScreenSample; image: ImageData; ctx: CanvasRenderingContext2D };
  let pending: (Prepared & { growth: Region & { light: boolean } }) | undefined;
  for (const sample of samples) {
    if (!allowed()) return;
    const ctx = await decode(sample);
    const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (motion.size) stabilize(image, motion);
    const change = previous && suppressNoise(previous, image, compressed);
    if (change && !change.changed) continue;
    previous = image;
    if (motion.size || change?.filtered) ctx.putImageData(image, 0, 0);
    const growth = change?.growth;
    if (pending) {
      const gap = Date.parse(sample.capturedAt) - Date.parse(pending.sample.capturedAt);
      const sameLine = growth && gap <= 1100 && gap >= 0 &&
        growth.light === pending.growth.light &&
        Math.abs(growth.top - pending.growth.top) <= 16 &&
        Math.max(growth.left, pending.growth.left) - Math.min(growth.right, pending.growth.right) <= 64;
      if (!sameLine) yield pending;
    }
    pending = growth ? { sample, image, ctx, growth } : undefined;
    if (!pending) yield { sample, image, ctx };
  }
  if (pending && allowed()) yield pending;
}

async function screenTiles(image: ImageData, previous: ImageData | undefined, baseline: Map<string, string>): Promise<Tile[]> {
  const { width, height, data } = image;
  const tiles: (Tile | Promise<Tile>)[] = [];
  const pixels = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  const before = previous?.width === width && previous.height === height
    ? new Uint32Array(previous.data.buffer, previous.data.byteOffset, previous.data.length / 4) : undefined;
  for (let y = 0; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) {
      const tileWidth = Math.min(TILE, width - x);
      const tileHeight = Math.min(TILE, height - y);
      const tile = { x, y, width: tileWidth, height: tileHeight, position: `${width}×${height}@${x},${y}` };
      const cached = baseline.get(tile.position);
      if (cached && before && sameTile(before, pixels, width, tile)) {
        tiles.push({ ...tile, digest: cached });
        continue;
      }
      const stride = tileWidth * 4;
      const bytes = new Uint8Array(stride * tileHeight);
      for (let row = 0; row < tileHeight; row++) {
        const start = ((y + row) * width + x) * 4;
        bytes.set(data.subarray(start, start + stride), row * stride);
      }
      tiles.push(crypto.subtle.digest("SHA-256", bytes).then(hash => ({
        ...tile,
        digest: btoa(String.fromCharCode(...new Uint8Array(hash))),
      })));
    }
  }
  return Promise.all(tiles);
}

function sameTile(before: Uint32Array, after: Uint32Array, width: number, tile: ScreenRectangle): boolean {
  for (let y = tile.y; y < tile.y + tile.height; y++) {
    const start = y * width + tile.x;
    for (let i = start; i < start + tile.width; i++) if (before[i] !== after[i]) return false;
  }
  return true;
}

/** Merge horizontal runs, then stack runs whose edges line up. No unchanged tiles are included. */
function patches(tiles: ScreenRectangle[]): Patch[] {
  const runs: Patch[] = [];
  for (const tile of tiles) {
    const run = runs.at(-1);
    if (run && run.y === tile.y && run.height === tile.height && run.x + run.width === tile.x) {
      run.width += tile.width;
      run.tiles.push(tile);
    } else {
      runs.push({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, tiles: [tile] });
    }
  }
  const result: Patch[] = [];
  const bottomEdges = new Map<string, Patch>();
  for (const run of runs) {
    const key = `${run.x}:${run.width}`;
    const above = bottomEdges.get(key);
    const maxHeight = Math.min(MAX_ATLAS_EDGE, Math.floor(MAX_ATLAS_PIXELS / Math.max(124, run.width))) - LABEL_HEIGHT;
    if (above && above.y + above.height === run.y && above.height + run.height <= maxHeight) {
      above.height += run.height;
      above.tiles.push(...run.tiles);
    } else {
      bottomEdges.set(key, run);
      result.push(run);
    }
  }
  return result;
}

const cellKey = ({ x, y }: Pick<ScreenRectangle, "x" | "y">) => `${x},${y}`;

function readablePatches(rectangles: ScreenRectangle[], width: number, height: number): Patch[] {
  const crops = patches(rectangles);
  const area = (rectangle: ScreenRectangle) => rectangle.width * rectangle.height;
  // Include the gutter and a little shared context when nearby changes belong
  // to the same line or control. Keep distant changes as separate crops.
  const cost = (rectangle: ScreenRectangle) =>
    Math.max(124, rectangle.width) * (rectangle.height + LABEL_HEIGHT);
  for (let i = 0; i < crops.length; i++) {
    const crop = crops[i]!;
    for (let j = i + 1; j < crops.length;) {
      const other = crops[j]!;
      const x = Math.min(crop.x, other.x), y = Math.min(crop.y, other.y);
      const right = Math.max(crop.x + crop.width, other.x + other.width);
      const bottom = Math.max(crop.y + crop.height, other.y + other.height);
      const hull = { x, y, width: right - x, height: bottom - y };
      const gapX = Math.max(crop.x, other.x) - Math.min(crop.x + crop.width, other.x + other.width);
      const gapY = Math.max(crop.y, other.y) - Math.min(crop.y + crop.height, other.y + other.height);
      if (gapX <= 24 && gapY <= 16 && area(hull) <= 1.6 * (area(crop) + area(other)) &&
          cost(hull) <= Math.min(MAX_ATLAS_PIXELS, cost(crop) + cost(other))) {
        Object.assign(crop, hull);
        crop.tiles.push(...other.tiles);
        crops.splice(j, 1);
      } else j++;
    }
  }
  for (const crop of crops) {
    if (crop.width >= 96 && crop.height >= 48) continue;
    const w = Math.min(width, Math.max(96, crop.width));
    const h = Math.min(height, Math.max(48, crop.height));
    // Avoid wasting pixels around an intact tile. Extend narrower translated
    // remnants so the object around a changed control stays recognizable.
    if (crop.width >= TILE && crop.height >= TILE) continue;
    crop.x = Math.max(0, Math.min(width - w, crop.x - Math.floor((w - crop.width) / 2)));
    crop.y = Math.max(0, Math.min(height - h, crop.y - Math.floor((h - crop.height) / 2)));
    crop.width = w;
    crop.height = h;
  }
  return crops;
}

function containsKnownRegion(state: ScreenState, region: ScreenRectangle): boolean {
  const { x, y, width, height } = region;
  const left = Math.floor(x / TILE) * TILE, top = Math.floor(y / TILE) * TILE;
  for (let row = top; row < y + height; row += TILE)
    for (let column = left; column < x + width; column += TILE)
      if (!state.available.has(`${column},${row}`)) return false;
  return true;
}

function layoutAtWidth(items: Patch[], width: number) {
  const GAP = 4;
  const itemWidth = (item: Patch) => Math.max(item.width, 124);
  const pages: { width: number; height: number; placements: { item: Patch; x: number; y: number }[] }[] = [];
  let page = { width: 0, height: 0, placements: [] as (typeof pages)[number]["placements"] };
  let x = 0, y = 0, rowHeight = 0;
  for (const item of items) {
    const w = itemWidth(item), h = item.height + LABEL_HEIGHT;
    if (x && x + w > width) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    const nextWidth = Math.max(page.width, x + w);
    const nextHeight = Math.max(page.height, y + h);
    if (page.placements.length && (nextHeight > MAX_ATLAS_EDGE || nextWidth * nextHeight > MAX_ATLAS_PIXELS)) {
      pages.push(page);
      page = { width: 0, height: 0, placements: [] };
      x = y = rowHeight = 0;
    }
    page.placements.push({ item, x, y });
    page.width = Math.max(page.width, x + w);
    page.height = Math.max(page.height, y + h);
    x += w + GAP;
    rowHeight = Math.max(rowHeight, h);
  }
  if (page.placements.length) pages.push(page);
  return pages;
}

function layout(items: Patch[]) {
  // Try a few shelf widths while keeping the reading order. A full-screen
  // anchor can occupy its own wide page without widening the later strips.
  const area = (pages: ReturnType<typeof layoutAtWidth>) =>
    pages.reduce((total, page) => total + page.width * page.height, 0);
  const overflow = (pages: ReturnType<typeof layoutAtWidth>) => Math.max(0, pages.length - MAX_ATLASES);
  let best = layoutAtWidth(items, MAX_ATLAS_EDGE);
  for (const width of [480, 640, 768, 896, 1024, 1152]) {
    const candidate = layoutAtWidth(items, width);
    if (overflow(candidate) < overflow(best) ||
        (overflow(candidate) === overflow(best) && area(candidate) < area(best))) best = candidate;
  }
  return best;
}

function render(pages: ReturnType<typeof layout>, capturedAt: string): string[] {
  const renderPage = (page: (typeof pages)[number]) => {
    const ctx = context(page.width, page.height);
    ctx.fillStyle = "#20252b";
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "11px sans-serif";
    for (const { item, x, y } of page.placements) {
      ctx.fillText(`${item.label} ${item.offset} (${item.x},${item.y})`, x + 2, y + 13, Math.max(item.width, 124) - 4);
      ctx.putImageData(item.pixels!, x, y + LABEL_HEIGHT);
    }
    return ctx.canvas;
  };
  const serialize = (canvas: HTMLCanvasElement, index: number) => {
    const pixels = canvas.width * canvas.height;
    if (index > 0 && pixels > MAX_FOLLOWUP_ATLAS_PIXELS) {
      const scale = Math.sqrt(MAX_FOLLOWUP_ATLAS_PIXELS / pixels);
      const resized = context(Math.max(1, Math.floor(canvas.width * scale)), Math.max(1, Math.floor(canvas.height * scale)));
      resized.drawImage(canvas, 0, 0, resized.canvas.width, resized.canvas.height);
      canvas = resized.canvas;
    }
    return JSON.stringify({ base64: canvas.toDataURL("image/png").split(",")[1], capturedAt });
  };
  if (pages.length <= MAX_ATLASES) return pages.map((page, index) => serialize(renderPage(page), index));

  // Keep the transport's image count, but fit every page into the available images.
  const groups = Array.from({ length: MAX_ATLASES }, (_, index) => pages.slice(
    Math.floor(index * pages.length / MAX_ATLASES),
    Math.floor((index + 1) * pages.length / MAX_ATLASES),
  ));
  return groups.map((group, index) => {
    const columns = Math.ceil(Math.sqrt(group.length));
    const rows = Math.ceil(group.length / columns);
    const cellWidth = Math.max(...group.map(page => page.width));
    const cellHeight = Math.max(...group.map(page => page.height));
    const width = cellWidth * columns, height = cellHeight * rows;
    const scale = Math.min(1, MAX_ATLAS_EDGE / width, MAX_ATLAS_EDGE / height,
      Math.sqrt(MAX_ATLAS_PIXELS / (width * height)));
    const ctx = context(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
    ctx.fillStyle = "#20252b";
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    group.forEach((page, index) => {
      ctx.drawImage(renderPage(page), index % columns * cellWidth * scale,
        Math.floor(index / columns) * cellHeight * scale, page.width * scale, page.height * scale);
    });
    return serialize(ctx.canvas, index);
  });
}

/** History belongs to one recipient. Only patches in confirmed messages enter it. */
export function voiceScreenComposer({ compressedReplay = false } = {}) {
  const history = new Map<string, string>();
  let latest = new Map<string, string>();
  let latestGeometry: string | undefined;
  let latestState: ScreenState | undefined;
  let generation = 0;
  let sequence = 0;
  return {
    clear() { generation++; history.clear(); latest.clear(); latestGeometry = undefined; latestState = undefined; },
    async compose(samples: readonly string[], capturedAt: string, allowed: () => boolean): Promise<VoiceScreenDraft> {
      const currentGeneration = generation;
      const prefix = `E${++sequence}.`;
      const additions = new Map<string, string>();
      let next = new Map(latest), nextGeometry = latestGeometry;
      const known: string[] = [];
      const outgoing: Patch[] = [];
      const shifts: string[] = [];
      let state = latestState;
      let omitted = false;
      let compactedReferences = 0;
      const stillAllowed = () => generation === currentGeneration && allowed();
      const empty = { images: [], references: "", commit() {} };
      const frames: ScreenSample[] = [];
      for (const raw of samples) {
        const sample = JSON.parse(raw) as ScreenSample & { truncated?: boolean; unavailable?: boolean };
        if (sample.truncated) { omitted = true; continue; }
        if (sample.unavailable) throw Error("Capture écran indisponible.");
        frames.push(sample);
      }
      const motion = await animations(frames, stillAllowed);
      for await (const { sample, ctx, image } of visibleFrames(frames, state?.image, compressedReplay, motion, stillAllowed)) {
        if (!stillAllowed()) return empty;
        const geometry = `${ctx.canvas.width}×${ctx.canvas.height}`;
        const baseline = geometry === nextGeometry ? next : new Map<string, string>();
        const tiles = await screenTiles(image, state?.image, baseline);
        if (!stillAllowed()) return empty;
        const offset = `+${Math.max(0, (Date.parse(sample.capturedAt) - Date.parse(capturedAt)) / 1000).toFixed(1)}s`;
        const changed = tiles.filter(tile => baseline.get(tile.position) !== tile.digest);
        const historyKey = (tile: Tile) => `${tile.position}:${tile.digest}`;
        const alreadySeen = (tile: Tile) => additions.get(historyKey(tile)) ?? history.get(historyKey(tile));
        const novelTiles = changed.filter(tile => !alreadySeen(tile));
        const shifted = new Set<string>();
        if (state) {
          const previous = state;
          const movements = screenShifts(previous.image, image, novelTiles,
            region => containsKnownRegion(previous, region), compressedReplay ? 24 : 0);
          for (const { dx, dy, regions } of movements) {
            const grouped = patches(regions.sort((a, b) => a.y - b.y || a.x - b.x));
            grouped.sort((a, b) => b.width * b.height - a.width * a.height);
            const head = `- ${offset} déplacement ${dx},${dy} px depuis ${previous.sequence} ${previous.offset} →`;
            let line = head;
            for (const { x, y, width, height, tiles: covered } of grouped) {
              const extended = `${line} (${x},${y} ${width}×${height})`;
              if ([...shifts, extended].join("\n").length > MAX_SHIFT_CHARS) break;
              line = extended;
              for (const cell of covered) shifted.add(cellKey(cell));
            }
            if (line !== head) shifts.push(line);
          }
        }
        const visualTiles = novelTiles.flatMap(tile => {
          if (!shifted.size) return [tile];
          const cells = splitScreenRegion(tile);
          const visible = cells.filter(cell => !shifted.has(cellKey(cell)));
          return visible.length === cells.length ? [tile] : visible;
        });
        const novel = readablePatches(visualTiles.sort((a, b) => a.y - b.y || a.x - b.x), image.width, image.height);
        const referenced = new Map<string, Tile[]>();
        for (const tile of changed) {
          const reference = alreadySeen(tile);
          if (!reference) continue;
          const matching = referenced.get(reference) ?? [];
          matching.push(tile);
          referenced.set(reference, matching);
        }
        const lines = Array.from(referenced, ([reference, matching]) => {
          const coordinates = patches(matching)
            .map(patch => `(${patch.x},${patch.y}, ${patch.width}×${patch.height})`).join(" ");
          return { text: `- ${offset} retour à ${reference} ${coordinates}`, matching };
        });
        const available = state?.image.width === image.width && state.image.height === image.height
          ? new Set(state.available) : new Set<string>();
        for (const tile of novelTiles) available.add(cellKey(tile));
        const novelByPosition = new Map(novelTiles.map(tile => [cellKey(tile), tile]));
        for (const patch of novel) {
          const label = prefix + (outgoing.length + 1);
          patch.label = label;
          patch.offset = offset;
          patch.pixels = ctx.getImageData(patch.x, patch.y, patch.width, patch.height);
          for (let y = Math.ceil(patch.y / TILE) * TILE; y < patch.y + patch.height; y += TILE)
            for (let x = Math.ceil(patch.x / TILE) * TILE; x < patch.x + patch.width; x += TILE) {
              const tile = novelByPosition.get(cellKey({ x, y }));
              if (tile && x + tile.width <= patch.x + patch.width && y + tile.height <= patch.y + patch.height)
                additions.set(historyKey(tile), label);
            }
          outgoing.push(patch);
        }
        for (const { text, matching } of lines) {
          if (known.length < MAX_REFERENCE_LINES && [...known, text].join("\n").length <= MAX_REFERENCE_CHARS) {
            known.push(text);
            for (const tile of matching) available.add(cellKey(tile));
          } else {
            compactedReferences++;
            for (const tile of matching) available.delete(cellKey(tile));
          }
        }
        next = baseline;
        nextGeometry = geometry;
        for (const tile of changed) next.set(tile.position, tile.digest);
        state = { image, available, sequence: prefix.slice(0, -1), offset };
      }
      if (!stillAllowed()) return empty;
      const pages = layout(outgoing);
      const images = render(pages, capturedAt);
      const references = [
        ...(images.length ? ["Zones écran inédites · temps écoulé et coordonnées (x,y) sur l’écran réduit."] : []),
        ...(shifts.length ? ["Déplacements : les coordonnées indiquent la destination. La source est dans l’état indiqué, avant le décalage.", ...shifts] : []),
        ...known,
        ...(compactedReferences ? [`${compactedReferences} autres retours vers des zones déjà connues.`] : []),
        ...(pages.length > MAX_ATLASES ? ["Planches regroupées et réduites pour le transport."] : []),
        ...(pages.length <= MAX_ATLASES && pages.slice(1).some(page => page.width * page.height > MAX_FOLLOWUP_ATLAS_PIXELS)
          ? ["Planches de changements réduites pour le transport."] : []),
        ...(omitted ? ["Séquence écran partielle · tampon de capture saturé."] : []),
      ].join("\n");
      return {
        images,
        references: references ? "\n\n" + references : "",
        commit() {
          if (!stillAllowed()) return;
          for (const [key, label] of additions) history.set(key, label);
          latest = next;
          latestGeometry = nextGeometry;
          latestState = state;
        },
      };
    },
  };
}

