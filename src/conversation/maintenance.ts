/** Backend Git maintenance only. Call inside the supervised conversation worker. */
import path from "node:path";
import { AuroreGitSync } from "../daemon/aurore-git-sync.js";
import { WorkspaceGitSync } from "../daemon/workspace-git-sync.js";
import {
  acquireInstanceLock,
  InstanceLockError,
  type InstanceLock,
} from "../scheduler/instance-lock.js";
import { inspectConversationRuntime } from "./role-runtime.js";

export interface ConversationMaintenanceService {
  tick(): Promise<void>;
  close(): Promise<void>;
}
export interface ConversationMaintenance {
  stop(): Promise<void>;
}
export interface ConversationMaintenanceOptions {
  signal?: AbortSignal;
  onError?: (service: string, error: unknown) => void;
  /** Code-only seams; no renderer input or installation configuration. */
  allowed?: () => boolean;
  pollMs?: number;
  createServices?: (
    dataDir: string,
    allowed: () => boolean,
  ) => readonly { name: string; service: ConversationMaintenanceService }[];
}

export function startConversationMaintenance(
  dataDir: string,
  options: ConversationMaintenanceOptions = {},
): ConversationMaintenance {
  let stopped = false;
  let lock: InstanceLock | undefined;
  let services: readonly { name: string; service: ConversationMaintenanceService }[] = [];
  let flight: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const allowed = () => {
    try {
      return (
        !stopped &&
        options.signal?.aborted !== true &&
        (options.allowed ? options.allowed() : inspectConversationRuntime(dataDir).allowed)
      );
    } catch {
      return false;
    }
  };
  const report = (name: string, error: unknown) => {
    try {
      options.onError?.(name, error);
    } catch {
      // Reporting cannot keep a revoked maintenance service alive.
    }
  };
  const stop = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    closing = (async () => {
      // close() aborts supervised Git and awaits its in-flight tick.
      await Promise.all(
        services.map(async ({ name, service }) => {
          try {
            await service.close();
          } catch (error) {
            report(name, error);
          }
        }),
      );
      await flight;
      lock?.release();
      lock = undefined;
    })();
    return closing;
  };
  const abort = () => {
    void stop();
  };
  const pulse = () => {
    if (!allowed()) {
      void stop();
      return;
    }
    if (flight) return;
    if (!lock) {
      try {
        // Multiple conversations share one profile and one set of existing sync settings.
        lock = acquireInstanceLock(path.join(dataDir, "conversation-maintenance.lock"));
      } catch (error) {
        if (error instanceof InstanceLockError && error.code === "held") return;
        report("maintenance", error);
        void stop();
        return;
      }
      try {
        services = options.createServices
          ? options.createServices(dataDir, allowed)
          : [
              { name: "aurore", service: new AuroreGitSync(dataDir, allowed) },
              { name: "workspace", service: new WorkspaceGitSync(dataDir, allowed) },
            ];
      } catch (error) {
        report("maintenance", error);
        void stop();
        return;
      }
    }
    flight = Promise.allSettled(
      services.map(async ({ name, service }) => {
        try {
          await service.tick();
        } catch (error) {
          report(name, error);
        }
      }),
    ).finally(() => {
      flight = undefined;
    });
  };
  // The services retain their existing persisted 60 s deadlines and opt-in/network guards.
  // This pulse only observes due work and revocation; it never schedules a model wake.
  const timer = setInterval(pulse, options.pollMs ?? 1000);
  timer.unref();
  options.signal?.addEventListener("abort", abort, { once: true });
  pulse();
  return { stop };
}
