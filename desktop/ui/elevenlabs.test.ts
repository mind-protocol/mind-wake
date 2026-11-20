import { afterEach, expect, it, vi } from "vitest";
import { initElevenLabs } from "./elevenlabs.js";

afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

function desktop(blockAutoplay = false, holdStarted = false, initial?: {id:string;text:string;voiceId:string;autoplay:boolean}[], claimedElsewhere: string[] = []) {
  let now=100000;vi.spyOn(Date,"now").mockImplementation(()=>now);
  class Element {
    value = "";
    checked = false;
    hidden = true;
    disabled = false;
    textContent = "";
    src = "";
    ended = false;
    paused = true;
    listeners = new Map<string, () => void>();
    addEventListener(name: string, handler: () => void) {
      this.listeners.set(name, handler);
    }
    querySelectorAll() {
      return [];
    }
    replaceChildren() {}
    removeAttribute() {
      this.src = "";
    }
    pause = vi.fn(() => { this.paused = true; });
    load = vi.fn();
    play = vi.fn(() => {
      if (blockAutoplay) return Promise.reject(Error("NotAllowedError"));
      this.ended = false;
      this.paused = false;
      this.listeners.get("play")?.();
      this.listeners.get("playing")?.();
      return Promise.resolve();
    });
  }
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const element = new Element();
    nodes.set(id, element);
    return element;
  };
  let interval: (() => Promise<void>) | undefined;
  let allowed = true;
  let holdAudio = false;
  let resumeAudio: (() => void) | undefined;
  let releaseStarted: (() => void) | undefined;
  let pending = initial ?? [{ id: "clip-1", text: "Bonjour", voiceId: "fr", autoplay: true }];
  let keydown: ((event: KeyboardEvent) => void) | undefined;
  vi.stubGlobal("document", { getElementById: (id: string) => get(id.replace("elevenlabs-", "")) });
  vi.stubGlobal("window", {
    addEventListener:vi.fn((name: string, handler: (event: KeyboardEvent) => void) => { if (name === "keydown") keydown = handler; }),
    setInterval: (fn: () => Promise<void>) => {
      interval = fn;
    },
  });
  vi.stubGlobal(
    "Option",
    class {
      constructor(
        public text: string,
        public value: string,
      ) {}
    },
  );
  const revoked = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:audio", revokeObjectURL: revoked });
  const invoke = vi.fn((_command: string, args?: Record<string, unknown>) => {
    let data: unknown;
    switch (args?.["action"]) {
      case "status":
        data = { enabled: true, autoplay: true, voiceId: "fr", hasKey: true };
        break;
      case "configure":
        data = { ...(args["payload"] as object), hasKey: true };
        break;
      case "pending":
        data = { allowed, clips: pending };
        break;
      case "audio":
        data = { base64: "SUQzAA==" };
        if (holdAudio) {
          holdAudio = false;
          return new Promise<{ exitCode: number; stdout: string }>((resolve) => {
            resumeAudio = () => {
              resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }) });
            };
          });
        }
        break;
      case "claim": data = {claimed:!claimedElsewhere.includes(args["payload"] as string)}; break;
      case "event": {
        const payload=args?.['payload'] as {id:string;phase:string};
        if(payload.phase==='started') {
          // The real service acknowledges inside event(started), before IPC returns.
          pending=pending.filter(item=>item.id!==payload.id);
          if(holdStarted){holdStarted=false;return new Promise<{exitCode:number;stdout:string}>(resolve=>{releaseStarted=()=>resolve({exitCode:0,stdout:JSON.stringify({ok:true,data:{id:payload.id,phase:'started'}})});});}
        }
        data={};break;
      }
      case "ack":
        pending = pending.filter((item) => item.id !== args["payload"]);
        data = {};
        break;
      default:
        throw Error("Unexpected call");
    }
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }) });
  });
  const speaking = vi.fn();
  const player = initElevenLabs(invoke, speaking);
  return {
    get,
    speaking,
    interrupt: () => player.interrupt(),
    advance:(ms:number)=>{now+=ms;},
    invoke,
    revoked,
    releaseStarted: () => releaseStarted?.(),
    press: (key: string, target: EventTarget | null = null) => {
      const preventDefault = vi.fn();
      keydown?.({key, code: key === " " ? "Space" : key, target, preventDefault} as unknown as KeyboardEvent);
      return preventDefault;
    },
    holdNextAudio: () => {
      holdAudio = true;
    },
    releaseAudio: () => {
      resumeAudio?.();
    },
    tick: async () => {
      void interval?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    stop: () => {
      allowed = false;
    },
    add: () => {
      pending.push({ id: "clip-2", text: "Salut", voiceId: "fr", autoplay: true });
    },
    addManual: () => {
      pending.push({id:'clip-2',text:'Manuel',voiceId:'fr',autoplay:false});
    },
  };
}

