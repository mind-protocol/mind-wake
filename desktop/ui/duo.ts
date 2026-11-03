type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** Persistent profile setting. Never starts a model session or resumes Wake. */
export function initDuo(invoke: Invoke): void {
  const toggle = document.getElementById("duo-enabled") as HTMLInputElement;
  const status = document.getElementById("duo-status")!;
  let busy = false;
  let persisted: boolean | null = null;
  async function call(action: string): Promise<boolean> {
    const run = (await invoke("wake_coach", { action })) as { exitCode: number; stdout: string };
    const result = JSON.parse(run.stdout) as {
      ok?: boolean;
      data?: { enabled: boolean };
      error?: { message: string };
    };
    if (run.exitCode !== 0 || !result.ok || !result.data)
      throw Error(result.error?.message ?? "Réglage non confirmé");
    return result.data.enabled;
  }
  async function update(action: string): Promise<void> {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try {
      toggle.checked = await call(action);
      persisted = toggle.checked;
      status.textContent = toggle.checked
        ? "Activé — un rappel après 30 s sans nouveau contenu visuel, puis au plus toutes les 30 s. Pause et Force-off suspendent les rappels."
        : "Désactivé";
    } catch (error) {
      if (persisted !== null) toggle.checked = persisted;
      status.textContent = String(error);
    } finally {
      busy = false;
      toggle.disabled = false;
    }
  }
  toggle.addEventListener("change", () => {
    void update(toggle.checked ? "duo-on" : "duo-off");
  });
  document.getElementById("tab-settings")!.addEventListener("click", () => {
    void update("duo-status");
  });
  void update("duo-status");
}
