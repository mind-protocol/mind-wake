import { tr } from "./i18n.js";
import { BUMP_PROMPT_PATH, resolveBumpText } from "./chat-presence.js";
import { PointSendIntent, pointBumpText, type PointIntent } from "./point-bump.js";
const api = (
  window as unknown as {
    __TAURI__: {
      core: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
      event: { listen: (name: string, callback: (event: {payload: unknown}) => void) => Promise<unknown> };
    };
  }
).__TAURI__;
function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(tr("Élément absent : {0}", [selector]));
  return found;
}
const form = element("#quick-form") as HTMLFormElement;
const input = element("#message") as HTMLTextAreaElement;
const send = element("#send") as HTMLButtonElement;
const cancel = element("#cancel") as HTMLButtonElement;
const bumpe = element("#bumpe") as HTMLButtonElement;
const talk = element("#talk") as HTMLButtonElement;
const status = element("#status") as HTMLParagraphElement;
const count = element("#message-count");
const intent = new PointSendIntent();
let clickId: number | null = null;
let busy = false;
function updateInput(): void {
  count.textContent = `${input.value.length.toLocaleString()} / 4 000`;
  send.disabled = busy || !input.value.trim();
}
input.addEventListener("input", updateInput);
updateInput();
async function submit(kind: PointIntent["kind"]): Promise<void> {
  if (busy || (kind === "message" && !input.value.trim())) return;
  if (kind === "message" && intent.isUnconfirmed()) { status.textContent = tr("Bumpe précédent non confirmé. Cliquer Bumpe pour vérifier cet envoi avant un nouveau message."); return; }
  if (clickId === null) { status.textContent = tr("Point du clic absent ; refaire un clic droit. Aucun message envoyé."); return; }
  const selectedClickId = clickId;
  busy = true;
  send.disabled = true;
  cancel.disabled = false;
  bumpe.disabled = true;
  talk.disabled = true;
  input.readOnly = true;
  status.textContent = tr("Capture de l’écran et envoi…");
  status.dataset["state"] = "sending";
  try {
      // Resolve only once: a failed capture must retry the same human invitation.
      const text = kind === "bumpe"
        ? intent.current(kind, selectedClickId)?.text ?? pointBumpText(await resolveBumpText(() => api.core.invoke("document_browse", {scope:"agent",relative:BUMP_PROMPT_PATH,read:true})))
        : input.value.trim();
      const pending = intent.prepare(kind, text, selectedClickId, () => `${kind === "bumpe" ? "ui-bumpe-" : ""}${crypto.randomUUID()}`);
      // Sending dismisses the form; an uncertain result keeps the draft for
      // the next opening instead of bringing the menu back over the screen.
      await api.core.invoke("quick_input_close");
      await api.core.invoke("quick_input_send", {idempotencyKey:pending.key,text:pending.text,clickId:pending.clickId});
      if (kind === "message") input.value = "";
      intent.complete();
      status.textContent = tr("Message et capture enregistrés.");
  } catch (error: unknown) {
      const detail = String(error);
      if (kind === "bumpe" && detail.includes("POINT_REFRESH_REQUIRED:")) {
        intent.complete(); clickId = null;
      } else if (kind === "bumpe") intent.unconfirmed();
      status.textContent = detail.replace("POINT_REFRESH_REQUIRED: ", "");
      status.dataset["state"] = "error";
  } finally {
      busy = false;
      updateInput();
      cancel.disabled = false;
      bumpe.disabled = clickId === null;
      talk.disabled = false;
      input.readOnly = false;
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("message");
});
bumpe.addEventListener("click", () => void submit("bumpe"));
talk.addEventListener("click", () => input.focus());
document.addEventListener("keydown", (event) => {
  if (event.target === input && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) form.requestSubmit();
  }
});
void api.event.listen("quick-opened", ({payload}) => {
  const target = payload as {id?: unknown; x?: unknown; y?: unknown} | null;
  clickId = typeof target?.id === "number" && Number.isSafeInteger(target.id) && target.id > 0 ? target.id : null;
  bumpe.disabled = busy || clickId === null;
  status.dataset["state"] = clickId === null ? "error" : "ready";
  status.textContent = clickId === null ? tr("Point du clic absent ; refaire un clic droit.") : tr("Entrée : envoyer · Maj+Entrée : nouvelle ligne · Échap : fermer");
  updateInput();
});
