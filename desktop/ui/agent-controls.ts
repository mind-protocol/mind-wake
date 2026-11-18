import { tr } from "./i18n.js";

type Envelope = { ok?: unknown; data?: unknown; error?: { message?: unknown } };
type Invoke = (command: string, args: Record<string, unknown>) => Promise<Envelope>;

/** Overview controls stay independent of the retired conversation and dictation UI. */
export function mountAgentControls(invoke: Invoke): void {
  const controls = document.getElementById("fork-controls")!;
  const feedback = document.getElementById("fork-feedback")!;
  const secondFeedback = document.getElementById("second-thread-feedback")!;
  const secondOn = document.getElementById("second-thread-on") as HTMLButtonElement;
  const secondOff = document.getElementById("second-thread-off") as HTMLButtonElement;
  const rows = new Map<number, { button: HTMLButtonElement; label: HTMLElement; enabled: boolean }>();
  let busy = false;
  const request = async (command: string, args: Record<string, unknown>) => {
    const result = await invoke(command, args);
    if (result.ok !== true) throw Error(String(result.error?.message ?? tr("Commande refusée")));
    return result.data;
  };
  const renderForks = (data: unknown) => {
    const model = data as { forks: { id: number; label?: string; enabled: boolean }[] };
    for (const fork of model.forks) {
      let row = rows.get(fork.id);
      if (!row) {
        const container = document.createElement("div");
        container.className = "fork-control";
        const label = document.createElement("strong");
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "switch");
        row = { button, label, enabled: fork.enabled };
        rows.set(fork.id, row);
        container.append(label, button);
        controls.append(container);
        button.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          button.disabled = true;
          try {
            renderForks(await request("wake_forks", { action: rows.get(fork.id)!.enabled ? "off" : "on", id: fork.id }));
            feedback.textContent = "";
          } catch (error) { feedback.textContent = String(error); }
          finally { busy = false; button.disabled = false; }
        });
      }
      row.enabled = fork.enabled;
      row.label.textContent = fork.label || `Room ${fork.id}`;
      row.button.textContent = fork.enabled ? "On" : "Off";
      row.button.setAttribute("aria-checked", String(fork.enabled));
      row.button.setAttribute("aria-label", row.label.textContent);
    }
  };
  const renderSecond = (data: unknown) => {
    const enabled = (data as { enabled: boolean }).enabled;
    secondOn.setAttribute("aria-pressed", String(enabled));
    secondOff.setAttribute("aria-pressed", String(!enabled));
  };
  for (const [button, action] of [[secondOn, "on"], [secondOff, "off"]] as const) {
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      secondOn.disabled = secondOff.disabled = true;
      try {
        renderSecond(await request("second_thread", { action }));
        secondFeedback.textContent = "";
      } catch (error) { secondFeedback.textContent = String(error); }
      finally { busy = false; secondOn.disabled = secondOff.disabled = false; }
    });
  }
  const refresh = async () => {
    if (busy) return;
    busy = true;
    await Promise.all([
      request("wake_forks", { action: "status" }).then(renderForks).catch(error => { feedback.textContent = String(error); }),
      request("second_thread", { action: "status" }).then(renderSecond).catch(error => { secondFeedback.textContent = String(error); }),
    ]);
    busy = false;
  };
  void refresh();
  setInterval(() => { if (!document.getElementById("view-panel")!.hidden) void refresh(); }, 5000);
}
