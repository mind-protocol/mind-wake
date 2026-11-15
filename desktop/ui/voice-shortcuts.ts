type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "repeat" | "isComposing" | "defaultPrevented" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target"> & {
  composedPath?(): EventTarget[];
};

/** The desktop's voice player only; typing and other controls keep their keys. */
export function voiceShortcutAction(event: ShortcutEvent, audio: EventTarget): "toggle" | "skip" | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const action = event.code === "Space" || event.key === " " ? "toggle" : event.key === "Enter" ? "skip" : null;
  if (!action) return null;
  const protectedSelector = 'input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"],[role="combobox"],[role="button"],audio,video';
  for (const target of event.composedPath?.() ?? [event.target]) {
    if (!target || target === audio) continue;
    const element = target as { closest?: (selector: string) => Element | null; parentElement?: Element | null };
    const protectedElement = element.closest?.(protectedSelector) ?? element.parentElement?.closest(protectedSelector);
    if (protectedElement && protectedElement !== audio) return null;
  }
  return action;
}
