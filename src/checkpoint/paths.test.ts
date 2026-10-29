/**
 * Confinement : refus lexicaux, puis vrais liens créés sur le disque (jonction,
 * lien symbolique si le privilège existe, lien physique). Les vérifications restent
 * applicatives ; l'isolation système est testée par S2/S10.
 */

import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAN_SYMLINK, workspace, type Workspace } from "../../test/fixtures/checkpoint/setup.js";
import type { ArtifactId, ConfinedRelativePath } from "../contracts/index.js";
import {
  ConfinementError,
  checkRelativePath,
  digestConfined,
  openRoot,
  resolveConfined,
  verifyArtifact,
  writeArtifactAtomic,
} from "./index.js";

let ws: Workspace;

beforeEach(() => {
  ws = workspace();
  writeFileSync(join(ws.outside, "secret.txt"), "hors périmètre");
});

afterEach(() => {
  ws.remove();
});

const rel = (path: string): ConfinedRelativePath => path as ConfinedRelativePath;

describe("contrôle lexical", () => {
  it.each([["notes/a.md"], ["a.txt"], ["data/run-1/result_2.json"], ["x/y/z/.hidden"]])(
    "accepte %s",
    (path) => {
      expect(checkRelativePath(path)).toEqual({ ok: true, path });
    },
  );

  it.each([
    ["..", "path_escape"],
    ["../outside/secret.txt", "path_escape"],
    ["notes/../../outside", "path_escape"],
    ["notes\\..\\..\\outside", "path_escape"],
    ["/etc/passwd", "path_escape"],
    ["C:\\Windows\\System32", "path_escape"],
    ["C:/Windows", "path_escape"],
    ["C:relatif", "path_escape"],
    ["\\\\serveur\\partage\\x", "path_escape"],
    ["//serveur/partage", "path_escape"],
    ["\\racine", "path_escape"],
    ["notes/a.md:flux", "path_escape"],
    ["CON", "path_escape"],
    ["notes/nul.txt", "path_escape"],
    ["lpt1", "path_escape"],
    ["notes\\a.md", "malformed"],
    ["notes//a.md", "malformed"],
    ["./a.md", "malformed"],
    ["notes/", "malformed"],
    ["a.md.", "malformed"],
    ["a.md ", "malformed"],
    ["a\u0000b", "malformed"],
    ["a*b", "malformed"],
    [".mw-tmp-123", "malformed"],
    ["", "malformed"],
  ])("refuse %j (%s)", (path, reason) => {
    const result = checkRelativePath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("refuse une valeur non textuelle", () => {
    expect(checkRelativePath(42).ok).toBe(false);
    expect(checkRelativePath(null).ok).toBe(false);
  });
});

describe("contrôle au moment de l'accès", () => {
  it("lit un fichier ordinaire sous la racine", () => {
    const root = openRoot(ws.artifacts);
    const ref = writeArtifactAtomic(root, "notes/a.md", "bonjour", { id: "a1" as ArtifactId });
    expect(verifyArtifact(root, ref)).toEqual({ ok: true });
    expect(digestConfined(root, ref.path).bytes).toBe(7);
  });

  it("refuse une jonction vers l'extérieur, en lecture comme en écriture", () => {
    // Jonction réelle : aucun privilège requis sous Windows (ailleurs, lien de répertoire).
    symlinkSync(ws.outside, join(ws.artifacts, "j"), "junction");
    const root = openRoot(ws.artifacts);
    expect(() => resolveConfined(root, rel("j/secret.txt"))).toThrow(ConfinementError);
    expect(
      verifyArtifact(root, {
        path: rel("j/secret.txt"),
        sha256: "0".repeat(64) as never,
        bytes: 0,
      }),
    ).toMatchObject({
      ok: false,
      reason: "path_escape",
    });
    expect(() =>
      writeArtifactAtomic(root, "j/evasion.txt", "x", { id: "a1" as ArtifactId }),
    ).toThrow(/lien symbolique ou jonction/);
  });

  it("refuse une jonction intermédiaire même si elle pointe sous la racine", () => {
    mkdirSync(join(ws.artifacts, "real"));
    writeFileSync(join(ws.artifacts, "real", "a.txt"), "a");
    symlinkSync(join(ws.artifacts, "real"), join(ws.artifacts, "alias"), "junction");
    const root = openRoot(ws.artifacts);
    expect(() => resolveConfined(root, rel("alias/a.txt"))).toThrow(/jonction/);
  });

  it("refuse une racine d'artefacts qui est elle-même une jonction", () => {
    const linked = join(ws.path, "linked-root");
    symlinkSync(ws.outside, linked, "junction");
    expect(() => openRoot(linked)).toThrow(/lien ou une jonction/);
  });

  it.skipIf(!CAN_SYMLINK)("refuse un lien symbolique de fichier vers l'extérieur", () => {
    symlinkSync(join(ws.outside, "secret.txt"), join(ws.artifacts, "s.txt"), "file");
    const root = openRoot(ws.artifacts);
    expect(() => digestConfined(root, rel("s.txt"))).toThrow(/lien symbolique/);
  });

  it.skipIf(!CAN_SYMLINK)("refuse un lien symbolique de répertoire vers l'extérieur", () => {
    symlinkSync(ws.outside, join(ws.artifacts, "d"), "dir");
    const root = openRoot(ws.artifacts);
    expect(() => digestConfined(root, rel("d/secret.txt"))).toThrow(/lien symbolique/);
  });

  it("refuse un fichier à liens physiques multiples (hardlink vers l'extérieur)", () => {
    linkSync(join(ws.outside, "secret.txt"), join(ws.artifacts, "h.txt"));
    const root = openRoot(ws.artifacts);
    expect(() => digestConfined(root, rel("h.txt"))).toThrow(/hardlink/);
  });

  it("n'écrit pas à travers un lien physique : le renommage remplace seulement le nom", () => {
    linkSync(join(ws.outside, "secret.txt"), join(ws.artifacts, "h.txt"));
    const root = openRoot(ws.artifacts);
    writeArtifactAtomic(root, "h.txt", "nouveau", { id: "a1" as ArtifactId });
    expect(digestConfined(root, rel("h.txt")).bytes).toBe(7);
    const outside = openRoot(ws.outside);
    expect(digestConfined(outside, rel("secret.txt")).bytes).toBe(
      Buffer.byteLength("hors périmètre"),
    );
  });

  it("refuse d'écrire sur un répertoire existant", () => {
    mkdirSync(join(ws.artifacts, "dir"));
    const root = openRoot(ws.artifacts);
    expect(() => writeArtifactAtomic(root, "dir", "x", { id: "a1" as ArtifactId })).toThrow(
      ConfinementError,
    );
  });

  it("refuse en écriture les chemins lexicalement hostiles", () => {
    const root = openRoot(ws.artifacts);
    for (const path of ["../outside/x.txt", join(ws.outside, "x.txt"), "a/../../x"]) {
      expect(() => writeArtifactAtomic(root, path, "x", { id: "a1" as ArtifactId })).toThrow(
        ConfinementError,
      );
    }
  });
});
