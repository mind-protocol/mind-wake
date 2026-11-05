import { test } from "node:test";
import assert from "node:assert/strict";
import { canRestartCrashed } from "./desktop-supervisor.mjs";

const status = (daemon, state, locked = false) => ({
  ok: true,
  data: { daemon: { state: daemon }, profile: { state, emergencyStopLocked: locked } },
});

test("moteur arrêté brutalement : relancé, même avec une session restée ouverte", () => {
  for (const state of ["ready", "hibernating", "running", "checkpointing"]) {
    assert.equal(canRestartCrashed(status("crashed", state)), true, state);
  }
});

test("arrêt propre, moteur actif ou jamais lancé : rien n'est relancé", () => {
  for (const daemon of ["stopped", "running", "never"]) {
    assert.equal(canRestartCrashed(status(daemon, "hibernating")), false, daemon);
  }
});

test("arrêt d'urgence, pause, blocage ou profil désactivé : jamais relancé", () => {
  assert.equal(canRestartCrashed(status("crashed", "stopped", true)), false);
  assert.equal(canRestartCrashed(status("crashed", "ready", true)), false);
  for (const state of ["paused", "blocked", "disabled", "stopped"]) {
    assert.equal(canRestartCrashed(status("crashed", state)), false, state);
  }
  assert.equal(canRestartCrashed({ ok: false }), false);
  assert.equal(canRestartCrashed(null), false);
});
