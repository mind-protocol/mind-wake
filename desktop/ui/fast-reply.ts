type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type CliRun = { stdout: string; exitCode: number };
type Envelope = { ok: boolean; data: { enabled: boolean }; error?: { message: string } };

/** Réglage partagé avec le processus de réponse rapide, relu à chaque message. */
export function mountFastReply(invoke: Invoke): void {
  const toggle = document.getElementById("fast-reply-enabled") as HTMLInputElement;
  const state = document.getElementById("fast-reply-state")!;
  let busy = false;
  const render = (enabled: boolean) => {
    toggle.checked = enabled;
    state.textContent = enabled ? "Activée" : "Coupée";
  };
  const call = async (action: "status" | "on" | "off"): Promise<boolean> => {
    const result = await invoke(action === "status" ? "fast_reply_status" : "fast_reply_set", action === "status" ? undefined : { enabled: action === "on" }) as CliRun;
    const envelope = JSON.parse(result.stdout) as Envelope;
    if (result.exitCode !== 0 || envelope.ok !== true) throw Error(envelope.error?.message ?? "Réponse rapide indisponible");
    return envelope.data.enabled;
  };
  toggle.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try { render(await call(toggle.checked ? "on" : "off")); }
    catch (error) { state.textContent = String(error); void call("status").then(render).catch(() => {}); }
    finally { busy = false; toggle.disabled = false; }
  });
  void call("status").then(render).catch(error => { state.textContent = String(error); });
}
