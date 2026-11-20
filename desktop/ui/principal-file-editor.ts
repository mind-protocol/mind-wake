export type PrincipalFileInvoke = (request: Record<string, unknown>) => Promise<{text: string; revision: string; [key: string]: unknown}>;
export interface InlineMessage { source: string; id: string; text: string; revision: string }

/** Replace just this bubble's Markdown, preserving the rest of its source file. */
export function replaceConversationText(file: string, before: string, after: string): string {
  const normalized = file.replace(/\r\n/g, "\n"), needle = before.replace(/\r\n/g, "\n");
  const index = normalized.indexOf(needle);
  // Distinct messages: a stale view and a duplicated passage call for different fixes.
  if (!needle || index < 0) throw Error("Ce passage a changé dans le fichier depuis son affichage. Ton brouillon est conservé.");
  if (normalized.indexOf(needle, index + 1) >= 0) throw Error("Ce passage apparaît plusieurs fois dans le fichier : modification refusée pour ne pas toucher le mauvais. Ton brouillon est conservé.");
  const result = normalized.slice(0, index) + after.replace(/\r\n/g, "\n") + normalized.slice(index + needle.length);
  return file.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}

/** Save request: the runtime rewrites only this message's lines (`editPrincipalMessage`). */
export function inlineSaveRequest(message: InlineMessage, draft: string): Record<string, unknown> {
  return {action: "principalMessageSave", source: message.source, id: message.id, revision: message.revision, text: draft.replace(/\r\n/g, "\n").trim()};
}

/**
 * Inline editing inside the bubble: focusing the message shows its Markdown in place; Enregistrer
 * (or Ctrl+Entrée) saves, Annuler (or Échap) restores. On a conflict the draft stays in the bubble.
 */
export function inlinePrincipalEditor(node: HTMLElement, bubble: HTMLElement, message: InlineMessage, invoke: PrincipalFileInvoke, saved: () => void): void {
  const controls = document.createElement("div"), save = document.createElement("button"), cancel = document.createElement("button"), status = document.createElement("span");
  controls.className = "principal-inline-controls"; controls.hidden = true;
  save.type = "button"; cancel.type = "button";
  save.textContent = "Enregistrer"; cancel.textContent = "Annuler"; status.setAttribute("role", "status");
  controls.append(save, cancel, status); bubble.append(controls);
  node.contentEditable = "plaintext-only";
  node.tabIndex = 0;
  node.setAttribute("role", "textbox"); node.setAttribute("aria-multiline", "true");
  node.setAttribute("aria-label", "Modifier ce message en Markdown");
  node.title = "Cliquer pour modifier ce message";
  node.classList.add("principal-inline-editor");
  let active = false;
  node.addEventListener("focus", () => {
    if (bubble.dataset["voiceEditing"] === "true") { node.blur(); return; }
    if (active) return;
    active = true; bubble.dataset["inlineEditing"] = "true";
    node.textContent = message.text; node.classList.add("editing-markdown"); controls.hidden = false; status.textContent = "";
  });
  const close = () => {active = false; bubble.dataset["inlineEditing"] = "false"; saved();};
  cancel.onclick = close;
  const submit = async (): Promise<void> => {
    const draft = node.innerText;
    if (!draft.trim()) { status.textContent = "Le message ne peut pas être vide."; return; }
    if (draft.replace(/\r\n/g, "\n").trim() === message.text.trim()) { close(); return; }
    save.disabled = true; cancel.disabled = true; node.contentEditable = "false"; status.textContent = "Enregistrement…";
    try {
      await invoke(inlineSaveRequest(message, draft));
      close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      node.contentEditable = "plaintext-only";
    } finally { save.disabled = false; cancel.disabled = false; }
  };
  save.onclick = () => void submit();
  node.addEventListener("keydown", event => {
    if (!active) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
  });
}

export async function openPrincipalFile(source: string, invoke: PrincipalFileInvoke, saved: () => void): Promise<void> {
  const dialog = document.createElement("dialog");
  dialog.className = "principal-file-editor";
  const title = document.createElement("h2"), field = document.createElement("textarea"), status = document.createElement("p");
  title.textContent = source.split("/").at(-1) ?? source;
  title.id = "principal-file-title";
  dialog.setAttribute("aria-labelledby", title.id);
  field.setAttribute("aria-label", "Contenu Markdown du fichier");
  field.spellcheck = false;
  const actions = document.createElement("div"), save = document.createElement("button"), close = document.createElement("button");
  save.textContent = "Enregistrer"; close.textContent = "Fermer";
  save.disabled = true; field.disabled = true;
  status.setAttribute("role", "status"); status.textContent = "Chargement…";
  actions.append(save, close); dialog.append(title, field, status, actions); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  close.onclick = () => dialog.close();
  dialog.showModal();
  let revision = "";
  try {
    const result = await invoke({action: "principalRead", source});
    field.value = result.text; revision = result.revision; field.disabled = false; save.disabled = false;
    status.textContent = "Markdown · les changements seront visibles dans le fil après enregistrement.";
  } catch (error) { status.textContent = String(error); }
  save.onclick = async () => {
    save.disabled = true; field.disabled = true;
    try {
      const result = await invoke({action: "principalSave", source, text: field.value, revision});
      revision = result.revision; status.textContent = "Fichier enregistré."; saved();
    } catch (error) { status.textContent = String(error); }
    finally { save.disabled = false; field.disabled = false; }
  };
}

export function deleteRequest(message: InlineMessage): Record<string, unknown> {
  return {action: "principalMessageDelete", source: message.source, id: message.id, revision: message.revision};
}

/** × button: a first click arms it for 4 s (« Supprimer ? »), the second sends `request` (corpus deletion or dismissal of a pending message). */
export function principalDeleteButton(bubble: HTMLElement, request: Record<string, unknown>, invoke: PrincipalFileInvoke, deleted: () => void): HTMLButtonElement {
  const button = document.createElement("button"), status = document.createElement("span");
  button.type = "button"; button.className = "principal-delete"; button.textContent = "×";
  button.setAttribute("aria-label", "Supprimer ce message du fil"); button.title = "Supprimer ce message du fil";
  status.className = "principal-delete-status"; status.setAttribute("role", "status");
  let armed: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => { clearTimeout(armed); armed = undefined; button.textContent = "×"; button.dataset["armed"] = "false"; };
  button.onclick = async event => {
    event.stopPropagation();
    if (armed === undefined) {
      button.textContent = "Supprimer ?"; button.dataset["armed"] = "true";
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm(); button.disabled = true;
    try { await invoke(request); bubble.hidden = true; deleted(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); bubble.append(status); }
    finally { button.disabled = false; }
  };
  return button;
}

export function principalEditorHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  return ((hash % 360) + 360) % 360;
}
