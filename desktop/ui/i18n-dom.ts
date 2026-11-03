import { getLanguage, setLanguage, tr, LANGUAGE_KEY } from "./i18n.js";

/** Only app-authored marked nodes are translated. Documents, messages and inputs are untouched. */
export function translateDocument(root: Document): void {
  root.documentElement.lang = getLanguage();
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (key === undefined) continue;
    // Preserve inline icons and their event listeners.
    const text = Array.from(element.childNodes).find(node => node.nodeType === 3 && node.textContent?.trim());
    if (text) {
      const original = text.textContent ?? "";
      text.textContent = original.replace(original.trim(), () => tr(key));
    }
  }
  for (const attribute of ["title", "placeholder", "aria-label"]) {
    for (const element of root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, tr(element.getAttribute(`data-i18n-${attribute}`) ?? ""));
    }
  }
}

translateDocument(document);
const native = (window as unknown as { __TAURI__?: { event?: { emit: (event: string, payload: string) => Promise<void> } } }).__TAURI__;
void native?.event?.emit("mind-wake-language", getLanguage()).catch(() => {});
const selector = document.querySelector<HTMLSelectElement>("#app-language");
if (selector) {
  selector.value = getLanguage();
  selector.addEventListener("change", () => {
    if (selector.value !== "en" && selector.value !== "fr") return;
    try { setLanguage(selector.value); location.reload(); }
    catch { selector.value = getLanguage(); }
  });
}
// The quick-input window shares the same origin and follows the main window.
window.addEventListener("storage", event => {
  if (event.key !== LANGUAGE_KEY) return;
  if (selector) location.reload();
  else translateDocument(document);
});
