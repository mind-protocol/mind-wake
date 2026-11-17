import { tr } from "./i18n.js";
/** Conversation text split into prose and monospace blocks (ASCII captures, fenced code). */
export interface MessageSegment { readonly kind: "text" | "ascii"; readonly text: string }

// Box drawing, block elements, braille: the alphabet of desktop_ascii / desktop_observe grids.
const ART = /[─-▟⠀-⣿]/gu;
/** A grid line: Unicode art, a long ruler of punctuation, or columns aligned with wide gaps. */
export function isAsciiLine(line: string): boolean {
  if ((line.match(ART)?.length ?? 0) >= 2) return true;
  if (/[-=_|+#*~.:]{6,}/.test(line)) return true;
  return line.trimEnd().length >= 30 && /\S {4,}\S/.test(line);
}

/** Fenced blocks are always monospace; unfenced runs need 3+ consecutive grid lines. */
export function messageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n"), out: MessageSegment[] = [];
  let prose: string[] = [];
  const flush = (): void => { if (prose.join("").trim()) out.push({kind: "text", text: prose.join("\n").replace(/^\n+|\n+$/g, "")}); prose = []; };
  for (let i = 0; i < lines.length;) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(lines[i]!);
    if (fence) {
      const close = lines.findIndex((l, n) => n > i && l.trim().startsWith(fence[1]!));
      const end = close < 0 ? lines.length : close;
      flush(); out.push({kind: "ascii", text: lines.slice(i + 1, end).join("\n")});
      i = end + 1; continue;
    }
    let j = i;
    while (j < lines.length && isAsciiLine(lines[j]!) && !/^[ \t]*(`{3,}|~{3,})/.test(lines[j]!)) j++;
    if (j - i >= 3) { flush(); out.push({kind: "ascii", text: lines.slice(i, j).join("\n")}); i = j; continue; }
    prose.push(lines[i]!); i++;
  }
  flush();
  return out;
}

export function hasAsciiBlock(text: string): boolean { return messageSegments(text).some(s => s.kind === "ascii"); }

/** Full-size viewer shared by images and ASCII: closes on any click or Escape. */
export function openLightbox(content: HTMLElement, label: string, trigger?: HTMLElement): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "message-lightbox";
  dialog.setAttribute("aria-label", label);
  dialog.append(content);
  // A drag-select inside ASCII must not close; a plain click anywhere does.
  dialog.addEventListener("click", () => { if (!String(globalThis.getSelection?.() ?? "")) dialog.close(); });
  dialog.addEventListener("close", () => { dialog.remove(); if (trigger?.isConnected) trigger.focus({preventScroll: true}); });
  document.body.append(dialog); dialog.showModal();
  return dialog;
}

export function openAsciiLightbox(text: string, trigger?: HTMLElement): HTMLDialogElement {
  const pre = document.createElement("pre");
  pre.className = "message-lightbox-ascii"; pre.textContent = text;
  return openLightbox(pre, tr("Capture ASCII agrandie"), trigger);
}

/** Inline block: readable size, no wrapping, horizontal scroll; click opens it large. */
export function asciiBlock(text: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "message-ascii"; pre.textContent = text;
  pre.tabIndex = 0; pre.title = tr("Cliquer pour agrandir");
  pre.addEventListener("click", () => { if (!String(globalThis.getSelection?.() ?? "")) openAsciiLightbox(text, pre); });
  pre.addEventListener("keydown", event => { if (event.key === "Enter") openAsciiLightbox(text, pre); });
  return pre;
}
