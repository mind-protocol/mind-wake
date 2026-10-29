import { describe, expect, it } from "vitest";
import {
  PROFILE_STATES,
  PROFILE_TRANSITIONS,
  SESSION_OUTCOMES,
  isProfileTransitionAllowed,
  type ProfileState,
} from "./lifecycle.js";

function reachableFrom(start: ProfileState): Set<ProfileState> {
  const seen = new Set<ProfileState>([start]);
  const queue: ProfileState[] = [start];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    for (const rule of PROFILE_TRANSITIONS[state]) {
      if (!seen.has(rule.to)) {
        seen.add(rule.to);
        queue.push(rule.to);
      }
    }
  }
  return seen;
}

describe("table de transitions du profil", () => {
  it("couvre exactement les 8 états de SPEC §5.1", () => {
    expect(PROFILE_STATES).toHaveLength(8);
    expect(Object.keys(PROFILE_TRANSITIONS).sort()).toEqual([...PROFILE_STATES].sort());
  });

  it("ne contient ni boucle sur soi-même, ni doublon, ni règle sans garde", () => {
    for (const from of PROFILE_STATES) {
      const targets = PROFILE_TRANSITIONS[from].map((rule) => rule.to);
      expect(targets).not.toContain(from);
      expect(new Set(targets).size).toBe(targets.length);
      for (const rule of PROFILE_TRANSITIONS[from]) {
        expect(rule.guards.length).toBeGreaterThan(0);
      }
    }
  });

  it("rend chaque état atteignable depuis disabled", () => {
    expect([...reachableFrom("disabled")].sort()).toEqual([...PROFILE_STATES].sort());
  });

  it("permet l'arrêt d'urgence depuis tout état activé", () => {
    for (const from of PROFILE_STATES) {
      if (from === "disabled" || from === "stopped") continue;
      expect(isProfileTransitionAllowed(from, "stopped")).toBe(true);
    }
  });

  it("exige une action humaine pour sortir de disabled, paused ou stopped vers ready", () => {
    for (const from of ["disabled", "paused", "stopped"] as const) {
      const rule = PROFILE_TRANSITIONS[from].find((r) => r.to === "ready");
      expect(rule?.guards).toContain("user_action");
      expect(rule?.guards).toContain("checks");
    }
  });

  it("ne laisse sortir de stopped que vers ready", () => {
    expect(PROFILE_TRANSITIONS.stopped.map((rule) => rule.to)).toEqual(["ready"]);
  });

  it("interdit de lancer une session sans passer par ready", () => {
    for (const from of PROFILE_STATES) {
      expect(isProfileTransitionAllowed(from, "running")).toBe(from === "ready");
    }
  });

  it("impose un passage par checkpointing pour quitter running vers une attente", () => {
    expect(isProfileTransitionAllowed("running", "hibernating")).toBe(false);
    expect(isProfileTransitionAllowed("running", "paused")).toBe(false);
    expect(isProfileTransitionAllowed("running", "ready")).toBe(false);
  });

  it("distingue les 4 résultats de session de l'état du profil", () => {
    expect(SESSION_OUTCOMES).toEqual(["completed", "interrupted", "failed", "orphaned"]);
    for (const outcome of SESSION_OUTCOMES) {
      expect(PROFILE_STATES as readonly string[]).not.toContain(outcome);
    }
  });
});
