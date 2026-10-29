import { describe, expect, it } from "vitest";
import { panelView, STALE_AFTER_MS, type StatusRead } from "./view.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function envelope(data: unknown): unknown {
  return { schema: "mind-wake.cli", schemaVersion: 1, command: "status", ok: true, data };
}

function profileData(state: string, extra: Record<string, unknown> = {}): unknown {
  return {
    profile: {
      id: "default",
      state,
      stateReason: "motif de test",
      emergencyStopLocked: false,
      activePolicyRevisionId: null,
      nextWakeAt: null,
      updatedAt: "2026-10-29T11:59:00Z",
    },
    hint: null,
    activeExperiment: null,
    openSessions: 0,
    daemon: {
      state: "running",
      mode: "simulated",
      pid: 1,
      startedAt: null,
      endedAt: null,
      endReason: null,
    },
    lastSession: null,
    lastEvent: null,
    budget: {
      availability: "unknown",
      detail: "ledger non consultable",
      caps: null,
      subscriptionQuota: null,
    },
    capabilities: [],
    ...extra,
  };
}

function read(data: unknown, fetchedAt = NOW): StatusRead {
  return { ok: true, fetchedAt, envelope: envelope(data) };
}

describe("panelView", () => {
  it("affiche l'état réel, son motif et la mention SIMULÉ", () => {
    const view = panelView(read(profileData("running")), NOW);
    expect(view.headline).toBe("Travaille");
    expect(view.reason).toBe("motif de test");
    expect(view.simulated).toBe(true);
    expect(view.activity.find((l) => l.label === "Daemon")?.value).toContain("SIMULÉ");
  });

  it("n'affiche jamais un budget inconnu comme disponible", () => {
    const view = panelView(read(profileData("ready")), NOW);
    expect(view.consumption.find((l) => l.label === "Budget disponible")?.value).toMatch(
      /^inconnu/,
    );
    expect(view.consumption.find((l) => l.label === "Dernière session")?.value).toBe(
      "tokens inconnus",
    );
  });

  it("W03 : lecture échouée → état indisponible, jamais le dernier état", () => {
    const view = panelView({ ok: false, fetchedAt: NOW, error: "node introuvable" }, NOW);
    expect(view.headline).toBe("État indisponible");
    expect(view.tone).toBe("unknown");
    expect(view.reason).toContain("node introuvable");
    expect(view.canStop).toBe(true);
  });

  it("W03 : lecture périmée → état indisponible", () => {
    const view = panelView(read(profileData("running"), NOW - STALE_AFTER_MS - 1), NOW);
    expect(view.headline).toBe("État indisponible");
  });

  it("refuse un schéma inattendu", () => {
    const view = panelView(
      { ok: true, fetchedAt: NOW, envelope: { schema: "autre", schemaVersion: 1 } },
      NOW,
    );
    expect(view.headline).toBe("État indisponible");
  });

  it("arrêt d'urgence verrouillé : ni pause, ni reprise, ni nouvel arrêt proposés", () => {
    const data = profileData("stopped") as { profile: Record<string, unknown> };
    data.profile["emergencyStopLocked"] = true;
    const view = panelView(read(data), NOW);
    expect(view.tone).toBe("stopped");
    expect([view.canPause, view.canResume, view.canStop]).toEqual([false, false, false]);
  });

  it("reprise proposée seulement en pause", () => {
    expect(panelView(read(profileData("paused")), NOW).canResume).toBe(true);
    expect(panelView(read(profileData("ready")), NOW).canResume).toBe(false);
  });

  it("profil absent : invite à configurer, sans commandes", () => {
    const view = panelView(
      read({ ...(profileData("ready") as object), profile: null, hint: "lancer init" }),
      NOW,
    );
    expect(view.headline).toBe("Wake n'est pas configuré");
    expect(view.reason).toBe("lancer init");
    expect(view.canStop).toBe(false);
  });

  it("la garde de quota n'est pas présentée comme une borne de tokens", () => {
    const quota = { enabled: true, startBelow: "60 %", stopAt: "80 %" };
    const view = panelView(
      read(
        profileData("ready", {
          budget: { availability: "unknown", detail: "x", caps: null, subscriptionQuota: quota },
        }),
      ),
      NOW,
    );
    expect(view.protection.find((l) => l.label === "Garde de quota fournisseur")?.value).toContain(
      "pas une borne de tokens",
    );
  });
});

describe("panelView, cas relevés à l'aperçu", () => {
  it("profil désactivé sans daemon : ni SIMULÉ ni pause proposée, contact « à l'instant »", () => {
    const data = profileData("disabled", {
      daemon: {
        state: "never",
        mode: null,
        pid: null,
        startedAt: null,
        endedAt: null,
        endReason: null,
      },
    });
    const view = panelView(read(data), NOW);
    expect(view.simulated).toBe(false);
    expect(view.canPause).toBe(false);
    expect(view.lastContact).toBe("à l'instant");
  });
});

describe("voyant et sélecteur", () => {
  it("état → voyant ; réveil proposé seulement prêt ou en hibernation", () => {
    const cases: [string, string, boolean][] = [
      ["running", "awake", false],
      ["ready", "on", true],
      ["hibernating", "on", true],
      ["paused", "off", false],
      ["stopped", "forced_off", false],
    ];
    for (const [state, light, canWake] of cases) {
      const view = panelView(read(profileData(state)), NOW);
      expect([state, view.light, view.canWake]).toEqual([state, light, canWake]);
    }
    expect(panelView(null, NOW).light).toBe("unknown");
  });
});

it("always-on est affiché comme un mode persistant et ne dépasse pas l’arrêt humain", () => {
  const data = profileData("running") as Record<string, unknown>;
  data["executionMode"] = "always-on";
  expect(panelView(read(data), NOW)).toMatchObject({ alwaysOn: true, canAlwaysOn: true });
  const stopped = profileData("stopped") as Record<string, unknown>;
  stopped["executionMode"] = "always-on";
  expect(panelView(read(stopped), NOW)).toMatchObject({ alwaysOn: false, canAlwaysOn: false });
});
