import { afterEach, expect, it, vi } from "vitest";
import {
  initWorkspaceSync,
  syncDate,
  syncStateLabel,
  workspaceEffect,
  type WorkspaceSyncStatus,
} from "./workspace-sync.js";

it("shows blocked and paused states without claiming sync succeeded", () => {
  expect(syncStateLabel("blocked")).toContain("intervention");
  expect(syncStateLabel("paused")).toBe("En pause");
  expect(syncStateLabel("running")).toBe("Synchronisation en cours");
  expect(syncStateLabel("success")).toBe("Synchronisation réussie");
  expect(syncStateLabel("new-state")).toBe("new-state");
});

it("keeps missing or invalid timestamps explicit", () => {
  expect(syncDate(null)).toBe("—");
  expect(syncDate("not-a-date")).toBe("Indisponible");
  expect(syncDate("2026-10-31T00:00:00Z")).not.toBe("Indisponible");
});

it("distinguishes saved workspace from the active engine workspace", () => {
  const status: WorkspaceSyncStatus = {
    config: { workspaceDir: "C:\\next", githubUrl: "", enabled: false },
    state: {
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      status: "disabled",
      error: null,
    },
    activeWorkspace: "C:\\current",
    pendingRestart: true,
  };
  expect(workspaceEffect(status)).toContain("prochain lancement");
  expect(workspaceEffect({ ...status, pendingRestart: false })).toBe(
    "Le moteur utilise ce dossier de travail.",
  );
});

// Same narrow event surface as documents-scope.test.ts; real panel handlers are exercised.
class PanelElement {
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  addEventListener(name: string, fn: (event: { preventDefault(): void }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  fire(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ preventDefault() {} });
  }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
it("runs panel load, edit, save, pending restart, sync off, busy and manual request handlers", async () => {
  vi.useFakeTimers();
  const nodes = new Map<string, PanelElement>();
  const node = (id: string): PanelElement => {
    let n = nodes.get(id);
    if (!n) {
      n = new PanelElement();
      nodes.set(id, n);
    }
    return n;
  };
  vi.stubGlobal("document", { getElementById: node });
  let data: WorkspaceSyncStatus = {
    config: { workspaceDir: "C:/work", githubUrl: "https://github.com/a/b.git", enabled: true },
    activeWorkspace: "C:/work",
    pendingRestart: false,
    state: {
      status: "waiting",
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      error: null,
    },
  };
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "workspace_sync_configure") {
      data = {
        ...data,
        config: args as unknown as WorkspaceSyncStatus["config"],
        pendingRestart: args?.["workspaceDir"] !== data.activeWorkspace,
      };
    }
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }) });
  });
  initWorkspaceSync(invoke);
  await flush();
  expect(node("workspace-sync-state").textContent).toBe("En attente");
  expect(node("workspace-sync-now").disabled).toBe(false);
  node("workspace-sync-folder").value = "C:/next";
  node("workspace-sync-form").fire("input");
  expect(node("workspace-sync-now").disabled).toBe(true);
  node("workspace-sync-now").fire("click");
  expect(invoke).toHaveBeenCalledTimes(1);
  node("workspace-sync-form").fire("submit");
  expect(node("workspace-sync-save").disabled).toBe(true);
  await flush();
  expect(node("workspace-sync-now").disabled).toBe(true);
  expect(node("workspace-sync-effect").textContent).toContain("prochain lancement");
  data = {
    ...data,
    activeWorkspace: "C:/next",
    pendingRestart: false,
    state: { ...data.state, status: "pending_restart" },
  };
  node("tab-settings").fire("click");
  await flush();
  expect(node("workspace-sync-state").textContent).toContain("moteur");
  node("workspace-sync-now").fire("click");
  expect(node("workspace-sync-now").disabled).toBe(true);
  await flush();
  expect(invoke.mock.calls.at(-1)?.[0]).toBe("workspace_sync_now");
  node("workspace-sync-enabled").checked = false;
  node("workspace-sync-form").fire("change");
  expect(node("workspace-sync-now").disabled).toBe(true);
  node("workspace-sync-form").fire("submit");
  await flush();
  expect(node("workspace-sync-now").disabled).toBe(true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
