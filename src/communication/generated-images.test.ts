import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { generatedImageMessage, saveGeneratedImage } from "./generated-images.js";
import { messageImages } from "../../desktop/ui/message-images.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-image-")); roots.push(root);
  const file = path.join(root, "source.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(file, bytes);
  return { root, file, bytes };
}
it("saves a permanent independent file and prompt, retrying without changing the artifact", () => {
  const { root, file, bytes } = setup();
  const input = { sourcePath: file, title: "Une image", prompt: "Un oiseau", requestKey: "generated-001" };
  const saved = saveGeneratedImage(root, input);
  expect(fs.readFileSync(saved.absolutePath)).toEqual(bytes);
  expect(saved.reference).toMatch(/^artifacts\/generated-images\/[a-f0-9]{32}\.png$/);
  expect(saveGeneratedImage(root, input)).toEqual(saved);
  expect(JSON.parse(fs.readFileSync(saved.absolutePath.replace(/\.png$/, ".json"), "utf8"))).toMatchObject({ title: input.title, prompt: input.prompt });
  fs.unlinkSync(file);
  expect(fs.readFileSync(saved.absolutePath)).toEqual(bytes);
  const text = generatedImageMessage("[Titre]\n!<img>", saved.reference);
  expect(messageImages(text).map(x => x.reference)).toEqual([saved.reference]);
});
it("refuses changed retry content, outside paths and fake rasters", () => {
  const { root, file } = setup();
  const input = { sourcePath: file, title: "Image", requestKey: "generated-002" };
  saveGeneratedImage(root, input);
  expect(() => saveGeneratedImage(root, { ...input, title: "Autre" })).toThrow("Clé");
  const other = setup();
  expect(() => saveGeneratedImage(root, { ...input, sourcePath: other.file })).toThrow("espace");
  fs.writeFileSync(file, "<svg onload='attack()'/>");
  expect(() => saveGeneratedImage(root, input)).toThrow("valide");
});
it("rejects oversized dimensions, oversized files and destination escapes", () => {
  const { root, file, bytes } = setup();
  const input = { sourcePath: file, title: "Image", requestKey: "generated-003" };
  const huge = Buffer.from(bytes); huge.writeUInt32BE(20000, 16); fs.writeFileSync(file, huge);
  expect(() => saveGeneratedImage(root, input)).toThrow("mégapixels");
  fs.truncateSync(file, 8_000_001);
  expect(() => saveGeneratedImage(root, input)).toThrow("8 Mo");
  fs.writeFileSync(file, bytes);
  const outside = setup();
  fs.symlinkSync(outside.root, path.join(root, "artifacts"), "junction");
  expect(() => saveGeneratedImage(root, input)).toThrow("hors");
});
