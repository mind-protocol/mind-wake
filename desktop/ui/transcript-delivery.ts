/** Show text immediately; the same recording ID is used for persistence and reconciliation. */
export async function deliverTranscript<B>(
  text: string,
  images: string[],
  requestId: string,
  options: {
    show(key: string, text: string): B;
    attachments(images: string[]): Promise<string>;
    update(bubble: B, text: string): void;
    send(key: string, text: string, bubble: B): Promise<void>;
    cancelled(): boolean;
    warning(note: string): void;
  },
): Promise<void> {
  const transcript = text.trim();
  if (!transcript || options.cancelled()) return;
  const key = `ui-voice-${requestId}`,
    first = options.show(key, `[Dictée vocale]\n${transcript}`);
  let suffix = "";
  try {
    suffix = await options.attachments(images);
  } catch {
    options.warning(
      "Pièces jointes indisponibles ; transcript conservé et envoyé seul.",
    );
  }
  if (options.cancelled()) return;
  const size = 4000 - suffix.length - 20;
  if (size < 1)
    throw Error("Pièces jointes trop longues ; transcript conservé à l’écran.");
  for (let index = 0; index < transcript.length; index += size) {
    if (options.cancelled()) return;
    const id = index === 0 ? key : `${key}-${index}`,
      body = `[Dictée vocale]\n${transcript.slice(index, index + size)}${suffix}`;
    const bubble = index === 0 ? first : options.show(id, body);
    options.update(bubble, body);
    await options.send(id, body, bubble);
  }
}
