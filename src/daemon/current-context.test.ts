import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WakeManager } from "./wake-manager.js";
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
  it("relit une réservation et un contexte SQLite réels sur un profil de test", () => {
    const artifacts = path.join(dir, "artifacts");
    fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(artifacts, "projets-compteur.json"), JSON.stringify({
      current: "planifier-le-travail",
      projects: { "planifier-le-travail": { title: "Planifier le travail", status: "en cours" } },
    }));
    fs.writeFileSync(path.join(artifacts, CURRENT_CONTEXT_FILE), "conseil-glenan · 10 sur 40");
    const manager = new WakeManager(dir);
    try {
      manager.configure(true);
      manager.saveContext("planifier-le-travail", {
        summary: "Export terminé ; vérifier le second passage.", nextActions: [], openQuestions: [], sources: [],
      }, null);
      const wake = manager.reserve("fixture-session")!;
      const before = JSON.stringify(manager.status());
      const event = currentContextEvent(artifacts, {
        number: wake.number, inBlock: wake.inBlock, projectId: wake.projectId,
        contextPath: wake.contextPath,
        summary: manager.project(wake.projectId!).context?.summary ?? null,
      })!;
      expect(event).toContain('"projectId":"planifier-le-travail"');
      expect(event).toContain("Export terminé ; vérifier le second passage.");
      expect(event).toContain(wake.contextPath!);
      expect(event).not.toContain("glenan");
      expect(JSON.stringify(manager.status())).toBe(before);
      expect(manager.pending()?.sessionId).toBe("fixture-session");
    } finally { manager.close(); }
  });

  it("la réservation planning remplace la note historique sans la modifier", () => {
    const file = path.join(dir, CURRENT_CONTEXT_FILE);
    const historical = "conseil-glenan · réveil 10 sur 40 budgétés";
    fs.writeFileSync(file, historical);
    const reservation = {
      number: 46, inBlock: 8, projectId: "planifier-le-travail",
      contextPath: "artifacts/wake-manager/planning/context.json",
      summary: "Raccord prêt.\nSeconde reprise à éprouver.",
    };
    const before = JSON.stringify(reservation);
    const event = currentContextEvent(dir, reservation)!;
    expect(event).toContain('"wake":46');
    expect(event).toContain('"projectId":"planifier-le-travail"');
    expect(event).toContain("Raccord prêt. Seconde reprise à éprouver.");
    expect(event).not.toContain("glenan");
    expect(fs.readFileSync(file, "utf8")).toBe(historical);
    expect(JSON.stringify(reservation)).toBe(before);
  });

  it("sans contexte projet, conserve la réservation et un résumé absent explicite", () => {
    fs.writeFileSync(path.join(dir, CURRENT_CONTEXT_FILE), "ancien Glénan");
    const event = currentContextEvent(dir, {
      number: 46, inBlock: 8, projectId: "planifier-le-travail",
      contextPath: "artifacts/wake-manager/planning/context.json", summary: null,
    })!;
    expect(event).toContain('"summary":null');
    expect(event).toContain('"wake":46');
    expect(event).not.toContain("Glénan");
  });

  it("rotation libre : aucun repli vers le dernier projet", () => {
    fs.writeFileSync(path.join(dir, CURRENT_CONTEXT_FILE), "ancien Glénan");
    expect(currentContextEvent(dir, {
      number: 46, inBlock: 8, projectId: null, contextPath: null, summary: null,
    })).toContain('"projectId":null');
    expect(currentContextEvent(dir, null)).toContain("ancien Glénan");
  });

  it("borne le résumé réservé et ignore le fichier historique même absent", () => {
    const event = currentContextEvent(dir, {
      number: 46, inBlock: 8, projectId: "planning", contextPath: "context.json",
      summary: "x".repeat(2_000),
    })!;
    expect(event).toContain(`${"x".repeat(MAX_CURRENT_CONTEXT_CHARS)}…`);
    expect(event).not.toContain("x".repeat(MAX_CURRENT_CONTEXT_CHARS + 1));
  });

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
