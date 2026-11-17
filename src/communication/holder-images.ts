/**
 * Images du fil jointes aux appels des pattern holders.
 *
 * Un message du fil référence une image par un chemin (`![…](<artifacts/…/x.png>)` ou en
 * clair). Le holder tourne sans outils : plutôt que de lui rouvrir `Read`, l'appel passe en
 * `--input-format stream-json` et le message utilisateur porte de vrais blocs image base64.
 * Rien n'est joint hors du workspace actif, au-delà de MAX_IMAGES ni de MAX_IMAGE_BYTES.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const IMAGE_REF =
  /<([^<>\r\n]+?\.(?:png|jpe?g|webp))>|\(([^()\r\n]+?\.(?:png|jpe?g|webp))\)|([^\s"'<>()[\]|]+\.(?:png|jpe?g|webp))/gi;

/** Chemins d'images cités dans ces textes, dans l'ordre d'apparition, sans doublon. */
export function imageReferences(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(IMAGE_REF)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (ref !== "" && !/^[a-z][a-z0-9+.-]+:\/\//i.test(ref)) seen.add(ref);
    }
  }
  return [...seen];
}

export interface HolderImage {
  /** Chemin relatif au workspace, avec des « / ». */
  readonly label: string;
  readonly mediaType: string;
  readonly base64: string;
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Images existantes, sous le workspace, de taille bornée. Au plus `max` : les plus récemment
 * citées, rendues dans l'ordre du fil.
 */
export function collectHolderImages(
  workspace: string,
  texts: readonly string[],
  max = MAX_IMAGES,
): HolderImage[] {
  let root: string;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    return [];
  }
  const found: { real: string; ext: string }[] = [];
  for (const ref of imageReferences(texts)) {
    try {
      const real = fs.realpathSync(path.resolve(root, ref));
      const ext = path.extname(real).toLowerCase();
      if (MEDIA_TYPES[ext] === undefined || !inside(root, real)) continue;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) continue;
      if (!found.some((f) => f.real === real)) found.push({ real, ext });
    } catch {
      // chemin absent ou illisible : simple texte
    }
  }
  return found.slice(-max).map(({ real, ext }) => ({
    label: path.relative(root, real).split(path.sep).join("/"),
    mediaType: MEDIA_TYPES[ext]!,
    base64: fs.readFileSync(real).toString("base64"),
  }));
}

/** Même appel, mais entrée stream-json (qui impose la sortie stream-json, dont la dernière ligne est le résultat). */
export function imageInputArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format") {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  return [...out, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
}

/** Ligne stdin stream-json : chaque image est précédée de sa légende, puis le prompt. */
export function imageMessage(prompt: string, images: readonly HolderImage[]): string {
  const content: unknown[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `Image ${i + 1}/${images.length} (${img.label}) :` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  });
  content.push({ type: "text", text: prompt });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** Arguments et prompt d'un appel de holder : inchangés sans image. */
export function withHolderImages(
  args: string[],
  prompt: string,
  workspace: string,
  texts: readonly string[],
): { args: string[]; prompt: string } {
  const images = collectHolderImages(workspace, texts);
  return images.length === 0
    ? { args, prompt }
    : { args: imageInputArgs(args), prompt: imageMessage(prompt, images) };
}
