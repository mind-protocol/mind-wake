/** Durable local raster artifacts. No network request or generation billing in this layer. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES = 8_000_000; // Same bound as the native conversation image reader.
export class ImagePublicationError extends Error {}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function raster(bytes: Buffer): string {
  let width = 0, height = 0, extension = "";
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR") {
    extension = "png"; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    extension = "webp";
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from("9d012a", "hex"))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    extension = "jpg";
    for (let i = 2; i + 4 <= bytes.length;) {
      if (bytes[i] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(i);
      if (size < 2 || i + size > bytes.length) break;
      if (marker !== undefined && [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 7) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += size;
    }
  }
  if (!extension || !width || !height || width > 16384 || height > 16384 || width * height > 32_000_000)
    throw new ImagePublicationError("Image PNG, JPEG ou WebP valide attendue (32 mégapixels maximum).");
  return extension;
}

export interface SavedGeneratedImage {
  reference: string;
  absolutePath: string;
  sha256: string;
}
export function saveGeneratedImage(workspace: string, input: { sourcePath: string; title: string; prompt?: string; requestKey: string }): SavedGeneratedImage {
  const root = fs.realpathSync(workspace);
  if (!input.sourcePath || /[\x00-\x1f]/.test(input.sourcePath) || /^(?:https?:|[\\/]{2})/i.test(input.sourcePath)) throw new ImagePublicationError("Chemin local attendu.");
  const source = fs.realpathSync(path.resolve(root, input.sourcePath));
  if (!inside(root, source)) throw new ImagePublicationError("Copier d'abord l'image dans l'espace de travail autorisé.");
  const fd = fs.openSync(source, "r");
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new ImagePublicationError("Image locale attendue (8 Mo maximum).");
    // Bound the read even if a concurrent process grows the source.
    bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) break; offset += n; }
    bytes = bytes.subarray(0, offset);
    if (bytes.length > MAX_BYTES) throw new ImagePublicationError("Image trop volumineuse (8 Mo maximum).");
  } finally { fs.closeSync(fd); }
  const extension = raster(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = createHash("sha256").update(input.requestKey).digest("hex").slice(0, 32);
  // Check each parent before writing, including installations using junctions.
  let dir = root;
  for (const segment of ["artifacts", "generated-images"]) {
    dir = path.join(dir, segment);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    dir = fs.realpathSync(dir);
    if (!inside(root, dir)) throw new ImagePublicationError("Dossier d'images hors de l'espace autorisé.");
  }
  const target = path.join(dir, `${id}.${extension}`);
  const metadata = path.join(dir, `${id}.json`);
  const record = { title: input.title, prompt: input.prompt ?? null, sha256, extension };
  if (fs.existsSync(metadata)) {
    const stat = fs.lstatSync(metadata);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000 || fs.readFileSync(metadata, "utf8") !== JSON.stringify(record)) throw new ImagePublicationError("Clé de publication déjà utilisée pour une autre image.");
  } else fs.writeFileSync(metadata, JSON.stringify(record), { flag: "wx" });
  try { fs.writeFileSync(target, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== sha256) throw new ImagePublicationError("Conflit avec une image déjà enregistrée.");
  }
  return { reference: path.relative(root, target).split(path.sep).join("/"), absolutePath: target, sha256 };
}

export function generatedImageMessage(title: string, reference: string): string {
  const label = title.replace(/[\[\]<>\\\r\n]/g, " ").trim() || "Image créée";
  return `![${label}](<${reference}>)\n\nImage enregistrée : ${reference}`;
}
