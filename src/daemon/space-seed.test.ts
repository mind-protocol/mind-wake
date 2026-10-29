import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEED_MARKER, seedAgentSpace } from "./space-seed.js";

let tmp: string;
let space: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-seed-"));
  space = path.join(tmp, "workspace");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("squelettes de l'espace agent", () => {
  it("dépose tous les squelettes au premier réveil", () => {
    const result = seedAgentSpace(space);
    expect(result.seeded).toBe(true);
    expect(result.created).toEqual(
      expect.arrayContaining(["todo.md", "plans.md", "human-portrait.md", "relations/README.md"]),
    );
    expect(fs.readFileSync(path.join(space, "todo.md"), "utf8")).toContain("# To-do");
    expect(fs.existsSync(path.join(space, SEED_MARKER))).toBe(true);
  });

  it("n'écrase jamais un fichier de l'agent", () => {
    fs.mkdirSync(space, { recursive: true });
    fs.writeFileSync(path.join(space, "todo.md"), "mes tâches");
    const result = seedAgentSpace(space);
    expect(result.skipped).toContain("todo.md");
    expect(fs.readFileSync(path.join(space, "todo.md"), "utf8")).toBe("mes tâches");
  });

  it("ne recrée pas un fichier supprimé par l'agent", () => {
    seedAgentSpace(space);
    fs.rmSync(path.join(space, "ideas.md"));
    const again = seedAgentSpace(space);
    expect(again.seeded).toBe(false);
    expect(fs.existsSync(path.join(space, "ideas.md"))).toBe(false);
  });

  it("ne suit pas une jonction vers l'extérieur de l'espace", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(space, { recursive: true });
    fs.symlinkSync(outside, path.join(space, "relations"), "junction");
    const result = seedAgentSpace(space);
    expect(result.skipped).toContain("relations/README.md");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
