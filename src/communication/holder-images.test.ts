import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  collectHolderImages,
  imageInputArgs,
  imageMessage,
  imageReferences,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  withHolderImages,
} from "./holder-images.js";
import { fastReplyArgs } from "./fast-reply.js";

let root: string;
let ws: string;
const fwd = (p: string) => p.split(path.sep).join("/");
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "holder-img-"));
  ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, "artifacts", "generated-images"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (rel: string, data: Buffer = PNG) => {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};

it("repère les chemins en markdown, entre chevrons, en clair et absolus, sans doublon ni URL", () => {
  const refs = imageReferences([
    "voir ![a](<artifacts/generated-images/a b.png>) puis ![b](artifacts/b.jpg)",
    "en clair artifacts/c.webp et C:/x/y/d.PNG, encore artifacts/b.jpg, https://exemple.fr/e.png",
  ]);
  expect(refs).toEqual([
    "artifacts/generated-images/a b.png",
    "artifacts/b.jpg",
    "artifacts/c.webp",
    "C:/x/y/d.PNG",
  ]);
});

it("ne joint que des fichiers existants, bornés, sous le workspace", () => {
  put("artifacts/generated-images/a.png");
  put("artifacts/big.png", Buffer.alloc(MAX_IMAGE_BYTES + 1));
  put("artifacts/empty.png", Buffer.alloc(0));
  put("artifacts/note.txt");
  const outside = path.join(root, "dehors.png");
  fs.writeFileSync(outside, PNG);
  const images = collectHolderImages(ws, [
    "![a](<artifacts/generated-images/a.png>) artifacts/absent.png artifacts/big.png artifacts/empty.png",
    `${fwd(outside)} ../dehors.png`,
  ]);
  expect(images.map((i) => i.label)).toEqual(["artifacts/generated-images/a.png"]);
  expect(images[0]!.mediaType).toBe("image/png");
  expect(images[0]!.base64).toBe(PNG.toString("base64"));
});

it("accepte un chemin absolu situé sous le workspace", () => {
  const file = put("artifacts/x.jpg");
  const [img] = collectHolderImages(ws, [fwd(file)]);
  expect(img?.label).toBe("artifacts/x.jpg");
  expect(img?.mediaType).toBe("image/jpeg");
});

it("garde une rafale dans l'ordre, limitée aux plus récentes", () => {
  const names = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => `artifacts/r/${i}.png`);
  names.forEach((n) => put(n));
  const images = collectHolderImages(ws, [names.map((n) => `![](<${n}>)`).join("\n")]);
  expect(images.map((i) => i.label)).toEqual(names.slice(-MAX_IMAGES));
});

it("passe en stream-json seulement avec des images", () => {
  const args = fastReplyArgs("sonnet", "p.md");
  const none = withHolderImages(args, "prompt", ws, ["rien ici"]);
  expect(none).toEqual({ args, prompt: "prompt" });
  put("artifacts/a.png");
  const some = withHolderImages(args, "prompt", ws, ["artifacts/a.png"]);
  expect(some.args).toEqual(imageInputArgs(args));
  expect(some.args).toContain("--tools");
  expect(some.args[some.args.indexOf("--tools") + 1]).toBe("");
  expect(some.args.filter((a) => a === "--output-format")).toHaveLength(1);
  expect(some.args[some.args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(some.args).toContain("--verbose");
  const line = some.prompt;
  expect(line.endsWith("\n")).toBe(true);
  const msg = JSON.parse(line) as { type: string; message: { role: string; content: any[] } };
  expect(msg.type).toBe("user");
  expect(msg.message.content.map((c) => c.type)).toEqual(["text", "image", "text"]);
  expect(msg.message.content[1].source).toEqual({
    type: "base64",
    media_type: "image/png",
    data: PNG.toString("base64"),
  });
  expect(msg.message.content[2].text).toBe("prompt");
});

it("légende chaque image d'une rafale", () => {
  const imgs = [
    { label: "a.png", mediaType: "image/png", base64: "AA" },
    { label: "b.png", mediaType: "image/png", base64: "BB" },
  ];
  const content = JSON.parse(imageMessage("p", imgs)).message.content;
  expect(content.map((c: any) => c.text ?? c.type)).toEqual([
    "Image 1/2 (a.png) :", "image", "Image 2/2 (b.png) :", "image", "p",
  ]);
});
