type Change = {row:number; column:number; text?:string; clear?:number};
export interface CallFrame {
  id:number; at:number; author:string; target:string; jpeg?:string; grid_text?:string;
  changed?:boolean; changes?:Change[]; row?:number; column?:number;
}
/** Posted to the call iframe; it renders the frames inline in its transcript and de-duplicates by frame id. */
export interface CallFramesMessage { type:"mind.call.frames"; id:string; frames:CallFrame[] }

/**
 * NLR (17 Nov 2026): call captures appear inline in the call transcript (lumina-prime iframe), not in a side panel.
 * Polling, cursor and generation are unchanged; each new batch (ascending id, objects untouched) is forwarded.
 * The legacy #call-vision-feed panel stays in the DOM but hidden.
 */
export function callVisionFeed(panel: HTMLElement, read: (call:string, after:number)=>Promise<CallFrame[]>, forward: (message:CallFramesMessage)=>void) {
  let current = "", generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  panel.replaceChildren();
  panel.hidden = true;
  return (call: string) => {
    if (current === call) return;
    current = call;
    const version = ++generation;
    clearTimeout(timer);
    panel.replaceChildren();
    panel.hidden = true;
    if (!call) return;
    let cursor = 0;
    async function poll() {
      let delay = 1000;
      try {
        const frames = await read(call,cursor);
        if (version !== generation) return;
        const fresh = frames.filter(frame => frame.id > cursor).sort((a,b) => a.id - b.id);
        if (fresh.length) {
          cursor = fresh[fresh.length - 1]!.id;
          forward({type:"mind.call.frames", id:call, frames:fresh});
        }
        if (frames.length === 3) delay = 0;
      } catch (error) {
        console.warn("Captures de l’appel", error);
        delay = 2500;
      } finally {
        if (version === generation) timer = setTimeout(poll,delay);
      }
    }
    void poll();
  };
}
