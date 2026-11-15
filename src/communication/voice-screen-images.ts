import fs from "node:fs";
import path from "node:path";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4_100_000; // One million RGBA pixels plus PNG framing.
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DIRECTORY = "artifacts/conversation-images";
const REFERENCE = /^artifacts\/conversation-images\/image-\d{1,24}-\d{1,12}-\d{1,16}\.png$/;

export function voiceScreenReferences(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES ||
      !value.every((item): item is string => typeof item === "string" && REFERENCE.test(item)) ||
      new Set(value).size !== value.length) throw Error("Références des planches écran invalides.");
  return value;
}

function readPng(root: string, reference: string): Buffer {
  const workspace = fs.realpathSync(root);
  const directory = path.join(workspace, DIRECTORY);
  const file = path.join(directory, path.basename(reference));
  if (fs.realpathSync(directory) !== directory || fs.realpathSync(file) !== file)
    throw Error("Planche écran hors du dossier autorisé.");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error("Planche écran invalide.");
  const fd = fs.openSync(file, "r");
  try {
    const info = fs.fstatSync(fd);
    if (info.dev !== before.dev || info.ino !== before.ino || info.size < 24 || info.size > MAX_IMAGE_BYTES)
      throw Error("Planche écran invalide.");
    const bytes = Buffer.alloc(info.size);
    let total = 0;
    while (total < bytes.length) {
      const read = fs.readSync(fd, bytes, total, bytes.length - total, null);
      if (!read) throw Error("Planche écran tronquée.");
      total += read;
    }
    if (!bytes.subarray(0, 8).equals(PNG) || bytes.toString("ascii", 12, 16) !== "IHDR" ||
        ![bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every(edge => edge > 0 && edge <= 1280))
      throw Error("Dimensions ou format de la planche écran invalides.");
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Only host attachment metadata enters this path. Never derive it from message text. */
export function readVoiceScreenPayloads(workspace: string, references: unknown): string[] {
  return voiceScreenReferences(references).map(reference => readPng(workspace, reference).toString("base64"));
}

export function voiceScreenBlock(base64: string, runtime: "codex" | "claude"): Record<string, unknown> {
  return runtime === "codex"
      ? { type: "image", url: `data:image/png;base64,${base64}` }
      : { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } };
}
