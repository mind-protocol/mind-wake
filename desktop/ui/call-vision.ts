type Change = {row:number; column:number; text?:string; clear?:number};
export interface CallFrame {
  id:number; at:number; author:string; target:string; jpeg?:string; grid_text?:string;
  changed?:boolean; changes?:Change[]; row?:number; column?:number;
}

function card(frame: CallFrame) {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = [frame.author,frame.target,new Date(frame.at).toLocaleTimeString()].join(" · ");
  figure.append(caption);
  if (frame.jpeg) {
    const image = document.createElement("img");
    image.alt = "Capture de " + frame.target;
    image.src = "data:image/jpeg;base64," + frame.jpeg;
    figure.append(image);
  }
  const ascii = frame.changes?.map(c => {
    const position = "L" + c.row + " C" + c.column;
    return position + "  " + (c.text ?? ("Effacé · " + c.clear + " cellules"));
  }).join("\n") || frame.grid_text;
  if (ascii) {
    const pre = document.createElement("pre");
    pre.textContent = ascii;
    if (frame.jpeg && !frame.changes && frame.changed !== true) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Grille ASCII";
      details.append(summary,pre);
      figure.append(details);
    } else figure.append(pre);
  } else if (frame.changed === false) {
    const note = document.createElement("p");
    note.textContent = "Aucun changement.";
    figure.append(note);
  }
  return figure;
}

export function callVisionFeed(panel: HTMLElement, read: (call:string, after:number)=>Promise<CallFrame[]>) {
  let current = "", generation = 0, timer: number | undefined;
  return (call: string) => {
    if (current === call) return;
    current = call;
    const version = ++generation;
    window.clearTimeout(timer);
    panel.replaceChildren();
    panel.hidden = true;
    if (!call) return;
    let cursor = 0;
    async function poll() {
      let delay = 1000;
      try {
        const frames = await read(call,cursor);
        if (version !== generation) return;
        for (const frame of frames) {
          if (frame.id <= cursor) continue;
          panel.prepend(card(frame));
          cursor = frame.id;
        }
        while (panel.children.length > 24) panel.lastElementChild!.remove();
        panel.hidden = !panel.children.length;
        if (frames.length === 3) delay = 0;
      } catch (error) {
        console.warn("Captures de l’appel", error);
        delay = 2500;
      } finally {
        if (version === generation) timer = window.setTimeout(poll,delay);
      }
    }
    void poll();
  };
}
