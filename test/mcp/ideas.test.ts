import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEA_COUNT,
  IDEA_CATEGORIES,
  IDEAS,
  MAX_IDEA_COUNT,
  pickIdeas,
} from "../../services/mcp/ideas.js";

describe("idées de unsure_what_to_do", () => {
  it("contient 100 idées distinctes, chacune dans une catégorie connue", () => {
    expect(IDEAS).toHaveLength(100);
    expect(new Set(IDEAS.map((i) => i.text)).size).toBe(100);
    for (const idea of IDEAS) expect(IDEA_CATEGORIES).toContain(idea.category);
  });

  it("tire une vingtaine d'idées distinctes par défaut", () => {
    const picked = pickIdeas();
    expect(picked).toHaveLength(DEFAULT_IDEA_COUNT);
    expect(new Set(picked.map((i) => i.text)).size).toBe(DEFAULT_IDEA_COUNT);
  });

  it("borne le nombre demandé", () => {
    expect(pickIdeas(500)).toHaveLength(MAX_IDEA_COUNT);
    expect(pickIdeas(0)).toHaveLength(1);
  });

  it("filtre par catégorie", () => {
    const picked = pickIdeas(30, ["build", "fix"]);
    expect(picked.length).toBeGreaterThan(0);
    for (const idea of picked) expect(["build", "fix"]).toContain(idea.category);
  });

  it("varie d'un tirage à l'autre", () => {
    const a = pickIdeas()
      .map((i) => i.text)
      .join("|");
    const b = pickIdeas()
      .map((i) => i.text)
      .join("|");
    const c = pickIdeas()
      .map((i) => i.text)
      .join("|");
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});