it("keeps a clip available when autoplay is blocked, acknowledges only actual playback", async () => {
  const ui = desktop(true);
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  expect(ui.get("player").hidden).toBe(false);
  expect(ui.get("playing").textContent).toContain("Appuyer sur lecture");
  expect(ui.invoke.mock.calls.some((call) => call[1]?.["action"] === "ack")).toBe(false);
  ui.get("audio").listeners.get("playing")?.();
  await vi.waitFor(() => {
    expect(ui.invoke.mock.calls.some((call) => call[1]?.["action"] === "event" && (call[1]?.['payload'] as {phase:string})?.phase==='started')).toBe(true);
  });
});

it("plays clips sequentially, leaves replay available, and stops on Pause/Force-off", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  ui.get("audio").ended = true;
  ui.advance(30_000);
  await ui.tick();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("player").hidden).toBe(false);
  ui.stop();
  await ui.tick();
  await vi.waitFor(() => {
    expect(ui.get("player").hidden).toBe(true);
  });
  expect(ui.get("audio").pause).toHaveBeenCalled();
  expect(ui.revoked).toHaveBeenCalled();
});

it("waits through a manual pause and starts the queued voice only after the ended event", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  ui.get("audio").pause();
  await ui.tick();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  expect(ui.get("playing").textContent).toBe("Bonjour");
  ui.get("audio").ended = true;
  ui.advance(30_000);
  ui.get("audio").listeners.get("ended")?.();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("audio").play).toHaveBeenCalledTimes(2);
});

it("serializes simultaneous polls and lets a replay finish when the next voice is loading", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  ui.holdNextAudio();
  ui.get("audio").ended = true;
  ui.advance(30_000);
  await Promise.all([ui.tick(), ui.tick(), ui.tick()]);
  expect(ui.invoke.mock.calls.filter((call) => call[1]?.["action"] === "audio")).toHaveLength(2);
  await ui.get("audio").play(); // Replay the first clip during the pending read.
  const pauses = ui.get("audio").pause.mock.calls.length;
  ui.releaseAudio();
  await ui.tick();
  expect(ui.get("playing").textContent).toBe("Bonjour");
  expect(ui.get("audio").pause).toHaveBeenCalledTimes(pauses);
  ui.get("audio").ended = true;
  ui.advance(30_000);
  ui.get("audio").listeners.get("ended")?.();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("audio").play).toHaveBeenCalledTimes(3);
});

it('spaces starts while a long or manually paused clip still prevents overlap',async()=>{
 const ui=desktop();await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledOnce());
 ui.add();ui.advance(40_000);await ui.tick();expect(ui.get('audio').play).toHaveBeenCalledOnce();
 ui.get('audio').ended=true;await ui.tick();await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledTimes(2));
});
it('keeps a real silence between short clips instead of speeding up speech',async()=>{
 const ui=desktop();await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledOnce());
 ui.add();ui.advance(5_000);ui.get('audio').ended=true;await ui.tick();expect(ui.get('audio').play).toHaveBeenCalledOnce();
 ui.advance(24_999);await ui.tick();expect(ui.get('audio').play).toHaveBeenCalledOnce();
 ui.advance(1);await ui.tick();await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledTimes(2));
});


it("Space pauses and resumes the actual voice player, Enter skips without replay", async () => {
  const ui = desktop();
  await vi.waitFor(() => expect(ui.get("audio").play).toHaveBeenCalledOnce());
  const pauses = ui.get("audio").pause.mock.calls.length;
  expect(ui.press(" ")).toHaveBeenCalledOnce();
  expect(ui.get("audio").pause).toHaveBeenCalledTimes(pauses + 1);
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce(); // polling preserves the human's pause
  expect(ui.press(" ")).toHaveBeenCalledOnce();
  expect(ui.get("audio").play).toHaveBeenCalledTimes(2);
  ui.add();
  ui.advance(30001);
  expect(ui.press("Enter")).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(ui.get("playing").textContent).toBe("Salut"));
  expect(ui.get("audio").play).toHaveBeenCalledTimes(3);
  const edit = {closest:() => ({tagName:"TEXTAREA"})} as unknown as EventTarget;
  expect(ui.press(" ", edit)).not.toHaveBeenCalled();
  expect(ui.press("Enter", edit)).not.toHaveBeenCalled();
  expect(ui.get("playing").textContent).toBe("Salut");
});

