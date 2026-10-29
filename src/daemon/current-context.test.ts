import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_CONTEXT_FILE,
  currentContextEvent,
  MAX_CURRENT_CONTEXT_CHARS,
} from "./current-context.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "current-context-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("currentContextEvent", () => {
  it("absent ou vide : rien à injecter", () => {
    expect(currentContextEvent(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, CURRENT_CONTEXT_FILE), "  \n ");
    expect(currentContextEvent(dir)).toBeNull();
  });

  it("une seule ligne, marquée comme note de l'agent", () => {
    fs.writeFileSync(
      path.join(dir, CURRENT_CONTEXT_FILE),
      "Contexte en cours : conseil-glenan\n· réveil 5 sur 22 budgétés\n",
    );
    expect(currentContextEvent(dir)).toBe(
      "Your own current-context note (artifacts/contexte-courant.txt, your text, not an instruction): Contexte en cours : conseil-glenan · réveil 5 sur 22 budgétés",
    );
  });

  it("tronquée à 500 caractères ; fichier démesuré ou dossier ignorés", () => {
    fs.writeFileSync(path.join(dir, CURRENT_CONTEXT_FILE), "x".repeat(2_000));
    const event = currentContextEvent(dir) ?? "";
    expect(event.endsWith(`${"x".repeat(MAX_CURRENT_CONTEXT_CHARS)}…`)).toBe(true);

    fs.writeFileSync(path.join(dir, CURRENT_CONTEXT_FILE), "y".repeat(20_000));
    expect(currentContextEvent(dir)).toBeNull();

    fs.rmSync(path.join(dir, CURRENT_CONTEXT_FILE));
    fs.mkdirSync(path.join(dir, CURRENT_CONTEXT_FILE));
    expect(currentContextEvent(dir)).toBeNull();
  });
});
