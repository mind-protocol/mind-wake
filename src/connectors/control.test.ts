import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { seedSimulatedProfile } from "../../test/demo/harness.js";
import { openStore } from "../store/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";
import { controlDbPath } from "../daemon/paths.js";
import { requestPause, persistEmergencyStop, StopFlag } from "../runner/controls.js";
import { revokePermissions } from "../policy/index.js";
import type { UtcTimestamp } from "../contracts/index.js";
import { ConnectorGate } from "./core.js";
import { wakeConnectorControl } from "./local.js";
import { GMAIL_HOSTS } from "./gmail.js";

it.each(["pause", "force-off", "policy", "stop-flag"])(
  "observes real Wake persisted %s during an operation",
  async (mode) => {
    const directory = path.resolve(".local/connector-control/" + randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    seedSimulatedProfile(directory, { hostUnsandboxed: true });
    try {
      // Empty host set here only to test control state without granting network in the fixture policy.
      expect(wakeConnectorControl(directory, []).allowed).toBe(true);
      expect(wakeConnectorControl(directory, GMAIL_HOSTS).allowed).toBe(false);
      const gate = new ConnectorGate(
        () => wakeConnectorControl(directory, []),
        () =>
          Promise.resolve({
            provider: "gmail",
            account: "synthetic",
            generation: "first",
            enabled: true,
          }),
      );
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = gate.run(
        "gmail",
        "synthetic",
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            started();
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("fixture request aborted"));
              },
              {
                once: true,
              },
            );
          }),
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "stopped" });
      await entered;
      if (mode === "stop-flag")
        fs.writeFileSync(path.join(directory, "emergency-stop.flag"), "fixture");
      else {
        const store = openStore(controlDbPath(directory));
        try {
          const ctx = { uow: store.uow, profileId: DEFAULT_PROFILE_ID, now: () => new Date() };
          if (mode === "pause") requestPause(ctx);
          else if (mode === "force-off") persistEmergencyStop(ctx, new StopFlag(directory));
          else
            revokePermissions(store.uow, {
              profileId: DEFAULT_PROFILE_ID,
              at: new Date().toISOString() as UtcTimestamp,
              reason: "synthetic test",
            });
        } finally {
          store.close();
        }
      }
      await assertion;
      expect(wakeConnectorControl(directory, []).allowed).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