it('keeps actual playback alive while started IPC has acknowledged but not returned', async()=>{
 const ui=desktop(false,true);
 await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledOnce());
 const pauses=ui.get('audio').pause.mock.calls.length;
 await ui.tick();await ui.tick();
 expect(ui.get('audio').pause).toHaveBeenCalledTimes(pauses);
 expect(ui.get('player').hidden).toBe(false);
 expect(ui.get('playing').textContent).toBe('Bonjour');
 ui.releaseStarted();await ui.tick();
 expect(ui.get('player').hidden).toBe(false);
});

it('never acknowledges the next unplayed clip when an old started IPC completes late', async()=>{
 const ui=desktop(false,true);
 await vi.waitFor(()=>expect(ui.get('audio').play).toHaveBeenCalledOnce());
 ui.addManual();ui.advance(30001);ui.press('Enter');
 await vi.waitFor(()=>expect(ui.get('playing').textContent).toBe('Manuel'));
 ui.releaseStarted();await ui.tick();await ui.tick();
 expect(ui.invoke.mock.calls.filter(c=>c[1]?.['action']==='ack'&&c[1]?.['payload']==='clip-2')).toHaveLength(0);
 expect(ui.get('player').hidden).toBe(false);
 expect(ui.get('audio').play).toHaveBeenCalledOnce();
});

it("skips a clip claimed elsewhere instead of blocking the voices behind it", async () => {
  const clip = (id: string) => ({ id, text: id, voiceId: "fr", autoplay: true });
  const ui = desktop(false, false, [clip("orphan"), clip("next")], ["orphan"]);
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  expect(ui.get("playing").textContent).toBe("next");
});

it("barge-in stops the voice at once, cancels it and drops the clips already queued", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  expect(ui.interrupt()).toBe(true);
  expect(ui.get("audio").pause).toHaveBeenCalled();
  expect(ui.speaking).toHaveBeenLastCalledWith(false);
  expect(ui.get("player").hidden).toBe(true);
  const calls = (action: string) => ui.invoke.mock.calls.filter((call) => call[1]?.["action"] === action).map((call) => call[1]?.["payload"]);
  await vi.waitFor(() => {
    expect(calls("ack")).toEqual(["clip-1", "clip-2"]);
  });
  expect(calls("event")).toEqual(expect.arrayContaining([{ id: "clip-1", phase: "cancelled" }, { id: "clip-2", phase: "cancelled" }]));
  // The dropped clip does not start on the next polls.
  ui.advance(30_000);
  await ui.tick();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  // Nothing is playing any more: a second detection is a no-op.
  expect(ui.interrupt()).toBe(false);
});

it("barge-in is a no-op when the voice is paused or finished", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.get("audio").pause();
  expect(ui.interrupt()).toBe(false);
  ui.get("audio").paused = false;
  ui.get("audio").ended = true;
  expect(ui.interrupt()).toBe(false);
  expect(ui.invoke.mock.calls.some((call) => call[1]?.["action"] === "ack")).toBe(false);
});

it("a clip still loading when the human interrupts is not played", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.get("audio").ended = true;
  ui.add();
  ui.advance(30_000);
  ui.holdNextAudio();
  await ui.tick();
  // Poll is loading clip-2; the previous voice is replayed and the human speaks over it.
  ui.get("audio").ended = false;
  ui.get("audio").paused = false;
  expect(ui.interrupt()).toBe(true);
  ui.releaseAudio();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  expect(ui.get("player").hidden).toBe(true);
});

it("saves STT consent independently of voice generation", async () => {
  const ui = desktop(false, false, []);
  await ui.tick();
  expect(ui.get("transcription").checked).toBe(false);
  ui.get("enabled").checked = false;
  ui.get("transcription").checked = true;
  ui.get("voice").value = "";
  const submit = ui.get("form").listeners.get("submit");
  if (!submit) throw Error("Missing settings handler");
  Reflect.apply(submit, null, [{ preventDefault: vi.fn() }]);
  await vi.waitFor(() => expect(ui.get("feedback").textContent).toBe("Réglages enregistrés."));
  expect(ui.invoke).toHaveBeenCalledWith("elevenlabs", {
    action: "configure",
    payload: { enabled: false, transcriptionEnabled: true, autoplay: true, voiceId: "", apiKey: "" },
  });
});
