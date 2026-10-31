/** Settings uses the profile CLI; this panel never runs Git or creates a wake. */
export interface WorkspaceSyncStatus {
  config: { workspaceDir: string; githubUrl: string; enabled: boolean };
  state: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextRunAt: string | null;
    status: string;
    error: string | null;
  };
  activeWorkspace: string;
  pendingRestart: boolean;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Envelope {
  ok?: boolean;
  data?: WorkspaceSyncStatus;
  error?: { message?: string };
}

export function syncStateLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: "En attente",
    waiting: "En attente",
    pending_restart: "Redémarrage du moteur nécessaire",
    disabled: "Désactivée",
    paused: "En pause",
    stopped: "Arrêtée",
    running: "Synchronisation en cours",
    syncing: "Synchronisation en cours",
    success: "Synchronisation réussie",
    ok: "Synchronisation réussie",
    blocked: "Bloquée — intervention nécessaire",
    conflict: "Conflit — résoudre dans le dépôt",
    error: "Échec de synchronisation",
  };
  return labels[status] ?? status;
}

export function syncDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Indisponible" : date.toLocaleString("fr-FR");
}

export function workspaceEffect(data: WorkspaceSyncStatus): string {
  return data.pendingRestart
    ? "Le nouveau dossier sera utilisé au prochain lancement du moteur. Aucun fichier n’a été déplacé."
    : "Le moteur utilise ce dossier de travail.";
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw Error(`Élément #${id} absent`);
  return found;
}

export function initWorkspaceSync(invoke: Invoke): void {
  const form = element("workspace-sync-form") as HTMLFormElement;
  const workspace = element("workspace-sync-folder") as HTMLInputElement;
  const github = element("workspace-sync-url") as HTMLInputElement;
  const enabled = element("workspace-sync-enabled") as HTMLInputElement;
  const save = element("workspace-sync-save") as HTMLButtonElement;
  const now = element("workspace-sync-now") as HTMLButtonElement;
  const feedback = element("workspace-sync-feedback");
  let hydrated = false;
  let busy = false;
  let reading = false;
  let persisted: WorkspaceSyncStatus | null = null;

  const draftChanged = (): boolean =>
    persisted === null ||
    workspace.value.trim() !== persisted.config.workspaceDir ||
    github.value.trim() !== persisted.config.githubUrl ||
    enabled.checked !== persisted.config.enabled;

  function controls(): void {
    save.disabled = busy;
    now.disabled =
      busy ||
      persisted === null ||
      !persisted.config.enabled ||
      persisted.pendingRestart ||
      draftChanged();
  }

  function render(data: WorkspaceSyncStatus, updateInputs: boolean): void {
    persisted = data;
    if (updateInputs) {
      workspace.value = data.config.workspaceDir;
      github.value = data.config.githubUrl;
      enabled.checked = data.config.enabled;
      hydrated = true;
    }
    element("workspace-sync-active").textContent = data.activeWorkspace;
    element("workspace-sync-effect").textContent = workspaceEffect(data);
    element("workspace-sync-state").textContent = syncStateLabel(data.state.status);
    element("workspace-sync-last-attempt").textContent = syncDate(data.state.lastAttemptAt);
    element("workspace-sync-last-success").textContent = syncDate(data.state.lastSuccessAt);
    element("workspace-sync-next").textContent = syncDate(data.state.nextRunAt);
    element("workspace-sync-error").textContent = data.state.error ?? "Aucune";
    controls();
  }

  async function call(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<WorkspaceSyncStatus> {
    const run = (await invoke(command, args)) as { exitCode: number; stdout: string };
    const result = JSON.parse(run.stdout) as Envelope;
    if (run.exitCode !== 0 || !result.ok || !result.data)
      throw Error(result.error?.message ?? "Opération non confirmée par le moteur");
    return result.data;
  }

  async function refresh(): Promise<void> {
    if (reading || busy) return;
    reading = true;
    try {
      const data = await call("workspace_sync_status");
      render(data, !hydrated);
    } catch (error) {
      element("workspace-sync-state").textContent = "État indisponible";
      element("workspace-sync-next").textContent = "Indisponible";
      feedback.textContent = error instanceof Error ? error.message : String(error);
      persisted = null;
      controls();
    } finally {
      reading = false;
    }
  }

  form.addEventListener("input", controls);
  form.addEventListener("change", controls);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    controls();
    feedback.textContent = "Enregistrement…";
    void call("workspace_sync_configure", {
      workspaceDir: workspace.value.trim(),
      githubUrl: github.value.trim(),
      enabled: enabled.checked,
    })
      .then((data) => {
        render(data, true);
        feedback.textContent = "Réglages enregistrés.";
      })
      .catch((error: unknown) => {
        feedback.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        busy = false;
        controls();
      });
  });
  now.addEventListener("click", () => {
    if (now.disabled || busy) return;
    busy = true;
    controls();
    feedback.textContent = "Demande de synchronisation…";
    void call("workspace_sync_now")
      .then((data) => {
        render(data, false);
        feedback.textContent = "Demande enregistrée. Le statut ci-dessous suit son exécution.";
      })
      .catch((error: unknown) => {
        feedback.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        busy = false;
        controls();
      });
  });
  element("tab-settings").addEventListener("click", () => {
    void refresh();
  });
  setInterval(() => {
    if (!element("view-settings").hidden) void refresh();
  }, 5000);
  controls();
  void refresh();
}
