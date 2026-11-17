/**
 * Captures partagées pendant un appel (NLR, 17 nov. 2026, 16:18) : le desktop les relaie à l'iframe
 * d'appel (`mind.call.frames`) et elles s'affichent dans la transcription, à leur place dans le fil.
 */
export type CallCapture = { image?: string; ascii?: string; caption: string };
type Change = { row: number; column: number; text?: string; clear?: number };
export type CallFrame = { id: number; at: number; author: string; target: string; jpeg?: string; grid_text?: string;
  changed?: boolean; changes?: Change[] };
export type CaptureLine = { key: string; who: 'them'; text: string; detail: string; speaker?: string; capture: CallCapture };

const time = (at: number) => { try { return new Date(at).toLocaleTimeString(); } catch { return ''; } };
/** Message du desktop → lignes de transcription ; ignoré s'il ne vise pas l'appel en cours. */
export function captureLines(message: unknown, callId: string | null | undefined): CaptureLine[] {
  const data = message as { type?: unknown; id?: unknown; frames?: unknown } | null;
  if (!data || data.type !== 'mind.call.frames' || !callId || data.id !== callId || !Array.isArray(data.frames)) return [];
  const out: CaptureLine[] = [];
  for (const frame of data.frames as CallFrame[]) {
    if (!frame || !Number.isInteger(frame.id)) continue;
    const image = typeof frame.jpeg === 'string' && /^[A-Za-z0-9+/=]+$/.test(frame.jpeg) ? `data:image/jpeg;base64,${frame.jpeg}` : undefined;
    const ascii = (Array.isArray(frame.changes) && frame.changes.length
      ? frame.changes.map(c => `L${c.row} C${c.column}  ${c.text ?? `Effacé · ${c.clear} cellules`}`).join('\n')
      : typeof frame.grid_text === 'string' ? frame.grid_text : '') || undefined;
    if (!image && !ascii) continue;
    const author = typeof frame.author === 'string' ? frame.author : '';
    out.push({ key: `capture-${frame.id}`, who: 'them', text: '', detail: '', speaker: author || undefined,
      capture: { image, ascii, caption: ['Capture', frame.target, time(frame.at)].filter(Boolean).join(' · ') } });
  }
  return out;
}
