import { tr } from "./i18n.js";

const ICON = "⧉";

/** Petit bouton « copier » (NLR, 15 nov. 2026) : copie le texte courant et confirme brièvement. */
export function copyButton(text: () => string, label = tr("Copier le message")): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = ICON;
  button.title = label;
  button.setAttribute("aria-label", label);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (mark: string, note: string) => {
    button.textContent = mark;
    button.title = note;
    button.dataset["copied"] = "true";
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = ICON;
      button.title = label;
      delete button.dataset["copied"];
    }, 1500);
  };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(text()).then(
      () => { show("✓", tr("Copié")); },
      () => { show("!", tr("Copie impossible")); },
    );
  });
  return button;
}

/** Zone de saisie et son bouton « copier » posé dans le coin, sans changer sa hauteur. */
export function composeField(input: HTMLTextAreaElement): HTMLDivElement {
  const field = document.createElement("div");
  field.className = "compose-field";
  const button = copyButton(() => input.value, tr("Copier le brouillon"));
  button.className = "copy-button compose-copy";
  field.append(input, button);
  return field;
}

/** Même bouton pour une zone de saisie déjà présente dans la page. */
export function attachComposeCopy(input: HTMLTextAreaElement): void {
  const anchor = document.createComment("compose");
  input.before(anchor);
  anchor.replaceWith(composeField(input));
}
